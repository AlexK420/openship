import type { BillingSubscription } from "@repo/contracts";
import type { OblienSubscription } from "../../lib/oblien-billing-api";
import { openshipTier } from "./billing-catalog";

/** Keep provider identifiers out of the public application contract. */
export function presentCloudSubscription(subscription: OblienSubscription): BillingSubscription | null {
  if (!subscription) return null;
  return {
    tier: openshipTier(subscription.tierId),
    status: subscription.status,
    interval: subscription.billingInterval === "yearly" ? "annual" : "monthly",
    currentPeriod: { start: subscription.periodStart, end: subscription.periodEnd },
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt,
  };
}
