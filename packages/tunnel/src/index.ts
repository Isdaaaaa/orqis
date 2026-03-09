import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

export const TUNNEL_PACKAGE_NAME = "@orqis/tunnel";

export const DEFAULT_TUNNEL_PROVIDER_ORDER = ["cloudflare", "ngrok"] as const;
export const TUNNEL_STRATEGY = "cloudflare-first-fallback" as const;

export const ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR =
  "ORQIS_CLOUDFLARE_PUBLIC_URL";
export const ORQIS_NGROK_PUBLIC_URL_ENV_VAR = "ORQIS_NGROK_PUBLIC_URL";
export const ORQIS_DISABLE_CLOUDFLARE_TUNNEL_ENV_VAR =
  "ORQIS_DISABLE_CLOUDFLARE_TUNNEL";
export const ORQIS_DISABLE_NGROK_TUNNEL_ENV_VAR = "ORQIS_DISABLE_NGROK_TUNNEL";
export const ORQIS_CLOUDFLARED_BIN_ENV_VAR = "ORQIS_CLOUDFLARED_BIN";
export const ORQIS_NGROK_BIN_ENV_VAR = "ORQIS_NGROK_BIN";
export const ORQIS_NGROK_API_URL_ENV_VAR = "ORQIS_NGROK_API_URL";

const DEFAULT_TUNNEL_DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_TUNNEL_DISCOVERY_POLL_INTERVAL_MS = 100;
const DEFAULT_TUNNEL_PROCESS_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g;

type Sleep = (durationMs: number) => Promise<void>;
type FetchLike = typeof fetch;
type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface TunnelAdapterStartOptions {
  readonly localUrl: string;
}

export interface TunnelProviderSession {
  readonly provider: string;
  readonly publicUrl: string;
  stop(): Promise<void>;
}

export interface TunnelSessionMetadata {
  readonly strategy: typeof TUNNEL_STRATEGY;
  readonly attemptedProviders: readonly string[];
}

export interface TunnelSession extends TunnelProviderSession {
  readonly metadata: TunnelSessionMetadata;
}

export interface TunnelAdapter {
  readonly provider: string;
  start(options: TunnelAdapterStartOptions): Promise<TunnelProviderSession>;
}

export interface TunnelProviderFailure {
  readonly provider: string;
  readonly message: string;
}

export interface StartTunnelWithFallbackOptions {
  readonly localUrl: string;
  readonly providerOrder?: readonly string[];
  readonly adapters?: readonly TunnelAdapter[];
}

interface ManagedTunnelAdapterDependencies {
  readonly discoveryPollIntervalMs?: number;
  readonly discoveryTimeoutMs?: number;
  readonly sleep?: Sleep;
  readonly spawnProcess?: SpawnProcess;
}

export interface CloudflareTunnelAdapterDependencies
  extends ManagedTunnelAdapterDependencies {}

export interface NgrokTunnelAdapterDependencies
  extends ManagedTunnelAdapterDependencies {
  readonly fetchImpl?: FetchLike;
  readonly ngrokApiUrl?: string;
}

interface ProcessFailureState {
  spawnError: Error | undefined;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

interface ProcessFailureWatcher {
  readonly state: ProcessFailureState;
  dispose(): void;
}

interface ProcessOutputCollector {
  getAll(): string;
  getTail(limit?: number): string;
  dispose(): void;
}

export class TunnelStartError extends Error {
  readonly failures: readonly TunnelProviderFailure[];
  readonly attemptedProviders: readonly string[];

