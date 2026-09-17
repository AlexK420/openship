import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
const provider = vi.hoisted(() => ({
  cloudMode: true, enabled: true, topups: true,
  checkout: vi.fn(), catalog: vi.fn(), entitlement: vi.fn(), namespaces: vi.fn(),
  portal: vi.fn(), subscription: vi.fn(), cancel: vi.fn(), resume: vi.fn(), subscriptions: new Map<string, OblienSubscription>(),
  cloudRequest: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async original => {
  const actual = await original<{ env: Record<string, unknown> }>();
  return { ...actual, env: { ...actual.env, get CLOUD_MODE() { return provider.cloudMode; }, get BILLING_ENABLED() { return provider.enabled; }, get BILLING_TOPUPS_ENABLED() { return provider.topups; } } };
});
vi.mock("@repo/platform/engine/lib/stripe-client", () => ({ stripe: () => { throw new Error("Direct Stripe billing is retired"); } }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({
    getCatalog: provider.catalog, getEntitlement: provider.entitlement, createCheckout: provider.checkout,
    createPortal: provider.portal, getSubscription: provider.subscription, cancelSubscription: provider.cancel, resumeSubscription: provider.resume,
    getDefaults: async () => ({ success: true, autoApply: true, service: "workspace_vm", quotaLimit: 100, overdraft: 0, onOverdraftAction: "stop_workspaces", suspendThreshold: 0 }),
  }),
  getOblienClient: () => ({ namespaces: { ensure: provider.namespaces } }),
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: () => ({ request: provider.cloudRequest }) }));
import { db, schema, repos, seedOwner, type SeededOwner } from "../jobs/_harness";
import { AppError, CREDIT_PACKS, FREE_DOMAIN_SUFFIX } from "@repo/core";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { billingPlansRoutes, billingSaasRoutes } from "../../../src/modules/billing/billing.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import * as repository from "@repo/platform/engine/modules/billing/billing.repository";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { eq } from "@repo/db";

const app = new Hono().onError(handleApiError)
  .use("*", async (c, next) => { c.set("clientIp", "192.0.2.64"); await next(); })
  .route("/api/health", healthRoutes).route("/api/billing", billingPlansRoutes).route("/api/billing", billingSaasRoutes);
const fetcher = ((url, init) => app.request(url as string, init)) as typeof fetch;
async function clients(actor: SeededOwner, organizationId = actor.orgId, limits: Partial<VerifiedIdentity> = {}) {
  const user = (await repos.user.findById(actor.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user, sessionId: "billing", ...limits }) } });
  return {
    native: (await ship.scope({ identity: "verified", organizationId })).billing,
    remote: new OpenshipClient({ baseUrl: "http://openship.test", token: actor.token, organizationId, fetch: fetcher }).billing,
  };
}
beforeEach(() => {
  provider.cloudMode = provider.enabled = provider.topups = true;
  provider.subscriptions.clear();
  provider.namespaces.mockImplementation(async ({ slug }) => ({ data: { slug } }));
  provider.checkout.mockResolvedValue({ success: true, url: "https://checkout.stripe.com/private-session", checkoutId: "cs_test" });
  provider.entitlement.mockImplementation(async (namespace) => ({
    success: true, namespace, tierId: provider.subscriptions.get(namespace)?.tierId ?? null, status: "active",
    periodStart: provider.subscriptions.get(namespace)?.periodStart ?? null, periodEnd: provider.subscriptions.get(namespace)?.periodEnd ?? null,
    quota: { limit: 100, used: 0, balance: 100 },
  }));
  provider.portal.mockImplementation(async ({ namespace }) => ({ success: true, namespace, url: `https://billing.stripe.com/p/session/private-${namespace}` }));
  provider.subscription.mockImplementation(async namespace => ({ success: true, namespace, subscription: provider.subscriptions.get(namespace) ?? null }));
  for (const [method, cancelAtPeriodEnd] of [[provider.cancel, true], [provider.resume, false]] as const) {
    method.mockImplementation(async namespace => {
      const old = provider.subscriptions.get(namespace);
      if (!old) throw new AppError("No subscription", 404, "OBLIEN_BILLING_ERROR");
      const subscription = { ...old, cancelAtPeriodEnd };
      provider.subscriptions.set(namespace, subscription);
      return { success: true, namespace, subscription };
    });
  }
  provider.catalog.mockResolvedValue({
    success: true,
    plans: [
      { tierId: "hobby", name: "Hobby", priceMonthly: 10, priceYearly: 100, currency: "usd", creditsPerCycle: 1200, yearlyCreditsPerCycle: 14400, features: [] },
      { tierId: "pro", name: "Pro", priceMonthly: 29, priceYearly: 290, currency: "usd", creditsPerCycle: 3000, yearlyCreditsPerCycle: 36000, features: [] },
    ],
    creditPacks: [{ packId: "starter", name: "Starter", credits: 1000, price: 10, currency: "usd" }],
  });
});
afterEach(async () => { await flushAudit(); vi.clearAllMocks(); vi.unstubAllEnvs(); await db.delete(schema.creditPack); });

