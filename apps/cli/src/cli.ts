#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_ORQIS_CONFIG,
  bootstrapOrqisConfig,
} from "./config.js";

const DEFAULT_WEB_RUNTIME_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_WEB_RUNTIME_HEALTH_INTERVAL_MS = 100;

interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
}

interface WebRuntimeHandle {
  readonly baseUrl: string;
  readonly healthUrl: string;
  stop(): Promise<void>;
}

interface TunnelStartOptions {
  readonly localUrl: string;
  readonly providerOrder?: readonly string[];
}

interface TunnelSessionMetadata {
  readonly strategy: string;
  readonly attemptedProviders: readonly string[];
}

interface TunnelSession {
  readonly provider: string;
  readonly publicUrl: string;
  readonly metadata: TunnelSessionMetadata;
  stop(): Promise<void>;
}

interface TunnelProviderFailure {
  readonly provider: string;
  readonly message: string;
}

interface TunnelStartFailureError {
  readonly failures: readonly TunnelProviderFailure[];
  readonly attemptedProviders: readonly string[];
}

type ResolveFilePath = (filePath: string) => string;
type StartWebRuntime = (options: RuntimeConfig) => Promise<WebRuntimeHandle>;
type StartTunnel = (options: TunnelStartOptions) => Promise<TunnelSession>;
type FetchLike = typeof fetch;
type Sleep = (durationMs: number) => Promise<void>;

interface RunCliDependencies {
  bootstrapConfig?: typeof bootstrapOrqisConfig;
  startWebRuntime?: StartWebRuntime;
  startTunnel?: StartTunnel;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  waitForShutdown?: (runtime: WebRuntimeHandle) => Promise<void>;
}

export interface WaitForWebRuntimeHealthOptions {
  readonly fetchImpl?: FetchLike;
  readonly intervalMs?: number;
  readonly sleep?: Sleep;
  readonly timeoutMs?: number;
  readonly url: string;
}

