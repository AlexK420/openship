import type { DnsProvider, DnsProviderName } from "./types";
import { UnknownDnsProviderError } from "./types";
import { cloudflareDnsProvider } from "./providers/cloudflare.provider";

const PROVIDERS: Record<DnsProviderName, DnsProvider> = {
  cloudflare: cloudflareDnsProvider,
};

export function resolveDnsProvider(name: string): DnsProvider {
  const hit = PROVIDERS[name as DnsProviderName];
  if (!hit) throw new UnknownDnsProviderError(name);
  return hit;
}

export function listDnsProviders(): DnsProviderName[] {
  return Object.keys(PROVIDERS) as DnsProviderName[];
}

export interface DnsProviderDescriptor {
  name: DnsProviderName;
  displayName: string;
  description: string;
  requiredScopes: string[];
}

export function describeDnsProviders(): DnsProviderDescriptor[] {
  return [
    {
      name: "cloudflare",
      displayName: "Cloudflare",
      description:
        "Automatic DNS records, zone discovery, and wildcard SSL verification via scoped Cloudflare API token.",
      requiredScopes: ["Zone:Read", "DNS:Edit"],
    },
  ];
}
