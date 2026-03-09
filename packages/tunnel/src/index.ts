export const TUNNEL_PACKAGE_NAME = "@orqis/tunnel";

export const DEFAULT_TUNNEL_PROVIDER_ORDER = ["cloudflare", "ngrok"] as const;
export const TUNNEL_STRATEGY = "cloudflare-first-fallback" as const;

export const ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR =
  "ORQIS_CLOUDFLARE_PUBLIC_URL";
export const ORQIS_NGROK_PUBLIC_URL_ENV_VAR = "ORQIS_NGROK_PUBLIC_URL";
export const ORQIS_DISABLE_CLOUDFLARE_TUNNEL_ENV_VAR =
  "ORQIS_DISABLE_CLOUDFLARE_TUNNEL";
export const ORQIS_DISABLE_NGROK_TUNNEL_ENV_VAR = "ORQIS_DISABLE_NGROK_TUNNEL";

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

interface StaticTunnelAdapterOptions {
  readonly provider: string;
  readonly disableEnvVar: string;
  readonly publicUrlEnvVar: string;
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function resolvePublicUrl(
  provider: string,
  publicUrlEnvVar: string,
): string {
  const configuredPublicUrl = process.env[publicUrlEnvVar]?.trim();

  if (configuredPublicUrl && configuredPublicUrl.length > 0) {
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

  throw new Error(
    `${provider} adapter requires ${publicUrlEnvVar} to be set until managed tunnel lifecycle is implemented.`,
  );
}

function createStaticTunnelAdapter(
  options: StaticTunnelAdapterOptions,
): TunnelAdapter {
  return {
    provider: options.provider,
    start: async (
      _startOptions: TunnelAdapterStartOptions,
    ): Promise<TunnelProviderSession> => {
      if (process.env[options.disableEnvVar] === "1") {
        throw new Error(
          `${options.provider} adapter disabled by ${options.disableEnvVar}=1.`,
        );
      }

      const publicUrl = resolvePublicUrl(
        options.provider,
        options.publicUrlEnvVar,
      );

      return {
        provider: options.provider,
        publicUrl,
        stop: async () => undefined,
      };
    },
  };
}

export function createCloudflareTunnelAdapter(): TunnelAdapter {
  return createStaticTunnelAdapter({
    provider: "cloudflare",
    disableEnvVar: ORQIS_DISABLE_CLOUDFLARE_TUNNEL_ENV_VAR,
    publicUrlEnvVar: ORQIS_CLOUDFLARE_PUBLIC_URL_ENV_VAR,
  });
}

export function createNgrokTunnelAdapter(): TunnelAdapter {
  return createStaticTunnelAdapter({
    provider: "ngrok",
    disableEnvVar: ORQIS_DISABLE_NGROK_TUNNEL_ENV_VAR,
    publicUrlEnvVar: ORQIS_NGROK_PUBLIC_URL_ENV_VAR,
  });
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
