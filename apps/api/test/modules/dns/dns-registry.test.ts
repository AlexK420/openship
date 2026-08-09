import { describe, it, expect } from "vitest";
import {
  resolveDnsProvider,
  listDnsProviders,
  describeDnsProviders,
} from "../../../src/modules/dns/registry";
import { UnknownDnsProviderError } from "../../../src/modules/dns/types";

describe("dns registry", () => {
  it("resolves registered cloudflare provider", () => {
    const provider = resolveDnsProvider("cloudflare");
    expect(provider.name).toBe("cloudflare");
  });

  it("throws UnknownDnsProviderError for unknown provider", () => {
    expect(() => resolveDnsProvider("unsupported")).toThrow(UnknownDnsProviderError);
  });

  it("lists all providers", () => {
    expect(listDnsProviders()).toContain("cloudflare");
  });

  it("describes provider details and required scopes", () => {
    const descriptors = describeDnsProviders();
    const cf = descriptors.find((d) => d.name === "cloudflare");
    expect(cf).toBeDefined();
    expect(cf?.requiredScopes).toEqual(["Zone:Read", "DNS:Edit"]);
  });
});
