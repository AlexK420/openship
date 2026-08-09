/**
 * DNS Provider — generic DNS management abstraction.
 *
 * Provides automated DNS record provisioning (A, CNAME, TXT), zone discovery,
 * ACME DNS-01 challenge support for wildcard certificates, and Cloudflare Named Tunnel
 * integration.
 */

export type DnsProviderName = "cloudflare";

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV";

export interface DnsRecordInput {
  /** Record type: A, CNAME, TXT, etc. */
  type: DnsRecordType;
  /** Full domain name (e.g. "app.example.com", "_openship-challenge.example.com"). */
  name: string;
  /** Value / target of the record (IPv4 address, target hostname, TXT string). */
  content: string;
  /** Time to live in seconds (1 for provider automatic). */
  ttl?: number;
  /** Provider-specific proxying (e.g. Cloudflare orange cloud). Default false. */
  proxied?: boolean;
  /** Optional metadata comment for the record. */
  comment?: string;
}

export interface DnsRecord {
  /** Provider-assigned record ID. */
  id: string;
  /** Zone ID the record belongs to. */
  zoneId: string;
  type: DnsRecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

export interface DnsZone {
  /** Provider-assigned zone ID. */
  id: string;
  /** Apex zone name (e.g. "example.com"). */
  name: string;
  /** Zone status: "active", "pending", etc. */
  status: string;
}

export interface DnsProviderCredentials {
  /** Decrypted API token. */
  apiToken: string;
  /** Optional provider account ID. */
  accountId?: string;
}

export interface DnsProvider {
  readonly name: DnsProviderName;

  /**
   * Preflight check — validates credentials and permissions against the provider API.
   */
  preflight(
    credentials: DnsProviderCredentials,
  ): Promise<{ ok: true; detail?: string } | { ok: false; reason: string }>;

  /**
   * Find matching DNS zone for a hostname by walking up domain labels.
   * Returns null when the zone is not managed by this provider.
   */
  findZone(
    credentials: DnsProviderCredentials,
    hostname: string,
  ): Promise<DnsZone | null>;

  /**
   * List DNS records in a zone, optionally filtered by name or type.
   */
  listRecords(
    credentials: DnsProviderCredentials,
    zoneId: string,
    filter?: { name?: string; type?: DnsRecordType },
  ): Promise<DnsRecord[]>;

  /**
   * Create or update a DNS record idempotently.
   * If a record with the same name and type already exists, it is updated in-place.
   */
  upsertRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    input: DnsRecordInput,
  ): Promise<DnsRecord>;

  /**
   * Delete a DNS record by ID. Idempotent — succeeds if the record is already gone.
   */
  deleteRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    recordId: string,
  ): Promise<void>;
}

/* ────── Typed errors ───────────────────────────────────────────── */

export class UnknownDnsProviderError extends Error {
  readonly code = "DNS_UNKNOWN_PROVIDER" as const;
  constructor(name: string) {
    super(`Unknown DNS provider: ${name}`);
    this.name = "UnknownDnsProviderError";
  }
}

export class DnsProviderNotReadyError extends Error {
  readonly code = "DNS_PROVIDER_NOT_READY" as const;
  constructor(public readonly provider: DnsProviderName, reason: string) {
    super(`DNS provider "${provider}" not ready: ${reason}`);
    this.name = "DnsProviderNotReadyError";
  }
}

export class ZoneNotFoundError extends Error {
  readonly code = "DNS_ZONE_NOT_FOUND" as const;
  constructor(public readonly hostname: string) {
    super(`No matching DNS zone found for hostname: "${hostname}"`);
    this.name = "ZoneNotFoundError";
  }
}

export class DnsApiError extends Error {
  readonly code = "DNS_API_ERROR" as const;
  constructor(
    public readonly provider: DnsProviderName,
    public readonly statusCode: number,
    message: string,
  ) {
    super(`DNS provider "${provider}" API error (${statusCode}): ${message}`);
    this.name = "DnsApiError";
  }
}
