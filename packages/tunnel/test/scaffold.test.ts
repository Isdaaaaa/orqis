import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR,
  ORQIS_NGROK_PUBLIC_URL_ENV_VAR,
  TUNNEL_PACKAGE_NAME,
  TunnelStartError,
  type TunnelAdapter,
  createCloudflareTunnelAdapter,
  createNgrokTunnelAdapter,
  startTunnelWithFallback,
} from "../src/index.ts";

class FakeChildProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  emitStdout(text: string): void {
    this.stdout.write(text);
  }

  emitStderr(text: string): void {
    this.stderr.write(text);
  }

  emitSpawnError(error: Error): void {
    this.emit("error", error);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);

    if (typeof signal === "string") {
      this.signalCode = signal;
    }

    queueMicrotask(() => {
      this.emitExit(0, typeof signal === "string" ? signal : null);
    });

    return true;
  }
}

function createErrnoError(
  message: string,
  code: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("@orqis/tunnel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exports a stable package identifier", () => {
    expect(TUNNEL_PACKAGE_NAME).toBe("@orqis/tunnel");
  });

  it("starts cloudflare and auto-discovers the public URL from process output", async () => {
    const process = new FakeChildProcess();
    const spawnProcess = vi.fn(() => process.asChildProcess());

    const startPromise = createCloudflareTunnelAdapter({
      discoveryPollIntervalMs: 1,
      discoveryTimeoutMs: 200,
      sleep: async () => undefined,
      spawnProcess,
    }).start({
      localUrl: "http://127.0.0.1:43110",
    });

    process.emitStderr(
      "INF Requesting new quick Tunnel on trycloudflare.com...\n",
    );
    process.emitStderr("INF Tunnel URL: https://orqis-dev.trycloudflare.com\n");

    const session = await startPromise;

    expect(spawnProcess).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:43110", "--no-autoupdate"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(session.provider).toBe("cloudflare");
    expect(session.publicUrl).toBe("https://orqis-dev.trycloudflare.com/");

    await session.stop();
    expect(process.killSignals).toEqual(["SIGTERM"]);
  });

  it("starts ngrok and auto-discovers the public URL from ngrok API", async () => {
    const process = new FakeChildProcess();
    const spawnProcess = vi.fn(() => process.asChildProcess());
    const fetchImpl = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tunnels: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tunnels: [
              {
                public_url: "https://orqis-mobile.ngrok-free.app",
                proto: "https",
                config: {
                  addr: "http://127.0.0.1:43110",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
          },
        ),
      );

    const session = await createNgrokTunnelAdapter({
      discoveryPollIntervalMs: 1,
      discoveryTimeoutMs: 200,
      fetchImpl,
      ngrokApiUrl: "http://127.0.0.1:4040/api/tunnels",
      sleep: async () => undefined,
      spawnProcess,
    }).start({
      localUrl: "http://127.0.0.1:43110",
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "ngrok",
      ["http", "http://127.0.0.1:43110", "--log", "stdout"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(fetchImpl).toHaveBeenCalled();
    expect(session.provider).toBe("ngrok");
    expect(session.publicUrl).toBe("https://orqis-mobile.ngrok-free.app/");

    await session.stop();
    expect(process.killSignals).toEqual(["SIGTERM"]);
  });

  it("accepts optional cloudflare public URL override without spawning process", async () => {
    vi.stubEnv(
      ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR,
      "https://orqis-env.trycloudflare.com",
    );
    const spawnProcess = vi.fn();

    const session = await createCloudflareTunnelAdapter({
      spawnProcess,
    }).start({
      localUrl: "http://127.0.0.1:43110",
    });

    expect(session.publicUrl).toBe("https://orqis-env.trycloudflare.com/");
    expect(spawnProcess).not.toHaveBeenCalled();
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it("accepts optional ngrok public URL override without spawning process", async () => {
    vi.stubEnv(
      ORQIS_NGROK_PUBLIC_URL_ENV_VAR,
      "https://orqis-env.ngrok-free.app",
    );
    const spawnProcess = vi.fn();

    const session = await createNgrokTunnelAdapter({
      spawnProcess,
    }).start({
      localUrl: "http://127.0.0.1:43110",
    });

    expect(session.publicUrl).toBe("https://orqis-env.ngrok-free.app/");
    expect(spawnProcess).not.toHaveBeenCalled();
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it("surfaces a clear install error when cloudflared is missing", async () => {
    const process = new FakeChildProcess();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        process.emitSpawnError(
          createErrnoError("spawn cloudflared ENOENT", "ENOENT"),
        );
      });

      return process.asChildProcess();
    });

    await expect(
      createCloudflareTunnelAdapter({
        discoveryPollIntervalMs: 1,
        discoveryTimeoutMs: 200,
        sleep: async () => undefined,
        spawnProcess,
      }).start({
        localUrl: "http://127.0.0.1:43110",
      }),
    ).rejects.toThrowError(/Install cloudflared and ensure it is on PATH/);
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
