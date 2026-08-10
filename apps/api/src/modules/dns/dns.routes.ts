/**
 * DNS provider routes.
 *
 * Gated on `settings:*` — a DNS credential is one org-wide infrastructure record,
 * the same shape as the edge and email settings next to it, and it is read and
 * written from the Settings page. `domain:*` is the wrong root: those tags are
 * per-domain-resource (`domain:read` on `/domains/:id`), and one token is not
 * scoped to one domain.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./dns.controller";
import { AddDnsCredentialBody, VerifyZoneBody } from "./dns.schema";

const r = secureRouter(new Hono(), {
  module: "dns",
  basePath: "/api/dns",
});

r.get(
  "/providers",
  { tag: "settings:read", mcp: { description: "List supported DNS providers and the token scopes they need." } },
  ctrl.listProviders,
);
r.get(
  "/credentials",
  { tag: "settings:read", mcp: { description: "List connected DNS provider credentials for the org." } },
  ctrl.listCredentials,
);
r.get(
  "/credentials/:id",
  { tag: "settings:read", mcp: { description: "Get one connected DNS provider credential." } },
  ctrl.getCredential,
);
r.post(
  "/credentials",
  {
    tag: "settings:admin",
    body: AddDnsCredentialBody,
    mcp: { description: "Connect a DNS provider credential (Cloudflare API token)." },
  },
  ctrl.addCredential,
);
r.delete(
  "/credentials/:id",
  { tag: "settings:admin", mcp: { description: "Disconnect a DNS provider credential." } },
  ctrl.removeCredential,
);
r.post(
  // POST to carry a hostname body, but genuinely side-effect free — see the
  // handler's note on why the credential-invalidating write moved out.
  "/verify-zone",
  {
    tag: "settings:read",
    readOnly: true,
    body: VerifyZoneBody,
    mcp: { description: "Check whether a connected DNS provider manages a hostname's zone." },
  },
  ctrl.verifyZone,
);

export const dnsRoutes = r.hono;
