"use client";

import { useEffect, useRef, useState } from "react";
import {
  PricingCards,
  type ApiPlan,
  type ApiPricingUi,
} from "@/components/billing/PricingCards";
import { api } from "@/lib/api/client";
import { endpoints } from "@/lib/api/endpoints";
import type { PlanTierId } from "@repo/core";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import type { BillingSubscription } from "@repo/contracts";

interface PlansPayload {
  locale: string;
  annual: { enabled: boolean; monthsFree: number };
  ui: ApiPricingUi;
  plans: ApiPlan[];
}

interface PlansResponse {
  data: PlansPayload;
}

interface CheckoutResponse {
  data: { checkoutUrl: string };
}

export function BillingPlansRoute({ currentPlan, subscription, billingEnabled = false, canChangeSubscription = false }: {
  currentPlan: PlanTierId; billingEnabled?: boolean; canChangeSubscription?: boolean;
  subscription?: BillingSubscription | null;
}) {
  const { t, locale } = useI18n();
  const [payload, setPayload] = useState<PlansPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [interval, setInterval] = useState<"monthly" | "annual">(subscription?.interval ?? "monthly");
  const attempts = useRef(new Map<string, string>());
  const canPurchase = billingEnabled && (currentPlan === "free" || canChangeSubscription);
  const selectedCurrentPlan = subscription === null || subscription?.status === "canceled"
    || (subscription && subscription.interval !== interval) ? null : currentPlan;

  useEffect(() => {
    let cancelled = false;
    async function fetchPlans() {
      try {
        // Plan copy is localized SERVER-side from the pricing catalog, so the
        // reader's locale (a cookie the browser never sends as a language
        // header) has to travel on the query string.
        const res = await api.get<PlansResponse>(
          `${endpoints.billing.plans}?locale=${encodeURIComponent(locale)}`,
        );
        if (!cancelled) setPayload(res.data);
      } catch {
        if (!cancelled) setError(t.billing.plansRoute.loadError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPlans();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const handleSelectPlan = async (planTierId: PlanTierId) => {
    if (!canPurchase || subscribing || planTierId === "free" || planTierId === selectedCurrentPlan) return;
    setSubscribing(planTierId);
    setCheckoutError(null);
    const attempt = `${planTierId}:${interval}`;
    if (!attempts.current.has(attempt)) attempts.current.set(attempt, crypto.randomUUID());
    try {
      // Body key MUST be `planTierId` — the backend `createSubscriptionSchema`
      // validates that exact field (the old `planId` silently 400'd).
      const res = await api.post<CheckoutResponse>("billing/subscription", {
        planTierId,
        interval,
        idempotencyKey: attempts.current.get(attempt),
      });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : t.billing.plansRoute.checkoutError);
      setSubscribing(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{error || t.billing.plansRoute.genericError}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 text-sm font-medium text-primary hover:underline"
        >
          {t.billing.plansRoute.tryAgain}
        </button>
      </div>
    );
  }

  // The Plans tab is where you BUY something, so the $0 tier has no place in it:
  // it is nothing to buy, and for the overwhelming majority of viewers it is the
  // plan they are already on — a card whose only button says "Current plan".
  // Where you stand is stated on Overview and in the allowance cards above.
  // Filtered on price rather than the id `free` so any future $0 tier is covered
  // by the same rule. Customers can stop renewal from Overview or the portal.
  const purchasable = payload.plans.filter((p) => p.price.monthly !== 0);

  return (
    <div className="space-y-5">
      {payload.annual.enabled && (
        <div className="flex gap-2" role="group" aria-label={t.billing.pricing.billingInterval}>
          {(["monthly", "annual"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={interval === value} onClick={() => setInterval(value)} disabled={subscribing !== null}
              className={`rounded-lg border px-3 py-2 text-sm ${interval === value ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
              {value === "monthly" ? t.billing.pricing.monthly : t.billing.pricing.annual}
            </button>
          ))}
        </div>
      )}
      {canPurchase && subscription && subscription.status !== "canceled" && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          {t.billing.plansRoute.replacementNotice}
        </p>
      )}
      {checkoutError && <p role="alert" className="text-sm text-danger">{checkoutError}</p>}
      {!canPurchase && (
        <p className="text-sm text-muted-foreground">
          {billingEnabled ? t.billing.plansRoute.changeViaSupport : t.billing.plansRoute.billingUnavailable}{" "}
          <a href="mailto:support@openship.io" className="text-primary hover:underline">{t.billing.portal.supportButton}</a>
        </p>
      )}
    <PricingCards
      plans={purchasable}
      ui={payload.ui}
      currentPlan={selectedCurrentPlan}
      onSelectPlan={handleSelectPlan}
      subscribingPlan={subscribing}
      purchasesDisabled={!canPurchase}
      interval={interval}
    />
    </div>
  );
}
