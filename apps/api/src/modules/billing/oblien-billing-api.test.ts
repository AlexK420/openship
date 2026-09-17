import { describe, it, expect, vi } from "vitest";
import { OblienBillingApi } from "@repo/platform/engine/lib/oblien-billing-api";

const entitlement = { success: true, namespace: "os-one", tierId: "pro", status: "active", periodStart: null, periodEnd: null, quota: { limit: 3000, used: -50, balance: 3050 } };
const subscription = { success: true, namespace: "os-one", subscription: {
  tierId: "pro", status: "active", billingInterval: "monthly", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
  cancelAtPeriodEnd: true, canceledAt: "2026-09-15T00:00:00Z",
} };
function setup(body: unknown, status = 200) {
  const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(body, { status }));
  const api = new OblienBillingApi({ clientId: "test-id", clientSecret: "test-secret", fetch: fetcher as unknown as typeof fetch });
  return { api, fetcher };
}
describe("Oblien 2.3 billing SDK and transport contract", () => {
  it("authenticates server requests and validates the returned customer namespace", async () => {
    const { api, fetcher } = setup(entitlement);
    expect((await api.getEntitlement("os-one")).quota.used).toBe(-50);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/entitlement?namespace=os-one", expect.objectContaining({
      headers: expect.objectContaining({ "X-Client-ID": "test-id", "X-Client-Secret": "test-secret" }), redirect: "error",
    }));
    await expect(api.getEntitlement("os-two")).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("reads the public catalog without transmitting reseller credentials", async () => {
    const { api, fetcher } = setup({ success: true, plans: [], creditPacks: [] });
    await api.getCatalog();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Accept: "application/json" } });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("X-Client-Secret");
  });
  it("posts the documented namespace, interval and idempotency key", async () => {
    const { api, fetcher } = setup({ success: true, url: "https://checkout.stripe.com/c/pay/test", checkoutId: "cs_test" });
    const input = { namespace: "os-one", kind: "subscription" as const, planTierId: "hobby", billingInterval: "yearly" as const,
      successUrl: "https://app.openship.io/billing/overview", cancelUrl: "https://app.openship.io/billing/plans", idempotencyKey: "checkout-123" };
    await api.createCheckout(input);
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/checkout", expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
  });
  it("rejects unexpected checkout hosts and malformed entitlements", async () => {
    await expect(setup({ success: true, url: "https://example.com/payment", checkoutId: "cs_1" }).api.createCheckout({
      namespace: "os-one", kind: "topup", packId: "starter", successUrl: "https://app.openship.io", cancelUrl: "https://app.openship.io", idempotencyKey: "topup-1",
    })).rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
    await expect(setup({ ...entitlement, status: "unrecognized" }).api.getEntitlement("os-one")).rejects.toMatchObject({ statusCode: 502 });
  });
  it("does not expose provider error bodies or silently retry a purchase", async () => {
    const { api, fetcher } = setup({ success: false, message: "private account detail" }, 500);
    await expect(api.getEntitlement("os-one")).rejects.toThrow("Cloud billing could not complete");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("opens only the supplied namespace's portal with a safe hosted URL", async () => {
    const { api, fetcher } = setup({ success: true, namespace: "os-one", url: "https://billing.stripe.com/p/session/test" });
    const input = { namespace: "os-one", returnUrl: "https://app.openship.io/billing/overview" };
    expect((await api.createPortal(input)).url).toBe("https://billing.stripe.com/p/session/test");
    expect(fetcher).toHaveBeenCalledWith("https://api.oblien.com/billing/portal", expect.objectContaining({ method: "POST", body: JSON.stringify(input), redirect: "error", signal: expect.any(AbortSignal) }));
    await expect(api.createPortal({ ...input, namespace: "os-two" })).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("rejects a legacy owner portal even when its hosted URL is otherwise valid", async () => {
    const { api } = setup({ success: true, url: "https://billing.stripe.com/p/session/owner" });
    await expect(api.createPortal({ namespace: "os-one", returnUrl: "https://app.openship.io" }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it.each(["http://billing.stripe.com/session", "https://billing.stripe.com.evil.test/session", "https://billing.stripe.com:8443/session", "https://user:password@billing.stripe.com/session"])("rejects unsafe portal URL %s", async (url) => {
    await expect(setup({ success: true, namespace: "os-one", url }).api.createPortal({ namespace: "os-one", returnUrl: "https://app.openship.io" }))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it.each([
    ["getSubscription", "GET", "/billing/subscription?namespace=os-one"],
    ["cancelSubscription", "POST", "/billing/subscription/cancel"],
    ["resumeSubscription", "POST", "/billing/subscription/resume"],
  ] as const)("uses the SDK %s method and checks the response namespace", async (method, verb, path) => {
    const { api, fetcher } = setup(subscription);
    expect(await api[method]("os-one")).toEqual(subscription);
    expect(fetcher).toHaveBeenCalledWith(`https://api.oblien.com${path}`, expect.objectContaining({
      method: verb, ...(verb === "POST" ? { body: JSON.stringify({ namespace: "os-one" }) } : {}),
    }));
    await expect(api[method]("os-two")).rejects.toMatchObject({ code: "OBLIEN_BILLING_NAMESPACE_MISMATCH" });
  });
  it("distinguishes never subscribed from a malformed subscription", async () => {
    expect((await setup({ ...subscription, subscription: null }).api.getSubscription("os-one")).subscription).toBeNull();
    await expect(setup({ ...subscription, subscription: { ...subscription.subscription, cancelAtPeriodEnd: "false" } }).api.getSubscription("os-one"))
      .rejects.toMatchObject({ code: "OBLIEN_BILLING_INVALID_RESPONSE" });
  });
  it.each([
    [404, "no_customer", "Complete a checkout first"],
    [409, "billing_customer_conflict", "Contact support"],
    [409, "billing_identity_conflict", "Contact support"],
    [409, "subscription_ended", "Start a new checkout"],
  ])("preserves actionable %s/%s errors without exposing provider identities", async (status, code, message) => {
    const { api } = setup({ success: false, code, message: "private customer cus_secret subscription sub_secret" }, status as number);
    const error = await api.createPortal({ namespace: "os-one", returnUrl: "https://app.openship.io" }).catch(error => error);
    expect(error.statusCode).toBe(status);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("secret");
  });
  it("requires server credentials for management but not the public catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, plans: [], creditPacks: [] }));
    const api = new OblienBillingApi({ fetch: fetcher as unknown as typeof fetch });
    await api.getCatalog();
    await expect(api.getSubscription("os-one")).rejects.toMatchObject({ code: "BILLING_NOT_CONFIGURED" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not accept an HTTP failure just because the response body claims success", async () => {
    await expect(setup(subscription, 503).api.getSubscription("os-one")).rejects.toMatchObject({ statusCode: 503 });
  });
});
