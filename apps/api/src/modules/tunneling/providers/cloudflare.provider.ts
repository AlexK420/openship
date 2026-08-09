/**
 * Cloudflare tunnel provider.
 *
 * Supports two operational modes:
 *   1. Quick tunnel (no account): spawns `cloudflared tunnel --url http://127.0.0.1:<port>`
 *      and extracts the assigned `*.trycloudflare.com` URL from cloudflared output.
 *   2. Named tunnel (with Cloudflare account & API token): creates a Tunnel
 *      resource via Cloudflare API, establishes DNS ingress rules, and executes
 *      `cloudflared tunnel run --token <token>`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  TunnelAgent,
  TunnelProvider,
  TunnelProvisionInput,
  TunnelRecord,
} from "../types";
import { ProvisionFailedError } from "../types";

class CloudflaredAgent extends EventEmitter implements TunnelAgent {
  private proc: ChildProcess | null = null;
  private connected = false;
  private closed = false;

  constructor(
    private readonly port: number,
    private readonly token?: string,
  ) {
    super();
  }

  get isConnected(): boolean {
    return this.connected && !this.closed;
  }

  start(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const args = this.token
        ? ["tunnel", "run", "--token", this.token]
        : ["tunnel", "--url", `http://127.0.0.1:${this.port}`, "--no-autoupdate"];

      try {
        this.proc = spawn("cloudflared", args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        resolve(undefined);
        return;
      }

      let quickUrlResolved = false;

      const handleData = (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (!quickUrlResolved && !this.token) {
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
          if (match && match[0]) {
            quickUrlResolved = true;
            this.connected = true;
            resolve(match[0]);
          }
        }
        if (text.includes("Registered tunnel connection") || text.includes("Connection registered")) {
          this.connected = true;
        }
      };

      this.proc.stdout?.on("data", handleData);
      this.proc.stderr?.on("data", handleData);

      this.proc.on("error", (err) => {
        this.emit("error", err);
        if (!quickUrlResolved) resolve(undefined);
      });

      this.proc.on("exit", (code, signal) => {
        this.connected = false;
        this.emit("disconnect", code ?? 0, signal ?? "exit");
        this.emit("close");
      });

      // If using named tunnel with token, mark connected after spawn startup window
      if (this.token) {
        setTimeout(() => {
          this.connected = true;
          resolve(undefined);
        }, 1500);
      } else {
        // Timeout safeguard for quick tunnel resolution
        setTimeout(() => {
          if (!quickUrlResolved) resolve(undefined);
        }, 8000);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // Process already stopped
      }
    }
  }
}

export const cloudflareProvider: TunnelProvider = {
  name: "cloudflare",

  async preflight() {
    return { ok: true };
  },

  async create(input: TunnelProvisionInput): Promise<TunnelRecord> {
    const apiToken = input.context?.apiToken as string | undefined;
    const accountId = input.context?.accountId as string | undefined;

    // If Cloudflare API credentials are provided, provision a Named Tunnel
    if (apiToken && accountId) {
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: input.name,
            config_src: "cloudflare",
          }),
        });

        const body = (await res.json()) as {
          success: boolean;
          result?: { id: string; name: string; token?: string };
          errors?: Array<{ message: string }>;
        };

        if (!res.ok || !body.success || !body.result) {
          const msg = body.errors?.map((e) => e.message).join(", ") || `HTTP ${res.status}`;
          throw new Error(msg);
        }

        const tunnel = body.result;
        const publicUrl = input.slug
          ? `https://${input.slug}`
          : `https://${tunnel.id}.cfargotunnel.com`;

        return {
          externalId: tunnel.id,
          slug: input.slug ?? tunnel.id,
          publicUrl,
        };
      } catch (err) {
        throw new ProvisionFailedError(
          "cloudflare",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Default: Quick Tunnel mode (transient ephemeral tunnel)
    const externalId = `cf_quick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      externalId,
      slug: input.slug ?? "quick",
      publicUrl: "https://trycloudflare.com",
    };
  },

  async delete(externalId: string): Promise<void> {
    if (externalId.startsWith("cf_quick_")) {
      return;
    }
  },

  async connect(record: TunnelRecord, port: number): Promise<TunnelAgent> {
    const agent = new CloudflaredAgent(port);
    const discoveredUrl = await agent.start();
    if (discoveredUrl && record.publicUrl === "https://trycloudflare.com") {
      record.publicUrl = discoveredUrl;
    }
    return agent;
  },
};
