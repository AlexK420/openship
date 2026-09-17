import { z } from "zod";
import { AppError } from "@repo/core";
import { Oblien } from "@repo/adapters";

// Oblien owns payments and credits. Validate its SDK responses at our tenant
// boundary before returning customer data or hosted billing session URLs.
const amount = z.number().finite();
const allowance = amount.nonnegative().nullable();
const date = z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable();
const namespace = z.string().min(1).max(128);

export const oblienCatalogSchema = z.object({
  success: z.literal(true),
  plans: z.array(z.object({
    tierId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    priceMonthly: allowance,
    priceYearly: allowance,
    currency: z.string(),
    creditsPerCycle: allowance,
    yearlyCreditsPerCycle: allowance,
    overdraftCredits: allowance.optional(),
    features: z.array(z.string()),
    popular: z.boolean().optional(),
  })),
  creditPacks: z.array(z.object({
    packId: z.string().min(1), name: z.string(), credits: amount.positive(),
    price: amount.nonnegative(), currency: z.string(), popular: z.boolean().optional(),
  })),
});

export const oblienEntitlementSchema = z.object({
  success: z.literal(true), namespace,
  tierId: z.string().nullable(),
  status: z.enum(["active", "past_due", "canceled", "credit_exhausted"]),
  periodStart: date, periodEnd: date,
  // Preserve signed legacy usage; the provider's limit includes purchased credits.
  quota: z.object({ limit: allowance, used: amount, balance: amount.nullable() }),
});

const policySchema = z.object({
  success: z.literal(true), service: z.literal("workspace_vm"),
  quotaLimit: allowance, overdraft: amount.nonnegative(),
  onOverdraftAction: z.enum(["stop_workspaces", "block"]), suspendThreshold: allowance,
});
const checkoutSchema = z.object({ success: z.literal(true), url: z.url(), checkoutId: z.string().min(1) });
const portalSchema = z.object({ success: z.literal(true), namespace, url: z.url() });
export const oblienSubscriptionSchema = z.object({
  success: z.literal(true), namespace,
  subscription: z.object({
    tierId: z.string().min(1),
    status: z.enum(["active", "trialing", "past_due", "unpaid", "paused", "canceled"]),
    billingInterval: z.enum(["monthly", "yearly"]),
    periodStart: date, periodEnd: date,
    cancelAtPeriodEnd: z.boolean(), canceledAt: date,
  }).nullable(),
});

export type OblienBillingCatalog = z.infer<typeof oblienCatalogSchema>;
export type OblienEntitlement = z.infer<typeof oblienEntitlementSchema>;
export type OblienBillingPolicy = z.infer<typeof policySchema>;
export type OblienSubscription = z.infer<typeof oblienSubscriptionSchema>["subscription"];
export type OblienCheckout = {
  namespace: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
} & ({ kind: "subscription"; planTierId: string; billingInterval: "monthly" | "yearly" }
  | { kind: "topup"; packId: string });

export class OblienBillingApi {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly billing: Oblien["billing"];

