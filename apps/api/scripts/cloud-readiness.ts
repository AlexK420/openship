/** Read-only release checks. Does not create tokens, checkouts, or resources. */
import { runtimeTarget } from "@repo/core";
import { OblienBillingApi } from "@repo/platform/engine/lib/oblien-billing-api";
import { OBLIEN_WEBHOOK_EVENTS, oblienWebhookUrl } from "@repo/platform/engine/lib/oblien-webhook-config";

const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const record = (check: string, ok: boolean, detail?: string) => results.push({ check, ok, ...(detail ? { detail } : {}) });
const clientId = process.env.OBLIEN_CLIENT_ID;
const clientSecret = process.env.OBLIEN_CLIENT_SECRET;
const apiBase = process.env.OBLIEN_API_URL ?? "https://api.oblien.com";
record("Cloud mode", process.env.CLOUD_MODE === "true");
record("Oblien credentials configured", Boolean(clientId && clientSecret));
record("Webhook secret configured", Boolean(process.env.OBLIEN_WEBHOOK_SECRET));
record("Subscription purchases enabled", process.env.BILLING_ENABLED === "true");
record("Credit purchases enabled", process.env.BILLING_TOPUPS_ENABLED === "true");

const billing = new OblienBillingApi({ clientId, clientSecret, baseUrl: apiBase });
const checks = await Promise.allSettled([
  (async () => {
    const catalog = await billing.getCatalog();
    const plans = catalog.plans.filter((plan) => plan.priceMonthly !== null);
    record("Provider catalog", plans.length > 0 && [...catalog.plans, ...catalog.creditPacks].every((item) => item.currency.toUpperCase() === "USD"),
      `${plans.length} priced plans, ${catalog.creditPacks.length} credit packs`);
  })(),
  (async () => {
    const defaults = await billing.getDefaults();
    record("Finite automatic namespace policy", defaults.autoApply && defaults.quotaLimit !== null && defaults.onOverdraftAction === "stop_workspaces",
      `autoApply=${defaults.autoApply}, quotaLimit=${defaults.quotaLimit}, action=${defaults.onOverdraftAction}`);
  })(),
  (async () => {
    const callback = oblienWebhookUrl(process.env.OBLIEN_WEBHOOK_URL, runtimeTarget.api);
    if (!clientId || !clientSecret) throw new Error("Oblien credentials are missing");
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/webhooks`, {
      headers: { "X-Client-ID": clientId, "X-Client-Secret": clientSecret },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Webhook registry HTTP ${response.status}`);
    const body = await response.json() as { success: boolean; webhooks?: Array<{ url: string; active: boolean; namespace?: string | null; events: string[]; secret?: string | null }> };
    const webhook = body.success && body.webhooks?.find((item) => item.url === callback && !item.namespace && item.active);
    const missing = OBLIEN_WEBHOOK_EVENTS.filter((event) => !webhook || !webhook.events.includes(event));
    record("Account-wide signed billing webhook", Boolean(webhook && webhook.secret && missing.length === 0),
      webhook ? `Missing events: ${missing.join(", ") || "none"}` : "No active account-wide webhook matches the configured callback");
  })(),
  (async () => {
    if (!clientId || !clientSecret) throw new Error("Oblien credentials are missing");
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/namespaces?limit=1`, {
      headers: { "X-Client-ID": clientId, "X-Client-Secret": clientSecret },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Namespace registry HTTP ${response.status}`);
    const body = await response.json() as { success: boolean; data?: Array<{ slug: string }> };
    // The probe is read-only even on a new account with no namespace yet.
    const namespace = body.success && body.data?.[0]?.slug || "openship-billing-readiness";
    await billing.getSubscription(namespace);
    record("Namespace subscription API (SDK 2.3)", true, "Authenticated namespace-bound response verified");
  })(),
]);
checks.forEach((result, index) => {
  if (result.status === "rejected") {
    // Never serialize provider bodies, headers, credentials, or webhook secrets.
    const error = result.reason;
    record(["Provider catalog", "Namespace default policy", "Webhook registration", "Namespace subscription API (SDK 2.3)"][index]!, false,
      error instanceof Error ? error.message : "Read failed");
  }
});
console.log(JSON.stringify({ readOnly: true, checks: results, passed: results.every((result) => result.ok) }, null, 2));
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