  constructor(
    failures: readonly TunnelProviderFailure[],
    attemptedProviders: readonly string[],
  ) {
    const details = failures.map((failure) => `${failure.provider}: ${failure.message}`);

    super(
      details.length > 0
        ? `No tunnel provider could start. ${details.join("; ")}`
        : "No tunnel provider could start.",
    );

    this.name = "TunnelStartError";
    this.failures = [...failures];
    this.attemptedProviders = [...attemptedProviders];
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function hasExited(childProcess: ChildProcess): boolean {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function normalizeProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeProviderOrder(providerOrder?: readonly string[]): string[] {
  const source = providerOrder ?? [...DEFAULT_TUNNEL_PROVIDER_ORDER];
  const normalized = source
    .filter((provider): provider is string => typeof provider === "string")
    .map((provider) => normalizeProviderName(provider))
    .filter((provider) => provider.length > 0);

  if (normalized.length === 0) {
    return [...DEFAULT_TUNNEL_PROVIDER_ORDER];
  }

  return [...new Set(normalized)];
}

function buildAdapterMap(adapters?: readonly TunnelAdapter[]): Map<string, TunnelAdapter> {
  const availableAdapters = adapters ?? [
    createCloudflareTunnelAdapter(),
    createNgrokTunnelAdapter(),
  ];

  const adapterMap = new Map<string, TunnelAdapter>();

  for (const adapter of availableAdapters) {
    adapterMap.set(normalizeProviderName(adapter.provider), adapter);
  }

  return adapterMap;
}

function parseConfiguredPublicUrl(
  provider: string,
  publicUrlEnvVar: string,
): string | undefined {
  const configuredPublicUrl = process.env[publicUrlEnvVar]?.trim();

  if (!configuredPublicUrl) {
    return undefined;
  }

  let parsedConfiguredUrl: URL;

  try {
    parsedConfiguredUrl = new URL(configuredPublicUrl);
  } catch {
    throw new Error(
      `${provider} adapter expected ${publicUrlEnvVar} to be a valid URL when provided.`,
    );
  }

  if (
    parsedConfiguredUrl.protocol !== "http:" &&
    parsedConfiguredUrl.protocol !== "https:"
  ) {
    throw new Error(
      `${provider} adapter expected ${publicUrlEnvVar} to use http or https.`,
    );
  }

  return parsedConfiguredUrl.toString();
}

function isLikelyLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  );
}

function parseCandidatePublicUrl(candidate: string): URL | undefined {
  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  if (isLikelyLocalHost(parsed.hostname)) {
    return undefined;
  }

  return parsed;
}

function collectUrlCandidates(text: string): URL[] {
  const matches = text.match(URL_PATTERN);

  if (matches === null) {
    return [];
  }

  const candidates: URL[] = [];

  for (const match of matches) {
    const parsed = parseCandidatePublicUrl(match);

    if (parsed) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function createProcessOutputCollector(
  childProcess: ChildProcess,
): ProcessOutputCollector {
  let combinedOutput = "";

  const appendOutput = (chunk: string | Buffer): void => {
    combinedOutput += chunk.toString();
  };

  if (childProcess.stdout !== null) {
    childProcess.stdout.on("data", appendOutput);
  }

  if (childProcess.stderr !== null) {
    childProcess.stderr.on("data", appendOutput);
  }

  return {
    getAll: (): string => combinedOutput,
    getTail: (limit = 300): string => {
      if (combinedOutput.length <= limit) {
        return combinedOutput;
      }

      return combinedOutput.slice(combinedOutput.length - limit);
    },
    dispose: () => {
      if (childProcess.stdout !== null) {
        childProcess.stdout.off("data", appendOutput);
      }

      if (childProcess.stderr !== null) {
        childProcess.stderr.off("data", appendOutput);
      }
    },
  };
}

function createProcessFailureWatcher(
  childProcess: ChildProcess,
): ProcessFailureWatcher {
  const state: ProcessFailureState = {
    spawnError: undefined,
    exited: false,
    exitCode: null,
    exitSignal: null,
  };

  const onError = (error: Error): void => {
    state.spawnError = error;
  };

  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
  };

  childProcess.on("error", onError);
  childProcess.on("exit", onExit);

  return {
    state,
    dispose: () => {
      childProcess.off("error", onError);
      childProcess.off("exit", onExit);
    },
  };
}

function createSpawnFailureError(
  provider: string,
  command: string,
  error: Error,
): Error {
  if (hasErrnoCode(error, "ENOENT")) {
    const binaryName = provider === "cloudflare" ? "cloudflared" : "ngrok";
    return new Error(
      `${provider} tunnel process failed to launch because "${command}" was not found. Install ${binaryName} and ensure it is on PATH.`,
    );
  }

  return new Error(
    `${provider} tunnel process failed to launch: ${getErrorMessage(error)}`,
  );
}

function createPrematureExitError(
  provider: string,
  outputTail: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const base =
    `${provider} tunnel process exited before exposing a public URL ` +
    `(code=${code ?? "null"}, signal=${signal ?? "none"}).`;

  if (outputTail.trim().length === 0) {
    return new Error(base);
  }

  return new Error(`${base} Last output: ${outputTail.trim()}`);
}

function readProcessFailure(
  provider: string,
  command: string,
  childProcess: ChildProcess,
  watcher: ProcessFailureWatcher,
  outputTail: string,
): Error | undefined {
  if (watcher.state.spawnError !== undefined) {
    return createSpawnFailureError(provider, command, watcher.state.spawnError);
  }

  if (!watcher.state.exited && !hasExited(childProcess)) {
    return undefined;
  }

  return createPrematureExitError(
    provider,
    outputTail,
    watcher.state.exitCode,
    watcher.state.exitSignal,
  );
}

async function stopTunnelProcess(
  childProcess: ChildProcess,
  provider: string,
  timeoutMs = DEFAULT_TUNNEL_PROCESS_STOP_TIMEOUT_MS,
): Promise<void> {
  if (hasExited(childProcess)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let done = false;

    const finish = (callback: () => void): void => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timeout);
      childProcess.off("error", onError);
      childProcess.off("exit", onExit);
      callback();
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    const onExit = (): void => {
      finish(resolve);
    };

    const timeout = setTimeout(() => {
      if (!hasExited(childProcess)) {
        childProcess.kill("SIGKILL");
      }

      finish(() => {
        reject(
          new Error(
            `${provider} tunnel process did not exit within ${timeoutMs}ms after SIGTERM.`,
          ),
        );
      });
    }, timeoutMs);

    timeout.unref?.();
    childProcess.once("error", onError);
    childProcess.once("exit", onExit);

    const sent = childProcess.kill("SIGTERM");

    if (!sent && !hasExited(childProcess)) {
      finish(() => {
        reject(new Error(`Failed to send SIGTERM to ${provider} tunnel process.`));
      });
    }
  });
}

function createManagedTunnelProviderSession(
  provider: string,
  publicUrl: string,
  childProcess: ChildProcess,
): TunnelProviderSession {
  let stopPromise: Promise<void> | undefined;

  return {
    provider,
    publicUrl,
    stop: async (): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopPromise = stopTunnelProcess(childProcess, provider);
      return stopPromise;
    },
  };
}

