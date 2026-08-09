import { z } from "zod";

export const addDnsCredentialSchema = z.object({
  provider: z.enum(["cloudflare"], {
    errorMap: () => ({ message: "Only 'cloudflare' is currently supported as a DNS provider." }),
  }),
  name: z.string().trim().min(1, "Name is required").max(100, "Name too long"),
  apiToken: z.string().trim().min(1, "API token is required"),
});

export type TAddDnsCredentialBody = z.infer<typeof addDnsCredentialSchema>;

export const verifyZoneSchema = z.object({
  hostname: z.string().trim().min(1, "Hostname is required"),
});

export type TVerifyZoneBody = z.infer<typeof verifyZoneSchema>;
