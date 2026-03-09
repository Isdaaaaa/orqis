import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR,
  ORQIS_NGROK_PUBLIC_URL_ENV_VAR,
  TUNNEL_PACKAGE_NAME,
  TunnelStartError,
  type TunnelAdapter,
  createCloudflareTunnelAdapter,
  startTunnelWithFallback,
} from "../src/index.ts";

describe("@orqis/tunnel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports a stable package identifier", () => {
    expect(TUNNEL_PACKAGE_NAME).toBe("@orqis/tunnel");
  });

  it("starts with Cloudflare first when a provider URL is configured", async () => {
    vi.stubEnv(
      ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR,
      "https://orqis-dev.trycloudflare.com",
    );

    const session = await startTunnelWithFallback({
      localUrl: "http://127.0.0.1:43110",
    });

    expect(session.provider).toBe("cloudflare");
    expect(session.publicUrl).toBe("https://orqis-dev.trycloudflare.com/");
    expect(session.metadata).toEqual({
      strategy: "cloudflare-first-fallback",
      attemptedProviders: ["cloudflare"],
    });

    await expect(session.stop()).resolves.toBeUndefined();
  });

  it("fails when no provider can provide a discovered public URL", async () => {
    await expect(
      startTunnelWithFallback({
        localUrl: "http://127.0.0.1:43110",
      }),
    ).rejects.toMatchObject({
      name: "TunnelStartError",
      attemptedProviders: ["cloudflare", "ngrok"],
      failures: [
        {
          provider: "cloudflare",
          message: expect.stringMatching(
            /requires ORQIS_CLOUDFLARE_PUBLIC_URL to be set/,
          ),
        },
        {
          provider: "ngrok",
          message: expect.stringMatching(
            /requires ORQIS_NGROK_PUBLIC_URL to be set/,
          ),
        },
      ],
    });
  });

  it("falls back to ngrok when Cloudflare has no configured URL", async () => {
    vi.stubEnv(
      ORQIS_NGROK_PUBLIC_URL_ENV_VAR,
      "https://orqis-mobile.ngrok-free.app",
    );

    const session = await startTunnelWithFallback({
      localUrl: "http://127.0.0.1:43110",
    });

    expect(session.provider).toBe("ngrok");
    expect(session.publicUrl).toBe("https://orqis-mobile.ngrok-free.app/");
    expect(session.metadata).toEqual({
      strategy: "cloudflare-first-fallback",
      attemptedProviders: ["cloudflare", "ngrok"],
    });
  });

  it("falls back to ngrok when the Cloudflare adapter fails", async () => {
    const cloudflareStart = vi.fn(async () => {
      throw new Error("cloudflare unavailable");
    });
    const ngrokStart = vi.fn(async () => ({
      provider: "ngrok",
      publicUrl: "https://demo.ngrok-free.app",
      stop: async () => undefined,
    }));

    const session = await startTunnelWithFallback({
      localUrl: "http://127.0.0.1:43110",
      adapters: [
        {
          provider: "cloudflare",
          start: cloudflareStart,
        },
        {
          provider: "ngrok",
          start: ngrokStart,
        },
      ],
    });

    expect(cloudflareStart).toHaveBeenCalledOnce();
    expect(ngrokStart).toHaveBeenCalledOnce();
    expect(session.provider).toBe("ngrok");
    expect(session.publicUrl).toBe("https://demo.ngrok-free.app");
    expect(session.metadata).toEqual({
      strategy: "cloudflare-first-fallback",
      attemptedProviders: ["cloudflare", "ngrok"],
    });
  });

  it("fails with per-provider diagnostics when every provider fails", async () => {
    const cloudflareAdapter: TunnelAdapter = {
      provider: "cloudflare",
      start: async () => {
        throw new Error("cloudflare unavailable");
      },
    };
    const ngrokAdapter: TunnelAdapter = {
      provider: "ngrok",
      start: async () => {
        throw new Error("ngrok unavailable");
      },
    };

    await expect(
      startTunnelWithFallback({
        localUrl: "http://127.0.0.1:43110",
        adapters: [cloudflareAdapter, ngrokAdapter],
      }),
    ).rejects.toMatchObject({
      name: "TunnelStartError",
      attemptedProviders: ["cloudflare", "ngrok"],
      failures: [
        {
          provider: "cloudflare",
          message: "cloudflare unavailable",
        },
        {
          provider: "ngrok",
          message: "ngrok unavailable",
        },
      ],
    });
  });

  it("uses configured provider order when provided", async () => {
    const cloudflareStart = vi.fn(async () => ({
      provider: "cloudflare",
      publicUrl: "https://cloudflare.example.com",
      stop: async () => undefined,
    }));
    const ngrokStart = vi.fn(async () => ({
      provider: "ngrok",
      publicUrl: "https://ngrok.example.com",
      stop: async () => undefined,
    }));

    const session = await startTunnelWithFallback({
      localUrl: "http://127.0.0.1:43110",
      providerOrder: ["ngrok", "cloudflare"],
      adapters: [
        {
          provider: "cloudflare",
          start: cloudflareStart,
        },
        {
          provider: "ngrok",
          start: ngrokStart,
        },
      ],
    });

    expect(ngrokStart).toHaveBeenCalledOnce();
    expect(cloudflareStart).not.toHaveBeenCalled();
    expect(session.provider).toBe("ngrok");
    expect(session.metadata.attemptedProviders).toEqual(["ngrok"]);
  });

  it("can be disabled via env var to force fallback behavior", async () => {
    vi.stubEnv("ORQIS_DISABLE_CLOUDFLARE_TUNNEL", "1");

    await expect(
      startTunnelWithFallback({
        localUrl: "http://127.0.0.1:43110",
        adapters: [createCloudflareTunnelAdapter()],
        providerOrder: ["cloudflare"],
      }),
    ).rejects.toBeInstanceOf(TunnelStartError);
  });
});
