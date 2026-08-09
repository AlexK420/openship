import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── DNS Credentials ─────────────────────────────────────────────────────────

/**
 * Organization-scoped DNS provider credentials (Cloudflare, etc.).
 *
 * API tokens are stored encrypted using the standard `enc1:` AES-256-GCM envelope
 * via `encryptSecretField()`. Plaintext tokens never leave the backend process.
 */
export const dnsCredential = pgTable(
  "dns_credential",
  {
    id: text("id").primaryKey(), // "dns_..."
    /** Organization that owns this credential. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Provider name: "cloudflare", etc. */
    provider: text("provider").notNull(),
    /** Operator-facing label, e.g. "Cloudflare Production". */
    name: text("name").notNull(),
    /** Encrypted API token (`enc1:...`). */
    apiTokenEnc: text("api_token_enc").notNull(),
    /** Status: "active" | "invalid" | "expired". */
    status: text("status").notNull().default("active"),
    /** Last successful validation timestamp. */
    lastVerifiedAt: timestamp("last_verified_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_dns_credential_org").on(t.organizationId),
  ],
);