  constructor(private readonly options: {
    clientId?: string; clientSecret?: string; baseUrl?: string;
    fetch?: typeof fetch; timeoutMs?: number;
  } = {}) {
    const url = new URL(options.baseUrl ?? "https://api.oblien.com");
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("Oblien API URL must use HTTPS (HTTP is allowed for localhost tests)");
    }
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    // SDK 2.3 has no fetch/timeout option. Replace only this instance's transport
    // so the official billing module owns endpoints and request formatting while
    // we retain timeouts, strict HTTP errors, and credential-safe redirects.
    const client = new Oblien({ token: "", baseUrl: this.baseUrl });
    client._http.request = <T>(request: Parameters<Oblien["_http"]["request"]>[0]) => this.request<T>(request);
    this.billing = client.billing;
  }

  private async request<T>({ method, path, body, query }: Parameters<Oblien["_http"]["request"]>[0]): Promise<T> {
    if (!path.startsWith("/billing/")) throw new Error("Billing transport only accepts billing routes");
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const publicRead = method === "GET" && path === "/billing/catalog";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!publicRead) {
      if (!this.options.clientId || !this.options.clientSecret) {
        throw new AppError("Cloud billing is not configured", 503, "BILLING_NOT_CONFIGURED");
      }
      headers["X-Client-ID"] = this.options.clientId;
      headers["X-Client-Secret"] = this.options.clientSecret;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetcher(url.toString(), {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        // A redirect must never carry the reseller's credentials to another host.
        redirect: "error",
      });
      payload = await response.json();
    } catch {
      throw new AppError("Cloud billing is temporarily unavailable. Please retry.", 503, "OBLIEN_BILLING_UNAVAILABLE");
    }
    if (!response.ok || (payload as { success?: unknown } | null)?.success !== true) {
      // Do not forward provider bodies: they can contain account or payment data.
      const status = [400, 404, 409, 422, 429].includes(response.status) ? response.status : 503;
      const code = typeof (payload as { code?: unknown })?.code === "string"
        ? (payload as { code: string }).code : "";
      const known: Record<string, string> = {
        invalid_plan: "This plan is no longer available. Refresh the plans page.",
        invalid_pack: "This credit pack is no longer available. Refresh the billing page.",
        no_customer: "No billing account exists yet. Complete a checkout first.",
        no_subscription: "This organization has no subscription to manage.",
        subscription_ended: "This subscription has ended. Start a new checkout to subscribe again.",
        billing_customer_conflict: "This organization's billing needs to be separated from a legacy account. Contact support.",
        billing_identity_conflict: "This organization's billing identity needs to be verified. Contact support.",
      };
      throw new AppError(known[code] ?? "Cloud billing could not complete this request. Please retry.", status, "OBLIEN_BILLING_ERROR");
    }
    return payload as T;
  }

  private async validate<T>(response: Promise<unknown>, schema: z.ZodType<T>, slug?: string): Promise<T> {
    const parsed = schema.safeParse(await response);
    if (!parsed.success) throw new AppError("Cloud billing returned an invalid response", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    if (slug !== undefined && (parsed.data as { namespace?: string }).namespace !== slug) {
      throw new AppError("Cloud billing returned a different namespace", 502, "OBLIEN_BILLING_NAMESPACE_MISMATCH");
    }
    return parsed.data;
  }

  getCatalog(): Promise<OblienBillingCatalog> {
    return this.validate(this.billing.catalog(), oblienCatalogSchema);
  }

  getEntitlement(slug: string): Promise<OblienEntitlement> {
    return this.validate(this.billing.entitlement(slug), oblienEntitlementSchema, slug);
  }

  getBalance(slug: string) {
    return this.validate(this.billing.balance(slug), z.object({
      success: z.literal(true), namespace, blocking: z.boolean(), balance: amount.nullable(),
    }), slug);
  }

  getDefaults() {
    return this.validate(this.billing.defaults(), policySchema.extend({ autoApply: z.boolean() }));
  }

  getPolicy(slug: string) {
    return this.validate(this.billing.policy(slug), policySchema.extend({ namespace }), slug);
  }

  getSubscription(slug: string) {
    return this.validate(this.billing.subscription(slug), oblienSubscriptionSchema, slug);
  }

  cancelSubscription(slug: string) {
    return this.validate(this.billing.cancelSubscription(slug), oblienSubscriptionSchema, slug);
  }

  resumeSubscription(slug: string) {
    return this.validate(this.billing.resumeSubscription(slug), oblienSubscriptionSchema, slug);
  }

  async createPortal(input: { namespace: string; returnUrl: string }) {
    const result = await this.validate(this.billing.portal(input), portalSchema, input.namespace);
    this.validateHostedUrl(result.url, "billing.stripe.com");
    return result;
  }

  async createCheckout(input: OblienCheckout) {
    const result = await this.validate(this.billing.checkout(input), checkoutSchema);
    this.validateHostedUrl(result.url, "checkout.stripe.com");
    return result;
  }

  private validateHostedUrl(value: string, hostname: string): void {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname || url.port || url.username || url.password) {
      throw new AppError("Cloud billing returned an invalid hosted URL", 502, "OBLIEN_BILLING_INVALID_RESPONSE");
    }
  }
}
