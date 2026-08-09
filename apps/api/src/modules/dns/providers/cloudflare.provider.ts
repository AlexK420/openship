import type {
  DnsProvider,
  DnsProviderCredentials,
  DnsRecord,
  DnsRecordInput,
  DnsRecordType,
  DnsZone,
} from "../types";
import { DnsApiError } from "../types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

interface CfTokenVerifyResult {
  id: string;
  status: string;
}

interface CfZoneItem {
  id: string;
  name: string;
  status: string;
}

interface CfDnsRecordItem {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

/** Helper to call Cloudflare REST API with token auth. */
async function cfFetch<T>(
  apiToken: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${CF_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Openship-DNS-Provider",
    ...(options.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const text = await res.text();
  let body: CfResponse<T>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DnsApiError("cloudflare", res.status, `Non-JSON response from Cloudflare: ${text.slice(0, 150)}`);
  }

  if (!res.ok || !body.success) {
    const errorMsg = body.errors?.map((e) => e.message).join(", ") || `HTTP ${res.status}`;
    throw new DnsApiError("cloudflare", res.status, errorMsg);
  }

  return body.result;
}

export const cloudflareDnsProvider: DnsProvider = {
  name: "cloudflare",

  async preflight(credentials: DnsProviderCredentials) {
    if (!credentials.apiToken) {
      return { ok: false, reason: "Cloudflare API token is missing." };
    }

    try {
      const result = await cfFetch<CfTokenVerifyResult>(
        credentials.apiToken,
        "/user/tokens/verify",
        { method: "GET" },
      );

      if (result.status === "active") {
        return { ok: true, detail: "Cloudflare API token is active and valid." };
      }
      return { ok: false, reason: `Cloudflare API token status is: ${result.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Cloudflare token validation failed: ${msg}` };
    }
  },

  async findZone(credentials: DnsProviderCredentials, hostname: string): Promise<DnsZone | null> {
    const cleanHost = hostname.toLowerCase().replace(/\.+$/, "");
    const parts = cleanHost.split(".");

    // Walk domain labels from most specific to least specific:
    // e.g. for "a.b.example.com", test "a.b.example.com", "b.example.com", "example.com"
    for (let i = 0; i <= parts.length - 2; i++) {
      const candidate = parts.slice(i).join(".");
      try {
        const zones = await cfFetch<CfZoneItem[]>(
          credentials.apiToken,
          `/zones?name=${encodeURIComponent(candidate)}&status=active`,
          { method: "GET" },
        );

        if (zones && zones.length > 0 && zones[0]) {
          return {
            id: zones[0].id,
            name: zones[0].name,
            status: zones[0].status,
          };
        }
      } catch (err) {
        if (err instanceof DnsApiError && (err.statusCode === 401 || err.statusCode === 403)) {
          throw err;
        }
        // Continue searching broader domain labels on non-fatal query errors
      }
    }

    return null;
  },

  async listRecords(
    credentials: DnsProviderCredentials,
    zoneId: string,
    filter?: { name?: string; type?: DnsRecordType },
  ): Promise<DnsRecord[]> {
    const params = new URLSearchParams();
    params.set("per_page", "100");
    if (filter?.name) params.set("name", filter.name.toLowerCase().replace(/\.+$/, ""));
    if (filter?.type) params.set("type", filter.type);

    const records = await cfFetch<CfDnsRecordItem[]>(
      credentials.apiToken,
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${params.toString()}`,
      { method: "GET" },
    );

    return (records || []).map((r) => ({
      id: r.id,
      zoneId: r.zone_id,
      type: r.type as DnsRecordType,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied ?? false,
    }));
  },

  async upsertRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    input: DnsRecordInput,
  ): Promise<DnsRecord> {
    const cleanName = input.name.toLowerCase().replace(/\.+$/, "");
    const existingList = await this.listRecords(credentials, zoneId, {
      name: cleanName,
      type: input.type,
    });

    const payload = {
      type: input.type,
      name: cleanName,
      content: input.content,
      ttl: input.ttl ?? 1, // 1 = automatic in Cloudflare
      proxied: input.proxied ?? false,
      comment: input.comment ?? "Managed by Openship",
    };

    // If an existing record of the same name and type is present, update in place
    if (existingList.length > 0 && existingList[0]) {
      const existing = existingList[0];
      // Only make API call if content, ttl, or proxied changed
      if (
        existing.content === input.content &&
        existing.proxied === (input.proxied ?? false) &&
        (input.ttl === undefined || existing.ttl === input.ttl)
      ) {
        return existing;
      }

      const updated = await cfFetch<CfDnsRecordItem>(
        credentials.apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        },
      );

      return {
        id: updated.id,
        zoneId: updated.zone_id,
        type: updated.type as DnsRecordType,
        name: updated.name,
        content: updated.content,
        ttl: updated.ttl,
        proxied: updated.proxied ?? false,
      };
    }

    // Otherwise create a new record
    const created = await cfFetch<CfDnsRecordItem>(
      credentials.apiToken,
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    return {
      id: created.id,
      zoneId: created.zone_id,
      type: created.type as DnsRecordType,
      name: created.name,
      content: created.content,
      ttl: created.ttl,
      proxied: created.proxied ?? false,
    };
  },

  async deleteRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    recordId: string,
  ): Promise<void> {
    try {
      await cfFetch<{ id: string }>(
        credentials.apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      // If the record was already deleted (404), treat as idempotent success
      if (err instanceof DnsApiError && err.statusCode === 404) {
        return;
      }
      throw err;
    }
  },
};