export interface OrqisInitSession {
  readonly configDir: string;
  readonly configFilePath: string;
  readonly config: Record<string, unknown>;
  readonly status: "created" | "updated" | "unchanged";
  readonly localUrl: string;
  readonly healthUrl: string;
  readonly publicUrl: string;
  readonly tunnelProvider: string;
  readonly tunnelMetadata: TunnelSessionMetadata;
  readonly runtime: WebRuntimeHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrnoCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isTunnelStartFailureError(error: unknown): error is TunnelStartFailureError {
  if (!isRecord(error)) {
    return false;
  }

  return Array.isArray(error.failures) && Array.isArray(error.attemptedProviders);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveRuntimeConfig(config: Record<string, unknown>): RuntimeConfig {
  const runtime = isRecord(config.runtime) ? config.runtime : {};

  return {
    host:
      typeof runtime.host === "string"
        ? runtime.host
        : DEFAULT_ORQIS_CONFIG.runtime.host,
    port:
      typeof runtime.port === "number"
        ? runtime.port
        : DEFAULT_ORQIS_CONFIG.runtime.port,
  };
}

function resolveTunnelProviderOrder(config: Record<string, unknown>): string[] {
  const defaultOrder = [...DEFAULT_ORQIS_CONFIG.tunnel.providers];
  const tunnel = isRecord(config.tunnel) ? config.tunnel : undefined;

  if (!tunnel || !Array.isArray(tunnel.providers)) {
    return defaultOrder;
  }

  const providers = tunnel.providers
    .filter((provider): provider is string => typeof provider === "string")
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => provider.length > 0);

  if (providers.length === 0) {
    return defaultOrder;
  }

  return [...new Set(providers)];
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function loadWebRuntimeStarter(): Promise<StartWebRuntime> {
  const moduleCandidates = [
    new URL("../../web/dist/index.js", import.meta.url),
    new URL("../../web/src/index.ts", import.meta.url),
  ];

  let lastError: unknown;

  for (const candidate of moduleCandidates) {
    try {
      const module = (await import(candidate.href)) as {
        startOrqisWebRuntime?: StartWebRuntime;
      };

      if (typeof module.startOrqisWebRuntime !== "function") {
        throw new Error(
          `Resolved ${candidate.pathname} but it does not export startOrqisWebRuntime().`,
        );
      }

      return module.startOrqisWebRuntime;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Cannot load the Orqis web runtime module. Build the workspace or run from the repository root. Last error: ${getErrorMessage(lastError)}`,
  );
}

async function loadTunnelStarter(): Promise<StartTunnel> {
  const moduleCandidates = [
    new URL("../../../packages/tunnel/dist/index.js", import.meta.url),
    new URL("../../../packages/tunnel/src/index.ts", import.meta.url),
  ];

  let lastError: unknown;

  for (const candidate of moduleCandidates) {
    try {
      const module = (await import(candidate.href)) as {
        startTunnelWithFallback?: StartTunnel;
      };

      if (typeof module.startTunnelWithFallback !== "function") {
        throw new Error(
          `Resolved ${candidate.pathname} but it does not export startTunnelWithFallback().`,
        );
      }

      return module.startTunnelWithFallback;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Cannot load the Orqis tunnel module. Build the workspace or run from the repository root. Last error: ${getErrorMessage(lastError)}`,
  );
}

async function startWebRuntimeWithDefaultModule(
  options: RuntimeConfig,
): Promise<WebRuntimeHandle> {
  const startWebRuntime = await loadWebRuntimeStarter();
  return startWebRuntime(options);
}

async function startTunnelWithDefaultModule(
  options: TunnelStartOptions,
): Promise<TunnelSession> {
  const startTunnel = await loadTunnelStarter();
  return startTunnel(options);
}

function formatRuntimeAddress(config: RuntimeConfig): string {
  return `http://${config.host}:${config.port}`;
}

function formatRuntimeLaunchError(
  error: unknown,
  config: RuntimeConfig,
): string {
  if (hasErrnoCode(error, "EADDRINUSE")) {
    return `Web runtime could not start on ${formatRuntimeAddress(config)} because the port is already in use. Free the port or change runtime.port in the Orqis config.`;
  }

  if (hasErrnoCode(error, "EACCES")) {
    return `Web runtime could not start on ${formatRuntimeAddress(config)} because access was denied. Choose a higher port or adjust host/port permissions.`;
  }

  return `Web runtime could not start on ${formatRuntimeAddress(config)}: ${getErrorMessage(error)}`;
}

function formatHealthCheckError(
  error: unknown,
  url: string,
  timeoutMs: number,
): string {
  return `Web runtime did not pass health checks at ${url} within ${timeoutMs}ms: ${getErrorMessage(error)}`;
}

function formatTunnelLaunchError(
  error: unknown,
  localUrl: string,
  providerOrder: readonly string[],
): string {
  const fallbackAttemptedProviders = providerOrder.join(",");

  if (!isTunnelStartFailureError(error)) {
    return `Tunnel could not start for ${localUrl}: ${getErrorMessage(error)}`;
  }

  const attemptedProviders =
    error.attemptedProviders.length > 0
      ? error.attemptedProviders.join(",")
      : fallbackAttemptedProviders;
  const failureSummary = error.failures
    .map((failure) => `${failure.provider}: ${failure.message}`)
    .join("; ");

  return `Tunnel could not start for ${localUrl}. Tried providers [${attemptedProviders}]: ${failureSummary}`;
}

function composeRuntimeWithTunnel(
  runtime: WebRuntimeHandle,
  tunnel: TunnelSession,
): WebRuntimeHandle {
  let stopPromise: Promise<void> | undefined;

  return {
    baseUrl: runtime.baseUrl,
    healthUrl: runtime.healthUrl,
    stop: async (): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopPromise = (async () => {
        let tunnelStopError: unknown;

        try {
          await tunnel.stop();
        } catch (error) {
          tunnelStopError = error;
        }

        try {
          await runtime.stop();
        } catch (error) {
          if (tunnelStopError !== undefined) {
            throw new Error(
              `Failed to stop tunnel (${getErrorMessage(tunnelStopError)}) and runtime (${getErrorMessage(error)}).`,
            );
          }

          throw error;
        }

        if (tunnelStopError !== undefined) {
          throw new Error(`Failed to stop tunnel: ${getErrorMessage(tunnelStopError)}`);
        }
      })();

      return stopPromise;
    },
  };
}

export async function waitForWebRuntimeHealth(
  options: WaitForWebRuntimeHealthOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.intervalMs ?? DEFAULT_WEB_RUNTIME_HEALTH_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_RUNTIME_HEALTH_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error(`timed out after ${timeoutMs}ms`);

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    const abortController = new AbortController();
    const requestTimeout = setTimeout(() => {
      abortController.abort();
    }, remainingMs);

    try {
      const response = await fetchImpl(options.url, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`received HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;

      if (
        !isRecord(payload) ||
        payload.status !== "ok" ||
        payload.service !== "@orqis/web"
      ) {
        throw new Error("returned an unexpected payload");
      }

      return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(requestTimeout);
    }

    const remainingAfterAttemptMs = deadline - Date.now();
    if (remainingAfterAttemptMs <= 0) {
      break;
    }

    await sleep(Math.min(intervalMs, remainingAfterAttemptMs));
  }

  throw new Error(getErrorMessage(lastError));
}

export async function startOrqisInitSession(
  options: {
    readonly configDir?: string;
    readonly healthTimeoutMs?: number;
  } = {},
  dependencies: RunCliDependencies = {},
): Promise<OrqisInitSession> {
  const bootstrapConfig = dependencies.bootstrapConfig ?? bootstrapOrqisConfig;
  const startWebRuntime =
    dependencies.startWebRuntime ?? startWebRuntimeWithDefaultModule;
  const startTunnel = dependencies.startTunnel ?? startTunnelWithDefaultModule;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const bootstrapResult = await bootstrapConfig({
    configDir: options.configDir,
  });
  const runtimeConfig = resolveRuntimeConfig(bootstrapResult.config);

  let runtime: WebRuntimeHandle;
  try {
    runtime = await startWebRuntime(runtimeConfig);
  } catch (error) {
    throw new Error(formatRuntimeLaunchError(error, runtimeConfig));
  }

  try {
    await waitForWebRuntimeHealth({
      url: runtime.healthUrl,
      timeoutMs: options.healthTimeoutMs,
      fetchImpl,
      sleep,
    });
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    throw new Error(
      formatHealthCheckError(
        error,
        runtime.healthUrl,
        options.healthTimeoutMs ?? DEFAULT_WEB_RUNTIME_HEALTH_TIMEOUT_MS,
      ),
    );
  }

  const providerOrder = resolveTunnelProviderOrder(bootstrapResult.config);

  let tunnel: TunnelSession;
  try {
    tunnel = await startTunnel({
      localUrl: runtime.baseUrl,
      providerOrder,
    });
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    throw new Error(formatTunnelLaunchError(error, runtime.baseUrl, providerOrder));
  }

  return {
    ...bootstrapResult,
    localUrl: runtime.baseUrl,
    healthUrl: runtime.healthUrl,
    publicUrl: tunnel.publicUrl,
    tunnelProvider: tunnel.provider,
    tunnelMetadata: tunnel.metadata,
    runtime: composeRuntimeWithTunnel(runtime, tunnel),
  };
}

export async function waitForRuntimeShutdown(
  runtime: WebRuntimeHandle,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      callback();
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      void runtime
        .stop()
        .then(() => {
          finish(resolve);
        })
        .catch((error) => {
          finish(() => reject(error));
        });

      if (signal === "SIGINT" || signal === "SIGTERM") {
        process.exitCode ??= 0;
      }
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export async function runCli(
  argv: string[] = process.argv,
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const program = new Command();
  program.exitOverride();

  program
    .name("orqis")
    .description("Orqis CLI")
    .showHelpAfterError()
    .command("init")
    .description("Bootstrap Orqis local configuration and start the web runtime")
    .option(
      "--config-dir <path>",
      "Use a custom config directory (defaults to ORQIS_CONFIG_DIR or ~/.orqis)",
    )
    .option(
      "--health-timeout-ms <ms>",
      "Override the web runtime health-check timeout",
      (value: string): number => {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("Health timeout must be an integer >= 1.");
        }

        return parsed;
      },
    )
    .action(
      async (options: { configDir?: string; healthTimeoutMs?: number }) => {
        const session = await startOrqisInitSession(
          {
            configDir: options.configDir,
            healthTimeoutMs: options.healthTimeoutMs,
          },
          dependencies,
        );

        console.log(`orqis init: ${session.status}`);
        console.log(`config_dir=${session.configDir}`);
        console.log(`config_file=${session.configFilePath}`);
        console.log(`local_url=${session.localUrl}`);
        console.log(`health_url=${session.healthUrl}`);
        console.log(`public_url=${session.publicUrl}`);
        console.log(`tunnel_provider=${session.tunnelProvider}`);
        console.log(`tunnel_strategy=${session.tunnelMetadata.strategy}`);
        console.log(
          `tunnel_attempted_providers=${session.tunnelMetadata.attemptedProviders.join(",")}`,
        );
        console.log("web_runtime=ready");

        const waitForShutdown =
          dependencies.waitForShutdown ?? waitForRuntimeShutdown;

        await waitForShutdown(session.runtime);
      },
    );

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : "Unknown CLI error.";
    console.error(message);
    return 1;
  }

  return 0;
}

export function isCliEntrypoint(
  moduleUrl: string,
  argvEntry: string | undefined,
  resolveFilePath: ResolveFilePath = realpathSync,
): boolean {
  if (argvEntry === undefined) {
    return false;
  }

  try {
    return (
      resolveFilePath(fileURLToPath(moduleUrl)) === resolveFilePath(argvEntry)
    );
  } catch {
    return moduleUrl === pathToFileURL(argvEntry).href;
  }
}

const isEntrypoint = isCliEntrypoint(import.meta.url, process.argv[1]);

if (isEntrypoint) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
