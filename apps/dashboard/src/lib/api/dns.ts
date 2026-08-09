import { api } from "./client";
import { endpoints } from "./endpoints";

export interface DnsProviderDescriptor {
  name: "cloudflare";
  displayName: string;
  description: string;
  requiredScopes: string[];
}

export interface SanitizedDnsCredential {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  status: string;
  tokenMasked: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddDnsCredentialInput {
  provider: "cloudflare";
  name: string;
  apiToken: string;
}

export interface VerifyZoneResult {
  matched: boolean;
  provider?: string;
  zoneName?: string;
  zoneId?: string;
  message?: string;
}

export const dnsApi = {
  /** List supported DNS providers and required permission scopes. */
  listProviders: () =>
    api.get<{ data: DnsProviderDescriptor[] }>(endpoints.dns.providers),

  /** List connected DNS credentials for the active organization. */
  listCredentials: () =>
    api.get<{ data: SanitizedDnsCredential[] }>(endpoints.dns.credentials),

  /** Get a single connected DNS credential by ID. */
  getCredential: (id: string) =>
    api.get<{ data: SanitizedDnsCredential }>(endpoints.dns.credentialById(id)),

  /** Connect a new DNS credential (e.g. Cloudflare API token). */
  addCredential: (input: AddDnsCredentialInput) =>
    api.post<{ data: SanitizedDnsCredential }>(endpoints.dns.credentials, input),

  /** Disconnect and remove a DNS credential. */
  removeCredential: (id: string) =>
    api.delete(endpoints.dns.credentialById(id)),

  /** Check if a connected DNS provider can manage a specific hostname. */
  verifyZone: (hostname: string) =>
    api.post<VerifyZoneResult>(endpoints.dns.verifyZone, { hostname }),
};
