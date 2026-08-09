import { repos } from "@repo/db";
import { encryptSecretField, decryptSecretField } from "../../lib/credential-encryption";
import type { RequestContext } from "../../lib/request-context";
import { resolveDnsProvider } from "./registry";
import {
  DnsProviderNotReadyError,
  type DnsProvider,
  type DnsZone,
} from "./types";

export interface SanitizedDnsCredential {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  status: string;
  tokenMasked: string;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function maskToken(token: string | null | undefined): string {
  if (!token) return "";
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

export function sanitizeCredential(cred: {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  apiTokenEnc: string;
  status: string;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SanitizedDnsCredential {
  const plainToken = decryptSecretField(cred.apiTokenEnc) ?? "";
  return {
    id: cred.id,
    organizationId: cred.organizationId,
    provider: cred.provider,
    name: cred.name,
    status: cred.status,
    tokenMasked: maskToken(plainToken),
    lastVerifiedAt: cred.lastVerifiedAt,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
}

export async function listCredentials(ctx: RequestContext): Promise<SanitizedDnsCredential[]> {
  const rows = await repos.dnsCredential.listByOrg(ctx.organizationId);
  return rows.map(sanitizeCredential);
}

export async function getCredential(
  ctx: RequestContext,
  id: string,
): Promise<SanitizedDnsCredential | null> {
  const row = await repos.dnsCredential.findById(ctx.organizationId, id);
  return row ? sanitizeCredential(row) : null;
}

export async function addCredential(
  ctx: RequestContext,
  input: {
    provider: string;
    name: string;
    apiToken: string;
  },
): Promise<SanitizedDnsCredential> {
  const provider = resolveDnsProvider(input.provider);

  // Preflight check against the provider API before storing
  const pre = await provider.preflight({ apiToken: input.apiToken });
  if (!pre.ok) {
    throw new DnsProviderNotReadyError(provider.name, pre.reason);
  }

  const apiTokenEnc = encryptSecretField(input.apiToken);
  if (!apiTokenEnc) {
    throw new Error("Failed to securely encrypt DNS API token.");
  }

  const row = await repos.dnsCredential.create({
    organizationId: ctx.organizationId,
    provider: input.provider,
    name: input.name.trim(),
    apiTokenEnc,
    status: "active",
    lastVerifiedAt: new Date(),
  });

  return sanitizeCredential(row);
}

export async function removeCredential(ctx: RequestContext, id: string): Promise<void> {
  await repos.dnsCredential.delete(ctx.organizationId, id);
}

export interface MatchedDnsManager {
  credentialId: string;
  provider: DnsProvider;
  zone: DnsZone;
  credentials: { apiToken: string };
}

/**
 * Find a connected DNS provider for the organization that manages the given hostname.
 * Returns null if no active credential matches the hostname's zone.
 */
export async function findDnsManagerForHostname(
  organizationId: string,
  hostname: string,
): Promise<MatchedDnsManager | null> {
  const credentials = await repos.dnsCredential.findActiveByOrg(organizationId);
  if (credentials.length === 0) return null;

  for (const cred of credentials) {
    const plainToken = decryptSecretField(cred.apiTokenEnc);
    if (!plainToken) continue;

    try {
      const provider = resolveDnsProvider(cred.provider);
      const zone = await provider.findZone({ apiToken: plainToken }, hostname);
      if (zone) {
        return {
          credentialId: cred.id,
          provider,
          zone,
          credentials: { apiToken: plainToken },
        };
      }
    } catch (err) {
      // If token is invalid / expired, update status asynchronously
      if (err instanceof Error && /401|403|unauthorized/i.test(err.message)) {
        void repos.dnsCredential.update(organizationId, cred.id, {
          status: "invalid",
        });
      }
    }
  }

  return null;
}
