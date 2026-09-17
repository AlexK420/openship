import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: {} as Record<string, unknown>,
  entitlement: vi.fn(), balance: vi.fn(), defaults: vi.fn(), mirror: vi.fn(),
  setQuota: vi.fn(), resetQuota: vi.fn(), setDefaultQuota: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true } }));
vi.mock("@repo/db", () => ({
  repos: { organization: {
    findById: async () => ({ ...h.org }),
    setBillingEntitlement: h.mirror,
  } },
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({ getEntitlement: h.entitlement, getBalance: h.balance, getDefaults: h.defaults }),
  getOblienClient: () => ({ namespaces: { setQuota: h.setQuota, resetQuota: h.resetQuota, setDefaultQuota: h.setDefaultQuota } }),
}));
import {
  syncOblienEntitlement, reconcileOblienEntitlement, entitlementQuota,
  assertCloudCanSpend, assertNamespaceHasQuota, ensureOblienDefaultQuota, resetAndRegrant,
} from "@repo/platform/engine/modules/billing/billing-oblien-quota";

const entitlement = () => ({
  success: true as const, namespace: "os-customer", tierId: "pro", status: "active" as const,
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
  quota: { limit: 3000, used: 420, balance: 2580 },
});
beforeEach(() => {
  vi.resetAllMocks();
  h.org = { id: "org_1", oblienNamespace: "os-customer", planTierId: "free", subscriptionStatus: "credit_exhausted", currentPeriodStart: null, currentPeriodEnd: null };
  h.entitlement.mockResolvedValue(entitlement());
  h.balance.mockResolvedValue({ namespace: "os-customer", balance: 2580, blocking: false });
  h.defaults.mockResolvedValue({ autoApply: true, quotaLimit: 1000, onOverdraftAction: "stop_workspaces" });
});
describe("Oblien-managed entitlements", () => {
  it("mirrors the paid tier, billing status and exact provider period without writing quotas", async () => {
    const result = await syncOblienEntitlement("org_1");
    expect(result.tier).toBe("pro");
    expect(h.mirror).toHaveBeenCalledWith("org_1", "os-customer", {
      planTierId: "pro", subscriptionStatus: "active",
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    expect(h.setQuota).not.toHaveBeenCalled();
    expect(h.resetQuota).not.toHaveBeenCalled();
  });
  it("preserves purchased headroom and uncapped balances", () => {
    expect(entitlementQuota({ ...entitlement(), quota: { limit: 3000, used: -500, balance: 3500 } }))
      .toEqual({ quotaLimit: 3_000_000, quotaUsed: -500_000, quotaRemaining: 3_500_000 });
    expect(entitlementQuota({ ...entitlement(), quota: { limit: null, used: 30, balance: null } }))
      .toEqual({ quotaLimit: null, quotaUsed: 30_000, quotaRemaining: null });
  });
  it("does not rewrite state or grant credits on provider failure", async () => {
    h.entitlement.mockRejectedValue(new Error("upstream unavailable"));
    expect(await reconcileOblienEntitlement("org_1")).toBeNull();
    expect(h.mirror).not.toHaveBeenCalled();
    expect(h.setQuota).not.toHaveBeenCalled();
  });
  it("allows management tokens for exhausted customers but refuses new spending", async () => {
    h.entitlement.mockResolvedValue({ ...entitlement(), status: "credit_exhausted" });
    await expect(assertNamespaceHasQuota("org_1")).resolves.toBeUndefined();
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ statusCode: 402 });
  });
  it("checks the live spend gate even when entitlement reports active", async () => {
    h.balance.mockResolvedValue({ balance: -1, blocking: true });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "CLOUD_BILLING_BLOCKED" });
  });
  it("refuses unexpected unlimited consumer entitlements", async () => {
    h.entitlement.mockResolvedValue({ ...entitlement(), quota: { limit: null, used: 0, balance: null } });
    await expect(assertCloudCanSpend("org_1")).rejects.toMatchObject({ code: "OBLIEN_NAMESPACE_POLICY_REQUIRED" });
    expect(h.setQuota).not.toHaveBeenCalled();
  });
  it("validates account defaults without replacing provider quotas", async () => {
    await ensureOblienDefaultQuota();
    expect(h.setDefaultQuota).not.toHaveBeenCalled();
    h.defaults.mockResolvedValue({ autoApply: false, quotaLimit: null, onOverdraftAction: "block" });
    await expect(ensureOblienDefaultQuota()).rejects.toMatchObject({ code: "OBLIEN_DEFAULT_POLICY_REQUIRED" });
  });
  it("cannot run a legacy free-credit anniversary reset", async () => {
    await expect(resetAndRegrant("org_1", "pro")).rejects.toMatchObject({ code: "OBLIEN_MANAGED_BILLING" });
    expect(h.resetQuota).not.toHaveBeenCalled();
  });
});
