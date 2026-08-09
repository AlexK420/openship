import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cloudflareDnsProvider } from "../../../src/modules/dns/providers/cloudflare.provider";
import { DnsApiError } from "../../../src/modules/dns/types";

describe("cloudflareDnsProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("preflight", () => {
    it("fails when API token is empty", async () => {
      const result = await cloudflareDnsProvider.preflight({ apiToken: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("missing");
      }
    });

    it("succeeds when Cloudflare token verification returns active", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { id: "tok_123", status: "active" },
        }),
      } as Response);

      const result = await cloudflareDnsProvider.preflight({ apiToken: "valid-token" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.detail).toContain("active and valid");
      }
    });

    it("returns error reason when Cloudflare token is not active", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { id: "tok_123", status: "disabled" },
        }),
      } as Response);

      const result = await cloudflareDnsProvider.preflight({ apiToken: "disabled-token" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("disabled");
      }
    });
  });

  describe("findZone", () => {
    it("discovers zone by walking labels from subdomain to apex", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("name=app.sub.example.com")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ success: true, errors: [], messages: [], result: [] }),
          };
        }
        if (url.includes("name=sub.example.com")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ success: true, errors: [], messages: [], result: [] }),
          };
        }
        if (url.includes("name=example.com")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: [{ id: "zone_cf_example", name: "example.com", status: "active" }],
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, errors: [], messages: [], result: [] }),
        };
      });

      global.fetch = fetchMock;

      const zone = await cloudflareDnsProvider.findZone(
        { apiToken: "test-token" },
        "app.sub.example.com",
      );

      expect(zone).toEqual({
        id: "zone_cf_example",
        name: "example.com",
        status: "active",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("returns null when no zone matches", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, errors: [], messages: [], result: [] }),
      } as Response);

      const zone = await cloudflareDnsProvider.findZone(
        { apiToken: "test-token" },
        "unrelated.domain.org",
      );

      expect(zone).toBeNull();
    });
  });

  describe("upsertRecord", () => {
    it("creates a new record when no matching record exists", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: {
                id: "rec_new_123",
                zone_id: "zone_123",
                type: body.type,
                name: body.name,
                content: body.content,
                ttl: body.ttl,
                proxied: body.proxied,
              },
            }),
          };
        }
        // list records -> empty
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, errors: [], messages: [], result: [] }),
        };
      });

      global.fetch = fetchMock;

      const record = await cloudflareDnsProvider.upsertRecord(
        { apiToken: "test-token" },
        "zone_123",
        {
          type: "A",
          name: "app.example.com",
          content: "192.0.2.1",
          proxied: false,
        },
      );

      expect(record).toEqual({
        id: "rec_new_123",
        zoneId: "zone_123",
        type: "A",
        name: "app.example.com",
        content: "192.0.2.1",
        ttl: 1,
        proxied: false,
      });
    });

    it("updates existing record when matching record is found", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              success: true,
              errors: [],
              messages: [],
              result: {
                id: "rec_existing_456",
                zone_id: "zone_123",
                type: body.type,
                name: body.name,
                content: body.content,
                ttl: body.ttl,
                proxied: body.proxied,
              },
            }),
          };
        }
        // list records -> existing record
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: [
              {
                id: "rec_existing_456",
                zone_id: "zone_123",
                type: "A",
                name: "app.example.com",
                content: "198.51.100.1",
                ttl: 1,
                proxied: false,
              },
            ],
          }),
        };
      });

      global.fetch = fetchMock;

      const record = await cloudflareDnsProvider.upsertRecord(
        { apiToken: "test-token" },
        "zone_123",
        {
          type: "A",
          name: "app.example.com",
          content: "203.0.113.5",
          proxied: false,
        },
      );

      expect(record).toEqual({
        id: "rec_existing_456",
        zoneId: "zone_123",
        type: "A",
        name: "app.example.com",
        content: "203.0.113.5",
        ttl: 1,
        proxied: false,
      });
    });
  });

  describe("deleteRecord", () => {
    it("deletes existing record and handles 404 idempotently", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "Record not found" }],
          messages: [],
          result: null,
        }),
      } as Response);

      // Should not throw on 404
      await expect(
        cloudflareDnsProvider.deleteRecord({ apiToken: "test-token" }, "zone_123", "rec_gone"),
      ).resolves.toBeUndefined();
    });
  });
});
