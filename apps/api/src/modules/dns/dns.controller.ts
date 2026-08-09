import type { Context } from "hono";
import { safeErrorMessage } from "@repo/core";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { describeDnsProviders } from "./registry";
import * as dnsService from "./dns-credential.service";
import type { TAddDnsCredentialBody, TVerifyZoneBody } from "./dns.schema";

/** GET /dns/providers — List supported DNS providers and their descriptors. */
export async function listProviders(c: Context) {
  return c.json({ data: describeDnsProviders() });
}

/** GET /dns/credentials — List connected DNS credentials for the active organization. */
export async function listCredentials(c: Context) {
  const ctx = getRequestContext(c);
  const credentials = await dnsService.listCredentials(ctx);
  return c.json({ data: credentials });
}

/** GET /dns/credentials/:id — Get one connected DNS credential. */
export async function getCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const cred = await dnsService.getCredential(ctx, id);
  if (!cred) {
    return c.json({ error: "DNS credential not found" }, 404);
  }
  return c.json({ data: cred });
}

/** POST /dns/credentials — Connect a new DNS provider credential. */
export async function addCredential(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TAddDnsCredentialBody>();
  try {
    const cred = await dnsService.addCredential(ctx, body);
    return c.json({ data: cred }, 201);
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/** DELETE /dns/credentials/:id — Remove a connected DNS credential. */
export async function removeCredential(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  try {
    await dnsService.removeCredential(ctx, id);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/** POST /dns/verify-zone — Test whether a connected DNS provider can manage a specific hostname. */
export async function verifyZone(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TVerifyZoneBody>();
  try {
    const match = await dnsService.findDnsManagerForHostname(ctx.organizationId, body.hostname);
    if (!match) {
      return c.json({
        matched: false,
        message: "No connected DNS provider manages this domain zone.",
      });
    }
    return c.json({
      matched: true,
      provider: match.provider.name,
      zoneName: match.zone.name,
      zoneId: match.zone.id,
    });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}
