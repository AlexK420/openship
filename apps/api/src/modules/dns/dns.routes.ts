import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./dns.controller";
import { addDnsCredentialSchema, verifyZoneSchema } from "./dns.schema";

const r = secureRouter(new Hono(), {
  module: "dns",
  basePath: "/api/dns",
});

r.get("/providers", { tag: "org:read", readOnly: true, mcp: { description: "List supported DNS providers." } }, ctrl.listProviders);
r.get("/credentials", { tag: "org:read", readOnly: true, mcp: { description: "List connected DNS credentials for the org." } }, ctrl.listCredentials);
r.get("/credentials/:id", { tag: "org:read", readOnly: true, mcp: { description: "Get one DNS credential details." } }, ctrl.getCredential);
r.post(
  "/credentials",
  {
    tag: "org:admin",
    body: addDnsCredentialSchema,
    mcp: { description: "Connect a DNS provider credential (Cloudflare API token)." },
  },
  ctrl.addCredential,
);
r.delete("/credentials/:id", { tag: "org:admin", mcp: { description: "Disconnect a DNS provider credential." } }, ctrl.removeCredential);
r.post(
  "/verify-zone",
  {
    tag: "org:read",
    readOnly: true,
    body: verifyZoneSchema,
    mcp: { description: "Check if a connected DNS provider manages a domain zone." },
  },
  ctrl.verifyZone,
);

export const dnsRoutes = r.hono;
