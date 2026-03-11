import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCliEntrypoint,
  runCli,
  startOrqisInitSession,
  waitForWebRuntimeHealth,
} from "../src/cli.ts";
import {
  DEFAULT_ORQIS_CONFIG,
  ORQIS_CONFIG_DIR_ENV_VAR,
  ORQIS_CONFIG_FILE_NAME,
  ORQIS_CONFIG_SCHEMA_VERSION,
  assertDefaultMigrationChain,
  bootstrapOrqisConfig,
  resolveOrqisConfigDir,
} from "../src/config.ts";

const tempRoots: string[] = [];
const activeServers = new Set<Server>();
const ENFORCE_POSIX_PERMISSIONS = process.platform !== "win32";

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    activeServers.delete(server);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      activeServers.delete(server);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function createTestRuntime(
  options: {
    readonly healthStatusCode?: number;
    readonly healthPayload?: unknown;
  } = {},
): Promise<{
  baseUrl: string;
  healthUrl: string;
  stop(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(options.healthStatusCode ?? 200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        `${JSON.stringify(
          options.healthPayload ?? {
            service: "@orqis/web",
            status: "ok",
            uptimeMs: 1,
          },
        )}\n`,
      );
      return;
    }

    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("runtime ready");
  });

  activeServers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    stop: async () => {
      await closeServer(server);
    },
  };
}

function resolveFixturePath(fileName: string): string {
  return fileURLToPath(new URL(`./fixtures/${fileName}`, import.meta.url));
}

async function loadRealWebRuntimeStarter(): Promise<
  (options: {
    host: string;
    port: number;
    persistence?: {
      configDir?: string;
    };
  }) => Promise<{
    baseUrl: string;
    healthUrl: string;
    stop(): Promise<void>;
  }>