describe("billing through the same SDK and HTTP application operations", () => {
  it("keeps localized plan discovery public and preserves monetary units and catalog secrecy", async () => {
    const c = await clients(await seedOwner());
    const remote = new OpenshipClient({ baseUrl: "http://openship.test", fetch: fetcher });
    const native = await c.native.listPlans({ locale: "ar" });
    expect(await remote.billing.listPlans({ locale: "ar" })).toEqual(native);
    expect(native.locale).toBe("ar");
    expect(native.plans.find(plan => plan.id === "starter")?.price.monthly).toBe(1000);
    expect(JSON.stringify(native)).not.toMatch(/stripeCouponEnv|oblienLimits|STRIPE_PRICE/);
    const response = await app.request("/api/billing/plans", { headers: { "Accept-Language": "de" } });
    expect(response.headers.get("Vary")).toBe("Accept-Language");
    expect((await response.json()).data.locale).toBe("de");
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("uses the selected tenant for provider state and checkout without auditing session URLs", async () => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner);
    await db.update(schema.organization).set({ planTierId: "team" }).where(eq(schema.organization.id, other.orgId));
    expect(await c.native.getState()).toEqual(await c.remote.getState());
    expect((await c.native.getState()).tier).toBe("free");
    for (const client of [c.native, c.remote]) {
      expect(await client.createSubscription({ planTierId: "starter", interval: "monthly" })).toEqual({ checkoutUrl: "https://checkout.stripe.com/private-session" });
    }
    const org = await repos.organization.findById(owner.orgId);
    expect(org?.oblienNamespace).toBeTruthy();
    for (const [input] of provider.checkout.mock.calls) {
      expect(input).toMatchObject({ namespace: org!.oblienNamespace, kind: "subscription", planTierId: "hobby", billingInterval: "monthly" });
      expect(input).not.toHaveProperty("customer");
      expect(input).not.toHaveProperty("line_items");
    }
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, owner.orgId));
    expect(events.filter(row => row.eventType === "billing:write")).toHaveLength(2);
    expect(events.every(row => row.actorUserId === owner.userId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-session");
  });

  it("requires legacy subscriptions to be migrated before new purchases or billing management", async () => {
    const owner = await seedOwner(), c = await clients(owner), now = new Date("2026-01-01"), end = new Date("2026-02-01");
    for (const id of ["first", "second"]) await repository.upsertSubscription({ organizationId: owner.orgId, stripeSubscriptionId: `${owner.userId}-${id}`, stripePriceId: "price_starter", planTierId: "starter", interval: "monthly", status: "active", currentPeriodStart: now, currentPeriodEnd: end });
    for (const client of [c.native, c.remote]) {
      await expect(client.createSubscription({ planTierId: "pro", interval: "monthly" })).rejects.toMatchObject({ code: "BILLING_MIGRATION_REQUIRED" });
      await expect(client.cancelSubscription()).rejects.toMatchObject({ code: "BILLING_MIGRATION_REQUIRED" });
      await expect(client.resumeSubscription()).rejects.toMatchObject({ code: "BILLING_MIGRATION_REQUIRED" });
      await expect(client.createPortal()).rejects.toMatchObject({ code: "BILLING_MIGRATION_REQUIRED" });
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(await repository.listLiveSubscriptions(owner.orgId)).toHaveLength(2);
  });

  it("enforces membership, billing grants, read-only limits and feature switches before provider calls", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false });
    await db.insert(schema.member).values({ id: `billing-${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "admin" });
    const forbidden = await clients(member, owner.orgId);
    for (const client of [forbidden.native, forbidden.remote]) await expect(client.getState()).rejects.toMatchObject({ statusCode: 404 });
    const readonly = await clients(owner, owner.orgId, { credential: { organizationId: owner.orgId, readOnly: true } });
    await expect(readonly.native.createPortal()).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
    provider.enabled = false;
    const c = await clients(owner);
    for (const client of [c.native, c.remote]) {
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly" })).rejects.toMatchObject({ code: "BILLING_NOT_ENABLED" });
      await expect(client.createTopup({ packId: CREDIT_PACKS[0]!.id })).rejects.toMatchObject({ code: "BILLING_NOT_ENABLED" });
      expect(await client.createPortal()).toHaveProperty("portalUrl");
      expect((await client.getState()).billing.enabled).toBe(false);
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("isolates portal and renewal operations across tenants and exposes pending cancellation", async () => {
    const owner = await seedOwner(), other = await seedOwner(), c = await clients(owner), otherClients = await clients(other);
    await c.native.getState();
    await otherClients.native.getState();
    const namespace = (await repos.organization.findById(owner.orgId))!.oblienNamespace!;
    const otherNamespace = (await repos.organization.findById(other.orgId))!.oblienNamespace!;
    const subscription: NonNullable<OblienSubscription> = {
      tierId: "hobby", status: "active", billingInterval: "yearly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2027-09-01T00:00:00Z",
      cancelAtPeriodEnd: false, canceledAt: null,
    };
    provider.subscriptions.set(namespace, subscription);
    provider.subscriptions.set(otherNamespace, subscription);
    provider.enabled = false;
    for (const client of [c.native, c.remote]) {
      expect(await client.createPortal()).toEqual({ portalUrl: `https://billing.stripe.com/p/session/private-${namespace}` });
      expect(await client.cancelSubscription()).toMatchObject({ cancelAt: subscription.periodEnd, subscription: { tier: "starter", status: "active", interval: "annual", cancelAtPeriodEnd: true } });
      expect((await client.getSubscription()).subscription?.cancelAtPeriodEnd).toBe(true);
      const state = await client.getState();
      expect(state.status).toBe("active");
      expect(state.capabilities).toMatchObject({ portal: true, cancellation: true, resumption: true, subscriptionChange: false });
      expect(await client.resumeSubscription()).toMatchObject({ subscription: { cancelAtPeriodEnd: false } });
    }
    expect((await otherClients.native.getSubscription()).subscription?.cancelAtPeriodEnd).toBe(false);
    for (const [method, endpoint] of [[provider.portal, "portal"], [provider.cancel, "cancel"], [provider.resume, "resume"]] as const) {
      const response = await app.request(`/api/billing/${endpoint}`, {
        method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "X-Organization-Id": owner.orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: otherNamespace, customerId: "cus_foreign", subscriptionId: "sub_foreign" }),
      });
      expect(response.status).toBe(200);
      expect(method).toHaveBeenLastCalledWith(endpoint === "portal" ? expect.objectContaining({ namespace }) : namespace);
    }
    expect(provider.checkout).not.toHaveBeenCalled();
    await flushAudit();
    const events = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.organizationId, owner.orgId));
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(JSON.stringify(events)).not.toContain("cus_foreign");
  });

  it("requires billing admin permission for both direct renewal actions and the hosted portal", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false });
    await db.insert(schema.member).values({ id: `billing-writer-${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "restricted" });
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: member.userId, resourceType: "billing", resourceId: "*", permissions: ["read", "write"], grantedByUserId: owner.userId });
    const c = await clients(member, owner.orgId);
    for (const client of [c.native, c.remote]) {
      await expect(client.createPortal()).rejects.toMatchObject({ statusCode: 404 });
      await expect(client.cancelSubscription()).rejects.toMatchObject({ statusCode: 404 });
      await expect(client.resumeSubscription()).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(provider.portal).not.toHaveBeenCalled();
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(provider.resume).not.toHaveBeenCalled();
  });

  it("uses provider credit packs instead of legacy prices and enforces the independent top-up switch", async () => {
    const owner = await seedOwner(), c = await clients(owner), legacyPack = CREDIT_PACKS[0]!;
    await db.insert(schema.creditPack).values({ id: legacyPack.id, name: legacyPack.name, creditsMilli: 999, priceCents: 999, sortOrder: 0, stripeProductId: "product_retired", stripePriceId: "price_retired", active: true });
    for (const client of [c.native, c.remote]) {
      expect(await client.listTopupPacks()).toEqual([{ id: "starter", name: "Starter", credits_milli: 1_000_000, price_cents: 1000, sortOrder: 0, explains: null }]);
      expect(await client.createTopup({ packId: "starter" })).toEqual({ checkoutUrl: "https://checkout.stripe.com/private-session" });
    }
    expect(provider.checkout.mock.calls.every(([input]) => input.kind === "topup" && input.packId === "starter")).toBe(true);
    provider.topups = false;
    for (const client of [c.native, c.remote]) await expect(client.createTopup({ packId: "starter" })).rejects.toMatchObject({ code: "BILLING_TOPUPS_NOT_ENABLED" });
  });

  it("bounds usage ranges and hides projects a billing-only reader cannot access", async () => {
    const owner = await seedOwner(), member = await seedOwner({ bound: false });
    const input = { organizationId: owner.orgId, name: "Private project", slug: `billing-${owner.userId.replaceAll("_", "-")}` };
    const group = await repos.projectGroup.create(input);
    const project = await repos.project.create({ ...input, groupId: group.id });
    await repos.domain.create({ projectId: project.id, hostname: `${input.slug}${FREE_DOMAIN_SUFFIX}` });
    await db.insert(schema.member).values({ id: `billing-reader-${member.userId}`, organizationId: owner.orgId, userId: member.userId, role: "restricted" });
    await repos.resourceGrant.upsert({ organizationId: owner.orgId, userId: member.userId, resourceType: "billing", resourceId: "*", permissions: ["read"], grantedByUserId: owner.userId });
    const c = await clients(member, owner.orgId);
    for (const client of [c.native, c.remote]) {
      expect((await client.listAllowanceDetail()).freeSubdomains.items).toEqual([]);
      expect(await client.getUsage({ from: "2026-01-01", to: "2026-01-02", groupBy: "day" })).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", groupBy: "day", usage: null });
      await expect(client.getUsage({ from: "2026-02-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(client.getUsage({ from: "2000-01-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect((await (await clients(owner)).native.listAllowanceDetail()).freeSubdomains.items.map(item => item.projectId)).toEqual([project.id]);
  });

  it("does not forward a fixed local tenant through an unverified owner cloud link", async () => {
    provider.cloudMode = false;
    const c = await clients(await seedOwner());
    for (const client of [c.native, c.remote]) {
      await expect(client.getState()).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      await expect(client.createSubscription({ planTierId: "starter", interval: "monthly" })).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      expect((await client.listPlans()).plans.length).toBeGreaterThan(0);
    }
    expect(provider.cloudRequest).not.toHaveBeenCalled();
  });

  it("preserves legacy cloud proxy responses and normalizes credit packs from older servers", async () => {
    const owner = await seedOwner();
    const state = await (await clients(owner)).native.getState();
    provider.cloudMode = false;
    const legacy = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, fetch: fetcher });
    provider.cloudRequest.mockImplementation(async () => Response.json({ data: state }));
    expect(await legacy.billing.getState()).toEqual(state);
    expect(provider.cloudRequest).toHaveBeenCalledWith("/api/billing/state", { method: "GET", body: undefined });
    const pack = CREDIT_PACKS[0]!;
    provider.cloudRequest.mockImplementation(async () => Response.json({ data: [{ id: pack.id, name: pack.name, creditsMilli: pack.credits_milli, priceCents: pack.price_cents, sortOrder: pack.sortOrder, explains: pack.explains, stripePriceId: "private-provider-field" }] }));
    expect(await legacy.billing.listTopupPacks()).toEqual([pack]);
    provider.cloudRequest.mockImplementation(async () => Response.json({ error: "expired upstream" }, { status: 401 }));
    await expect(legacy.billing.getState()).rejects.toMatchObject({ status: 401, code: "cloud_session_expired" });
    provider.cloudRequest.mockImplementation(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(legacy.billing.getState()).rejects.toMatchObject({ status: 502, code: "cloud_invalid_response" });
    provider.cloudRequest.mockResolvedValue(null);
    await expect(legacy.billing.getState()).rejects.toMatchObject({ status: 403, code: "cloud_not_connected" });
  });
});