function findCloudflarePublicUrl(output: string): string | undefined {
  const candidates = collectUrlCandidates(output);

  for (const candidate of candidates) {
    const hostname = candidate.hostname.toLowerCase();

    if (
      hostname.endsWith("trycloudflare.com") ||
      hostname.endsWith("cfargotunnel.com")
    ) {
      return candidate.toString();
    }
  }

  return undefined;
}

function findNgrokPublicUrlFromOutput(output: string): string | undefined {
  const candidates = collectUrlCandidates(output);

  for (const candidate of candidates) {
    if (
      candidate.protocol === "https:" &&
      candidate.hostname.toLowerCase().includes("ngrok")
    ) {
      return candidate.toString();
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tunnelConfigTargetsLocalUrl(
  tunnelConfigAddr: string,
  localUrl: URL,
): boolean {
  const normalizedAddr = tunnelConfigAddr.trim();

  if (normalizedAddr.length === 0) {
    return false;
  }

  if (
    normalizedAddr === localUrl.href ||
    normalizedAddr === localUrl.origin ||
    normalizedAddr === localUrl.host ||
    normalizedAddr === localUrl.port
  ) {
    return true;
  }

  if (normalizedAddr.endsWith(`:${localUrl.port}`)) {
    return true;
  }

  try {
    const parsed = new URL(
      /^[a-z]+:\/\//i.test(normalizedAddr)
        ? normalizedAddr
        : `http://${normalizedAddr}`,
    );

    return parsed.port === localUrl.port;
  } catch {
    return false;
  }
}

function findNgrokPublicUrlFromApiPayload(
  payload: unknown,
  localUrl: string,
): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const tunnels = payload.tunnels;

  if (!Array.isArray(tunnels)) {
    return undefined;
  }

  const parsedLocalUrl = new URL(localUrl);
  const matchingCandidates: URL[] = [];
  const fallbackCandidates: URL[] = [];

  for (const tunnel of tunnels) {
    if (!isRecord(tunnel) || typeof tunnel.public_url !== "string") {
      continue;
    }

    const candidate = parseCandidatePublicUrl(tunnel.public_url);

    if (!candidate) {
      continue;
    }

    const config = isRecord(tunnel.config) ? tunnel.config : undefined;
    const configAddr =
      config && typeof config.addr === "string" ? config.addr : undefined;

    if (
      configAddr !== undefined &&
      tunnelConfigTargetsLocalUrl(configAddr, parsedLocalUrl)
    ) {
      matchingCandidates.push(candidate);
      continue;
    }

    if (configAddr === undefined) {
      matchingCandidates.push(candidate);
      continue;
    }

    fallbackCandidates.push(candidate);
  }

  const ordered =
    matchingCandidates.length > 0 ? matchingCandidates : fallbackCandidates;

  if (ordered.length === 0) {
    return undefined;
  }

  const secureCandidate = ordered.find((candidate) => candidate.protocol === "https:");
  const fallbackCandidate = ordered[0];

  return (secureCandidate ?? fallbackCandidate)?.toString();
}

function startTunnelProcess(
  provider: string,
  command: string,
  args: readonly string[],
  spawnProcess: SpawnProcess,
): ChildProcess {
  const childProcess = spawnProcess(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (childProcess.stdout === null || childProcess.stderr === null) {
    throw new Error(
      `${provider} tunnel process did not expose stdout/stderr pipes for URL discovery.`,
    );
  }

  return childProcess;
}

async function waitForCloudflarePublicUrl(
  options: {
    readonly command: string;
    readonly childProcess: ChildProcess;
    readonly discoveryPollIntervalMs: number;
    readonly provider: string;
    readonly sleep: Sleep;
    readonly timeoutMs: number;
  },
): Promise<string> {
  const outputCollector = createProcessOutputCollector(options.childProcess);
  const failureWatcher = createProcessFailureWatcher(options.childProcess);
  const deadline = Date.now() + options.timeoutMs;

  try {
    while (true) {
      const discoveredUrl = findCloudflarePublicUrl(outputCollector.getAll());

      if (discoveredUrl !== undefined) {
        return discoveredUrl;
      }

      const processFailure = readProcessFailure(
        options.provider,
        options.command,
        options.childProcess,
        failureWatcher,
        outputCollector.getTail(),
      );

      if (processFailure !== undefined) {
        throw processFailure;
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      await options.sleep(Math.min(options.discoveryPollIntervalMs, remainingMs));
    }

    const processFailure = readProcessFailure(
      options.provider,
      options.command,
      options.childProcess,
      failureWatcher,
      outputCollector.getTail(),
    );

    if (processFailure !== undefined) {
      throw processFailure;
    }

    const outputTail = outputCollector.getTail().trim();

    throw new Error(
      outputTail.length > 0
        ? `${options.provider} tunnel process did not report a public URL within ${options.timeoutMs}ms. Last output: ${outputTail}`
        : `${options.provider} tunnel process did not report a public URL within ${options.timeoutMs}ms.`,
    );
  } finally {
    failureWatcher.dispose();
    outputCollector.dispose();
  }
}

async function waitForNgrokPublicUrl(
  options: {
    readonly apiUrl: string;
    readonly command: string;
    readonly childProcess: ChildProcess;
    readonly discoveryPollIntervalMs: number;
    readonly fetchImpl: FetchLike;
    readonly localUrl: string;
    readonly provider: string;
    readonly sleep: Sleep;
    readonly timeoutMs: number;
  },
): Promise<string> {
  const outputCollector = createProcessOutputCollector(options.childProcess);
  const failureWatcher = createProcessFailureWatcher(options.childProcess);
  const deadline = Date.now() + options.timeoutMs;
  let lastDiscoveryError: unknown;

  try {
    while (true) {
      const processFailure = readProcessFailure(
        options.provider,
        options.command,
        options.childProcess,
        failureWatcher,
        outputCollector.getTail(),
      );

      if (processFailure !== undefined) {
        throw processFailure;
      }

      const outputDiscoveredUrl = findNgrokPublicUrlFromOutput(
        outputCollector.getAll(),
      );

      if (outputDiscoveredUrl !== undefined) {
        return outputDiscoveredUrl;
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        break;
      }

      const requestTimeoutMs = Math.max(
        1,
        Math.min(remainingMs, options.discoveryPollIntervalMs),
      );
      const abortController = new AbortController();
      const abortTimeout = setTimeout(() => {
        abortController.abort();
      }, requestTimeoutMs);

      try {
        const response = await options.fetchImpl(options.apiUrl, {
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
        const discoveredUrl = findNgrokPublicUrlFromApiPayload(
          payload,
          options.localUrl,
        );

        if (discoveredUrl !== undefined) {
          return discoveredUrl;
        }
      } catch (error) {
        lastDiscoveryError = error;
      } finally {
        clearTimeout(abortTimeout);
      }

      const remainingAfterAttemptMs = deadline - Date.now();

      if (remainingAfterAttemptMs <= 0) {
        break;
      }

      await options.sleep(
        Math.min(options.discoveryPollIntervalMs, remainingAfterAttemptMs),
      );
    }

    const processFailure = readProcessFailure(
      options.provider,
      options.command,
      options.childProcess,
      failureWatcher,
      outputCollector.getTail(),
    );

    if (processFailure !== undefined) {
      throw processFailure;
    }

    const outputTail = outputCollector.getTail().trim();
    const discoveryMessage =
      lastDiscoveryError === undefined
        ? "ngrok did not expose a public URL via its local API"
        : `ngrok public URL discovery failed: ${getErrorMessage(lastDiscoveryError)}`;

    throw new Error(
      outputTail.length > 0
        ? `${discoveryMessage}. Last output: ${outputTail}`
        : discoveryMessage,
    );
  } finally {
    failureWatcher.dispose();
    outputCollector.dispose();
  }
}

const defaultSpawnProcess: SpawnProcess = (
  command,
  args,
  options,
): ChildProcess => {
  return spawn(command, [...args], options);
};

export function createCloudflareTunnelAdapter(
  dependencies: CloudflareTunnelAdapterDependencies = {},
): TunnelAdapter {
  return {
    provider: "cloudflare",
    start: async (
      startOptions: TunnelAdapterStartOptions,
    ): Promise<TunnelProviderSession> => {
      if (process.env[ORQIS_DISABLE_CLOUDFLARE_TUNNEL_ENV_VAR] === "1") {
        throw new Error(
          `cloudflare adapter disabled by ${ORQIS_DISABLE_CLOUDFLARE_TUNNEL_ENV_VAR}=1.`,
        );
      }

      const configuredUrl = parseConfiguredPublicUrl(
        "cloudflare",
        ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR,
      );

      if (configuredUrl !== undefined) {
        return {
          provider: "cloudflare",
          publicUrl: configuredUrl,
          stop: async () => undefined,
        };
      }

      const command =
        process.env[ORQIS_CLOUDFLARED_BIN_ENV_VAR]?.trim() || "cloudflared";
      const spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
      const sleep = dependencies.sleep ?? delay;
      const discoveryTimeoutMs =
        dependencies.discoveryTimeoutMs ?? DEFAULT_TUNNEL_DISCOVERY_TIMEOUT_MS;
      const discoveryPollIntervalMs =
        dependencies.discoveryPollIntervalMs ??
        DEFAULT_TUNNEL_DISCOVERY_POLL_INTERVAL_MS;

      const childProcess = startTunnelProcess(
        "cloudflare",
        command,
        ["tunnel", "--url", startOptions.localUrl, "--no-autoupdate"],
        spawnProcess,
      );

      try {
        const publicUrl = await waitForCloudflarePublicUrl({
          command,
          childProcess,
          discoveryPollIntervalMs,
          provider: "cloudflare",
          sleep,
          timeoutMs: discoveryTimeoutMs,
        });

        return createManagedTunnelProviderSession(
          "cloudflare",
          publicUrl,
          childProcess,
        );
      } catch (error) {
        await stopTunnelProcess(childProcess, "cloudflare").catch(() => undefined);
        throw error;
      }
    },
  };
}

export function createNgrokTunnelAdapter(
  dependencies: NgrokTunnelAdapterDependencies = {},
): TunnelAdapter {
  return {
    provider: "ngrok",
    start: async (
      startOptions: TunnelAdapterStartOptions,
    ): Promise<TunnelProviderSession> => {
      if (process.env[ORQIS_DISABLE_NGROK_TUNNEL_ENV_VAR] === "1") {
        throw new Error(
          `ngrok adapter disabled by ${ORQIS_DISABLE_NGROK_TUNNEL_ENV_VAR}=1.`,
        );
      }

      const configuredUrl = parseConfiguredPublicUrl(
        "ngrok",
        ORQIS_NGROK_PUBLIC_URL_ENV_VAR,
      );

      if (configuredUrl !== undefined) {
        return {
          provider: "ngrok",
          publicUrl: configuredUrl,
          stop: async () => undefined,
        };
      }

      const command = process.env[ORQIS_NGROK_BIN_ENV_VAR]?.trim() || "ngrok";
      const spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
      const sleep = dependencies.sleep ?? delay;
      const fetchImpl = dependencies.fetchImpl ?? fetch;
      const discoveryTimeoutMs =
        dependencies.discoveryTimeoutMs ?? DEFAULT_TUNNEL_DISCOVERY_TIMEOUT_MS;
      const discoveryPollIntervalMs =
        dependencies.discoveryPollIntervalMs ??
        DEFAULT_TUNNEL_DISCOVERY_POLL_INTERVAL_MS;
      const ngrokApiUrl =
        dependencies.ngrokApiUrl ??
        process.env[ORQIS_NGROK_API_URL_ENV_VAR]?.trim() ??
        DEFAULT_NGROK_API_URL;

      const childProcess = startTunnelProcess(
        "ngrok",
        command,
        ["http", startOptions.localUrl, "--log", "stdout"],
        spawnProcess,
      );

      try {
        const publicUrl = await waitForNgrokPublicUrl({
          apiUrl: ngrokApiUrl,
          command,
          childProcess,
          discoveryPollIntervalMs,
          fetchImpl,
          localUrl: startOptions.localUrl,
          provider: "ngrok",
          sleep,
          timeoutMs: discoveryTimeoutMs,
        });

        return createManagedTunnelProviderSession("ngrok", publicUrl, childProcess);
      } catch (error) {
        await stopTunnelProcess(childProcess, "ngrok").catch(() => undefined);
        throw error;
      }
    },
  };
}

export async function startTunnelWithFallback(
  options: StartTunnelWithFallbackOptions,
): Promise<TunnelSession> {
  const providerOrder = normalizeProviderOrder(options.providerOrder);
  const adapterMap = buildAdapterMap(options.adapters);
  const failures: TunnelProviderFailure[] = [];
  const attemptedProviders: string[] = [];

  for (const provider of providerOrder) {
    attemptedProviders.push(provider);

    const adapter = adapterMap.get(provider);

    if (!adapter) {
      failures.push({
        provider,
        message: "provider adapter is not registered",
      });
      continue;
    }

    try {
      const session = await adapter.start({ localUrl: options.localUrl });

      return {
        provider: normalizeProviderName(session.provider),
        publicUrl: session.publicUrl,
        stop: session.stop,
        metadata: {
          strategy: TUNNEL_STRATEGY,
          attemptedProviders: [...attemptedProviders],
        },
      };
    } catch (error) {
      failures.push({
        provider,
        message: getErrorMessage(error),
      });
    }
  }

  throw new TunnelStartError(failures, attemptedProviders);
}