> {
  const moduleUrl = new URL("../../web/src/index.ts", import.meta.url);
  const runtimeModule = (await import(moduleUrl.href)) as {
    startOrqisWebRuntime: (options: {
      host: string;
      port: number;
      persistence?: {
        configDir?: string;
      };
    }) => Promise<{
      baseUrl: string;
      healthUrl: string;
      stop(): Promise<void>;
    }>;
  };
  return runtimeModule.startOrqisWebRuntime;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const server of [...activeServers]) {
    await closeServer(server);
  }

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orqis init config bootstrap", () => {
  it("declares a complete default migration chain", () => {
    expect(() => assertDefaultMigrationChain()).not.toThrow();
  });

  it("creates default config on first run", async () => {
    const configDir = await makeTempDir("orqis-init-create-");

    const result = await bootstrapOrqisConfig({ configDir });

    expect(result.status).toBe("created");
    expect(result.config).toEqual(DEFAULT_ORQIS_CONFIG);

    const saved = JSON.parse(
      await readFile(join(configDir, ORQIS_CONFIG_FILE_NAME), "utf8"),
    ) as unknown;

    expect(saved).toEqual(DEFAULT_ORQIS_CONFIG);
  });

  it("is idempotent when config already has all required keys", async () => {
    const configDir = await makeTempDir("orqis-init-idempotent-");

    await bootstrapOrqisConfig({ configDir });
    const second = await bootstrapOrqisConfig({ configDir });

    expect(second.status).toBe("unchanged");
    expect(second.config).toEqual(DEFAULT_ORQIS_CONFIG);
  });

  it("adds missing defaults and preserves user-defined values", async () => {
    const configDir = await makeTempDir("orqis-init-update-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    const existing = {
      runtime: {
        port: 4999,
      },
      custom: {
        token: "secret",
      },
    };

    await writeFile(`${configPath}`, `${JSON.stringify(existing, null, 2)}\n`);

    const result = await bootstrapOrqisConfig({ configDir });

    expect(result.status).toBe("updated");
    expect(result.config).toMatchObject({
      runtime: {
        host: DEFAULT_ORQIS_CONFIG.runtime.host,
        port: 4999,
      },
      tunnel: DEFAULT_ORQIS_CONFIG.tunnel,
      custom: {
        token: "secret",
      },
    });
  });

  it("fails fast when required config sections have invalid shape", async () => {
    const configDir = await makeTempDir("orqis-init-invalid-shape-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, '{"schemaVersion":1,"runtime":null}\n');

    await expect(
      bootstrapOrqisConfig({ configDir }),
    ).rejects.toThrowError(/"runtime" must be an object when provided/);
  });

  it.each([
    {
      label: "has invalid type",
      rawConfig: '{"schemaVersion":"1"}\n',
    },
    {
      label: "has invalid range",
      rawConfig: '{"schemaVersion":0}\n',
    },
  ])("fails fast when schemaVersion $label", async ({ rawConfig }) => {
    const configDir = await makeTempDir("orqis-init-invalid-schema-version-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, rawConfig);

    await expect(
      bootstrapOrqisConfig({ configDir }),
    ).rejects.toThrowError(/"schemaVersion" must be an integer >= 1/);
  });

  it("fails fast when schemaVersion is newer than this CLI supports", async () => {
    const configDir = await makeTempDir("orqis-init-unsupported-schema-version-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(
      `${configPath}`,
      `{"schemaVersion":${ORQIS_CONFIG_SCHEMA_VERSION + 1}}\n`,
    );

    await expect(
      bootstrapOrqisConfig({ configDir }),
    ).rejects.toThrowError(/"schemaVersion" is not supported by this CLI version/);
  });

  it("migrates schemaVersion 1 configs to the current default schema version", async () => {
    const configDir = await makeTempDir("orqis-init-default-schema-migrate-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(
      `${configPath}`,
      '{"schemaVersion":1,"runtime":{"host":"127.0.0.1","port":43110},"tunnel":{"providers":["cloudflare","ngrok"]}}\n',
    );

    const first = await bootstrapOrqisConfig({ configDir });

    expect(first.status).toBe("updated");
    expect(first.config.schemaVersion).toBe(ORQIS_CONFIG_SCHEMA_VERSION);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      schemaVersion?: number;
    };

    expect(saved.schemaVersion).toBe(ORQIS_CONFIG_SCHEMA_VERSION);

    const second = await bootstrapOrqisConfig({ configDir });
    expect(second.status).toBe("unchanged");
    expect(second.config.schemaVersion).toBe(ORQIS_CONFIG_SCHEMA_VERSION);
  });

  it("applies explicit schema migrations when targeting a newer schema", async () => {
    const configDir = await makeTempDir("orqis-init-schema-migrate-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(
      `${configPath}`,
      '{"schemaVersion":1,"legacyTunnelProvider":"cloudflare"}\n',
    );

    const result = await bootstrapOrqisConfig({
      configDir,
      targetSchemaVersion: 2,
      migrations: {
        1: (config) => {
          const legacyProvider = config.legacyTunnelProvider;

          if (typeof legacyProvider === "string") {
            config.tunnel = { providers: [legacyProvider] };
          }

          delete config.legacyTunnelProvider;
        },
      },
    });

    expect(result.status).toBe("updated");
    expect(result.config).toMatchObject({
      schemaVersion: 2,
      runtime: DEFAULT_ORQIS_CONFIG.runtime,
      tunnel: {
        providers: ["cloudflare"],
      },
    });
    expect(result.config).not.toHaveProperty("legacyTunnelProvider");
  });

  it("fails fast when a required migration handler is missing", async () => {
    const configDir = await makeTempDir("orqis-init-schema-migrate-missing-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, '{"schemaVersion":1}\n');

    await expect(
      bootstrapOrqisConfig({
        configDir,
        targetSchemaVersion: 2,
        migrations: {},
      }),
    ).rejects.toThrowError(
      /Config schema migrations are incomplete: missing handler for 1 -> 2\./,
    );
  });

  it("fails fast when config contains invalid JSON", async () => {
    const configDir = await makeTempDir("orqis-init-invalid-json-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, '{"schemaVersion":1,,}\n');

    await expect(
      bootstrapOrqisConfig({ configDir }),
    ).rejects.toThrowError(/Cannot parse config file at .*\. Fix invalid JSON and retry\./);
  });

  it("fails fast when config JSON root is not an object", async () => {
    const configDir = await makeTempDir("orqis-init-invalid-json-root-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, "[]\n");

    await expect(bootstrapOrqisConfig({ configDir })).rejects.toThrowError(
      /Config file must contain a JSON object\./,
    );
  });

  it("preserves non-parse syntax errors thrown by migrations", async () => {
    const configDir = await makeTempDir("orqis-init-migration-syntax-error-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, '{"schemaVersion":1}\n');

    await expect(
      bootstrapOrqisConfig({
        configDir,
        targetSchemaVersion: 2,
        migrations: {
          1: () => {
            throw new SyntaxError("migration failure");
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "SyntaxError",
      message: "migration failure",
    });
  });

  it("does not treat migration ENOENT errors as missing config files", async () => {
    const configDir = await makeTempDir("orqis-init-migration-enoent-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, '{"schemaVersion":1,"custom":{"keep":true}}\n');

    const migrationError = new Error(
      "missing migration fixture",
    ) as NodeJS.ErrnoException;
    migrationError.code = "ENOENT";

    await expect(
      bootstrapOrqisConfig({
        configDir,
        targetSchemaVersion: 2,
        migrations: {
          1: () => {
            throw migrationError;
          },
        },
      }),
    ).rejects.toBe(migrationError);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      custom?: { keep?: boolean };
      schemaVersion?: number;
    };

    expect(saved.custom?.keep).toBe(true);
    expect(saved.schemaVersion).toBe(1);
  });

  it("creates config artifacts with restrictive permissions", async () => {
    const rootDir = await makeTempDir("orqis-init-permissions-create-root-");
    const configDir = join(rootDir, "orqis-config");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await bootstrapOrqisConfig({ configDir });

    if (!ENFORCE_POSIX_PERMISSIONS) {
      await expect(stat(configDir)).resolves.toBeDefined();
      await expect(stat(configPath)).resolves.toBeDefined();
      return;
    }

    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("normalizes existing config permissions even when config content is unchanged", async () => {
    const configDir = await makeTempDir("orqis-init-permissions-normalize-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(
      `${configPath}`,
      `${JSON.stringify(DEFAULT_ORQIS_CONFIG, null, 2)}\n`,
      { mode: 0o664 },
    );

    if (!ENFORCE_POSIX_PERMISSIONS) {
      const result = await bootstrapOrqisConfig({ configDir });
      expect(result.status).toBe("unchanged");
      await expect(stat(configPath)).resolves.toBeDefined();
      return;
    }

    await chmod(configDir, 0o775);
    await chmod(configPath, 0o664);

    const result = await bootstrapOrqisConfig({ configDir });

    expect(result.status).toBe("unchanged");
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("resolves config dir from ORQIS_CONFIG_DIR when no option is passed", async () => {
    const configDir = await makeTempDir("orqis-init-env-dir-");

    vi.stubEnv(ORQIS_CONFIG_DIR_ENV_VAR, configDir);

    expect(resolveOrqisConfigDir()).toBe(configDir);

    const result = await bootstrapOrqisConfig();

    expect(result.status).toBe("created");
    expect(result.configDir).toBe(configDir);
  });
});

describe("orqis init runtime bootstrap", () => {
  it("retries health checks until the web runtime is ready", async () => {
    const fetchImpl = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response('{"status":"starting"}', {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            service: "@orqis/web",
            status: "ok",
            uptimeMs: 1,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
          },
        ),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForWebRuntimeHealth({
        url: "http://127.0.0.1:43110/health",
        fetchImpl,
        sleep,
        timeoutMs: 500,
      }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("aborts hanging health checks when the timeout is reached", async () => {
    const fetchImpl = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockImplementation((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (signal == null) {
            reject(new Error("missing abort signal"));
            return;
          }

          if (signal.aborted) {
            reject(new Error("health request aborted"));
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("health request aborted"));
            },
            { once: true },
          );
        });
      });
    const startedAt = Date.now();

    await expect(
      waitForWebRuntimeHealth({
        url: "http://127.0.0.1:43110/health",
        fetchImpl,
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrowError(/health request aborted/);

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:43110/health",
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
  });

  it("starts the runtime, waits for health, and returns URLs", async () => {
    const configDir = await makeTempDir("orqis-init-runtime-session-");
    let runtimeStopCalls = 0;
    let tunnelStopCalls = 0;

    const session = await startOrqisInitSession(
      {
        configDir,
      },
      {
        startWebRuntime: async () => {
          const runtime = await createTestRuntime();
          return {
            ...runtime,
            stop: async () => {
              runtimeStopCalls += 1;
              await runtime.stop();
            },
          };
        },
        startTunnel: async () => ({
          provider: "cloudflare",
          publicUrl: "https://orqis-127-0-0-1-43110.trycloudflare.com",
          metadata: {
            strategy: "cloudflare-first-fallback",
            attemptedProviders: ["cloudflare"],
          },
          stop: async () => {
            tunnelStopCalls += 1;
          },
        }),
      },
    );

    expect(session.status).toBe("created");
    expect(session.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.healthUrl).toBe(`${session.localUrl}/health`);
    expect(session.publicUrl).toBe(
      "https://orqis-127-0-0-1-43110.trycloudflare.com",
    );
    expect(session.tunnelProvider).toBe("cloudflare");
    expect(session.tunnelMetadata).toEqual({
      strategy: "cloudflare-first-fallback",
      attemptedProviders: ["cloudflare"],
    });

    await session.runtime.stop();
    expect(runtimeStopCalls).toBe(1);
    expect(tunnelStopCalls).toBe(1);
  });

  it("starts and stops the web runtime in a dedicated child process", async () => {
    const configDir = await makeTempDir("orqis-init-runtime-process-");
    let tunnelStopCalls = 0;

    const session = await startOrqisInitSession(
      {
        configDir,
      },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: "@orqis/web",
              status: "ok",
              uptimeMs: 1,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
        resolveWebRuntimeProcessEntrypoint: async () =>
          resolveFixturePath("web-runtime-ready.mjs"),
        startTunnel: async () => ({
          provider: "cloudflare",
          publicUrl: "https://orqis-runtime-process.trycloudflare.com",
          metadata: {
            strategy: "cloudflare-first-fallback",
            attemptedProviders: ["cloudflare"],
          },
          stop: async () => {
            tunnelStopCalls += 1;
          },
        }),
      },
    );

    expect(session.localUrl).toBe("http://127.0.0.1:43110");
    expect(session.healthUrl).toBe("http://127.0.0.1:43110/health");

    await session.runtime.stop();
    await session.runtime.stop();
    expect(tunnelStopCalls).toBe(1);
  });

  it("propagates the resolved config dir to dedicated runtime process startup", async () => {
    const configDir = await makeTempDir("orqis-init-runtime-process-config-dir-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });
    const tunnelStop = vi.fn(async () => {
      return;
    });

    vi.stubEnv("ORQIS_EXPECTED_CONFIG_DIR", configDir);

    const exitCode = await runCli(
      ["node", "orqis", "init", "--config-dir", configDir],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: "@orqis/web",
              status: "ok",
              uptimeMs: 1,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
        resolveWebRuntimeProcessEntrypoint: async () =>
          resolveFixturePath("web-runtime-ready-requires-config-dir.mjs"),
        startTunnel: async () => ({
          provider: "cloudflare",
          publicUrl: "https://orqis-runtime-config-dir.trycloudflare.com",
          metadata: {
            strategy: "cloudflare-first-fallback",
            attemptedProviders: ["cloudflare"],
          },
          stop: tunnelStop,
        }),
        waitForShutdown: async (runtime) => {
          await runtime.stop();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(tunnelStop).toHaveBeenCalledTimes(1);
  });

  it("uses --health-timeout-ms for dedicated runtime process readiness timeout", async () => {
    const configDir = await makeTempDir("orqis-init-runtime-process-timeout-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });
    const tunnelStop = vi.fn(async () => {
      return;
    });

    vi.stubEnv("ORQIS_TEST_RUNTIME_READY_DELAY_MS", "5500");

    const startedAt = Date.now();

    const exitCode = await runCli(
      [
        "node",
        "orqis",
        "init",
        "--config-dir",
        configDir,
        "--health-timeout-ms",
        "7000",
      ],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: "@orqis/web",
              status: "ok",
              uptimeMs: 1,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
        resolveWebRuntimeProcessEntrypoint: async () =>
          resolveFixturePath("web-runtime-delayed-ready.mjs"),
        startTunnel: async () => ({
          provider: "cloudflare",
          publicUrl: "https://orqis-runtime-delayed.trycloudflare.com",
          metadata: {
            strategy: "cloudflare-first-fallback",
            attemptedProviders: ["cloudflare"],
          },
          stop: tunnelStop,
        }),
        waitForShutdown: async (runtime) => {
          await runtime.stop();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_000);
  }, 20_000);

  it("surfaces dedicated runtime process startup errors as runtime launch failures", async () => {
    const configDir = await makeTempDir("orqis-init-runtime-process-error-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });

    const exitCode = await runCli(
      ["node", "orqis", "init", "--config-dir", configDir],
      {
        resolveWebRuntimeProcessEntrypoint: async () =>
          resolveFixturePath("web-runtime-start-error.mjs"),
      },
    );

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/port is already in use/),
    );
  });

  it("returns clear errors when the web runtime port is already in use", async () => {
    const configDir = await makeTempDir("orqis-init-port-in-use-");
    const occupiedRuntime = await createTestRuntime();
    const occupiedPort = Number.parseInt(
      new URL(occupiedRuntime.baseUrl).port,
      10,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });

    await writeFile(
      join(configDir, ORQIS_CONFIG_FILE_NAME),
      `${JSON.stringify(
        {
          ...DEFAULT_ORQIS_CONFIG,
          runtime: {
            host: "127.0.0.1",
            port: occupiedPort,
          },
        },
        null,
        2,
      )}\n`,
    );

    const exitCode = await runCli(
      ["node", "orqis", "init", "--config-dir", configDir],
      {
        startWebRuntime: async () => {
          const runtimeError = new Error("listen EADDRINUSE") as NodeJS.ErrnoException;
          runtimeError.code = "EADDRINUSE";
          throw runtimeError;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/port is already in use/),
    );

    await occupiedRuntime.stop();
  });

  it("stops the runtime and surfaces health-check timeout failures clearly", async () => {
    const configDir = await makeTempDir("orqis-init-health-failure-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });
    const stop = vi.fn(async () => {
      return;
    });
    const fetchImpl = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockImplementation((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (signal == null) {
            reject(new Error("missing abort signal"));
            return;
          }

          if (signal.aborted) {
            reject(new Error("health request aborted"));
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("health request aborted"));
            },
            { once: true },
          );
        });
      });

    const exitCode = await runCli(
      [
        "node",
        "orqis",
        "init",
        "--config-dir",
        configDir,
        "--health-timeout-ms",
        "50",
      ],
      {
        fetchImpl,
        startWebRuntime: async () => ({
          baseUrl: "http://127.0.0.1:43110",
          healthUrl: "http://127.0.0.1:43110/health",
          stop,
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/did not pass health checks/),
    );
  });

  it("stops the runtime and surfaces tunnel startup failures clearly", async () => {
    const configDir = await makeTempDir("orqis-init-tunnel-failure-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });
    const stop = vi.fn(async () => {
      return;
    });

    const exitCode = await runCli(
      ["node", "orqis", "init", "--config-dir", configDir],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: "@orqis/web",
              status: "ok",
              uptimeMs: 1,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
        startWebRuntime: async () => ({
          baseUrl: "http://127.0.0.1:43110",
          healthUrl: "http://127.0.0.1:43110/health",
          stop,
        }),
        startTunnel: async () => {
          throw {
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
          };
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /Tunnel could not start for http:\/\/127\.0\.0\.1:43110\. Tried providers \[cloudflare,ngrok\]/,
      ),
    );
  });

  it("stops the runtime when default tunnel adapters are disabled", async () => {
    const configDir = await makeTempDir("orqis-init-tunnel-default-failure-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });
    const stop = vi.fn(async () => {
      return;
    });

    vi.stubEnv("ORQIS_DISABLE_CLOUDFLARE_TUNNEL", "1");
    vi.stubEnv("ORQIS_DISABLE_NGROK_TUNNEL", "1");

    const exitCode = await runCli(
      ["node", "orqis", "init", "--config-dir", configDir],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: "@orqis/web",
              status: "ok",
              uptimeMs: 1,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
        startWebRuntime: async () => ({
          baseUrl: "http://127.0.0.1:43110",
          healthUrl: "http://127.0.0.1:43110/health",
          stop,
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /disabled by ORQIS_DISABLE_CLOUDFLARE_TUNNEL=1/,
      ),
    );
  });

  it("executes via `orqis init` command arguments and reports runtime readiness", async () => {
    const configDir = await makeTempDir("orqis-init-cli-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      return;
    });
    const tunnelStop = vi.fn(async () => {
      return;
    });

    const exitCode = await runCli(
      [
        "node",
        "orqis",
        "init",
        "--config-dir",
        configDir,
        "--health-timeout-ms",
        "1000",
      ],
      {
        startWebRuntime: async () => createTestRuntime(),
        startTunnel: async () => ({
          provider: "ngrok",
          publicUrl: "https://orqis-mobile.ngrok-free.app",
          metadata: {
            strategy: "cloudflare-first-fallback",
            attemptedProviders: ["cloudflare", "ngrok"],
          },
          stop: tunnelStop,
        }),
        waitForShutdown: async (runtime) => {
          await runtime.stop();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith("orqis init: created");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^local_url=http:\/\/127\.0\.0\.1:\d+$/),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^health_url=http:\/\/127\.0\.0\.1:\d+\/health$/),
    );
    expect(log).toHaveBeenCalledWith(
      "public_url=https://orqis-mobile.ngrok-free.app",
    );
    expect(log).toHaveBeenCalledWith("tunnel_provider=ngrok");
    expect(log).toHaveBeenCalledWith(
      "tunnel_strategy=cloudflare-first-fallback",
    );
    expect(log).toHaveBeenCalledWith(
      "tunnel_attempted_providers=cloudflare,ngrok",
    );
    expect(log).toHaveBeenCalledWith("web_runtime=ready");
    expect(tunnelStop).toHaveBeenCalledTimes(1);
  });

  it("smoke-tests bootstrap config generation, runtime boot, and URL output contract", async () => {
    const configDir = await makeTempDir("orqis-init-smoke-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      return;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });

    vi.stubEnv(
      "ORQIS_CLOUDFLARE_PUBLIC_URL",
      "https://orqis-smoke.trycloudflare.com",
    );
    vi.stubEnv("ORQIS_DISABLE_NGROK_TUNNEL", "1");

    const exitCode = await runCli(
      ["node", "orqis", "init", "--config-dir", configDir],
      {
        startWebRuntime: async (runtimeConfig) => {
          const startWebRuntime = await loadRealWebRuntimeStarter();
          return startWebRuntime({
            host: runtimeConfig.host,
            port: 0,
            persistence: runtimeConfig.persistence,
          });
        },
        waitForShutdown: async (runtime) => {
          await runtime.stop();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      runtime?: { host?: string; port?: number };
      schemaVersion?: number;
      tunnel?: { providers?: string[] };
    };

    expect(saved.schemaVersion).toBe(DEFAULT_ORQIS_CONFIG.schemaVersion);
    expect(saved.runtime).toEqual(DEFAULT_ORQIS_CONFIG.runtime);
    expect(saved.tunnel).toEqual(DEFAULT_ORQIS_CONFIG.tunnel);

    expect(log).toHaveBeenCalledWith("orqis init: created");
    expect(log).toHaveBeenCalledWith(`config_dir=${configDir}`);
    expect(log).toHaveBeenCalledWith(`config_file=${configPath}`);

    const localUrlCall = log.mock.calls.find(([value]) => {
      return (
        typeof value === "string" && value.startsWith("local_url=http://127.0.0.1:")
      );
    });
    const healthUrlCall = log.mock.calls.find(([value]) => {
      return (
        typeof value === "string" &&
        value.startsWith("health_url=http://127.0.0.1:")
      );
    });
    const localUrl = localUrlCall?.[0].replace("local_url=", "");
    const healthUrl = healthUrlCall?.[0].replace("health_url=", "");

    expect(localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(healthUrl).toBe(`${localUrl}/health`);
    expect(log).toHaveBeenCalledWith(
      "public_url=https://orqis-smoke.trycloudflare.com/",
    );
    expect(log).toHaveBeenCalledWith("tunnel_provider=cloudflare");
    expect(log).toHaveBeenCalledWith(
      "tunnel_strategy=cloudflare-first-fallback",
    );
    expect(log).toHaveBeenCalledWith(
      "tunnel_attempted_providers=cloudflare",
    );
    expect(log).toHaveBeenCalledWith("web_runtime=ready");
  }, 75_000);

  it("returns non-zero for invalid CLI arguments without throwing", async () => {
    const exitCode = await runCli(["node", "orqis", "bogus"]);

    expect(exitCode).toBe(1);
  });

  it("returns non-zero when init fails during config bootstrap", async () => {
    const configDir = await makeTempDir("orqis-init-cli-bootstrap-error-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });

    await writeFile(`${configPath}`, '{"schemaVersion":1,"runtime":null}\n');

    const exitCode = await runCli([
      "node",
      "orqis",
      "init",
      "--config-dir",
      configDir,
    ]);

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/"runtime" must be an object when provided/),
    );
  });
});

describe("CLI entrypoint detection", () => {
  it("detects symlinked entrypoint paths as the CLI entry module", () => {
    const modulePath = "/repo/apps/cli/dist/cli.js";
    const argvEntry = "/tmp/orqis";

    const resolvePath = (filePath: string): string => {
      if (filePath === argvEntry) {
        return modulePath;
      }

      return filePath;
    };

    expect(
      isCliEntrypoint(pathToFileURL(modulePath).href, argvEntry, resolvePath),
    ).toBe(true);
  });

  it("falls back to URL comparison when entrypoint resolution fails", () => {
    const argvEntry = "/tmp/orqis";
    const moduleUrl = pathToFileURL(argvEntry).href;

    const resolvePath = (): string => {
      throw new Error("realpath failed");
    };

    expect(isCliEntrypoint(moduleUrl, argvEntry, resolvePath)).toBe(true);
  });
});
