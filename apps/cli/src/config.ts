import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ORQIS_CONFIG_DIR_ENV_VAR = "ORQIS_CONFIG_DIR";
export const ORQIS_CONFIG_FILE_NAME = "config.json";
export const ORQIS_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_ORQIS_CONFIG = {
  schemaVersion: ORQIS_CONFIG_SCHEMA_VERSION,
  runtime: {
    host: "127.0.0.1",
    port: 43110,
  },
  tunnel: {
    providers: ["cloudflare", "ngrok"],
  },
} as const;

export type BootstrapStatus = "created" | "updated" | "unchanged";

export interface BootstrapOrqisConfigResult {
  configDir: string;
  configFilePath: string;
  config: Record<string, unknown>;
  status: BootstrapStatus;
}

interface BootstrapOrqisConfigOptions {
  configDir?: string;
}

export function resolveOrqisConfigDir(configDir?: string): string {
  if (configDir && configDir.trim().length > 0) {
    return configDir;
  }

  const fromEnv = process.env[ORQIS_CONFIG_DIR_ENV_VAR];

  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }

  return join(homedir(), ".orqis");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function throwConfigShapeError(
  configFilePath: string,
  keyPath: string,
  message: string,
): never {
  throw new Error(
    `Invalid config file at ${configFilePath}: "${keyPath}" ${message}. Fix or remove "${keyPath}" and retry.`,
  );
}

function validateSchemaVersionShape(
  config: Record<string, unknown>,
  configFilePath: string,
): void {
  const schemaVersion = config.schemaVersion;

  if (schemaVersion === undefined) {
    return;
  }

  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    throwConfigShapeError(
      configFilePath,
      "schemaVersion",
      `must be an integer >= 1 when provided (received ${valueType(schemaVersion)})`,
    );
  }

  if (schemaVersion > ORQIS_CONFIG_SCHEMA_VERSION) {
    throwConfigShapeError(
      configFilePath,
      "schemaVersion",
      `is not supported by this CLI version (max supported ${ORQIS_CONFIG_SCHEMA_VERSION}, received ${schemaVersion})`,
    );
  }
}

function validateRuntimeConfigShape(
  config: Record<string, unknown>,
  configFilePath: string,
): void {
  const runtime = config.runtime;

  if (runtime === undefined) {
    return;
  }

  if (!isRecord(runtime)) {
    throwConfigShapeError(
      configFilePath,
      "runtime",
      `must be an object when provided (received ${valueType(runtime)})`,
    );
  }

  const host = runtime.host;
  if (host !== undefined && typeof host !== "string") {
    throwConfigShapeError(
      configFilePath,
      "runtime.host",
      `must be a string when provided (received ${valueType(host)})`,
    );
  }

  const port = runtime.port;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535)
  ) {
    throwConfigShapeError(
      configFilePath,
      "runtime.port",
      `must be an integer between 1 and 65535 when provided (received ${valueType(port)})`,
    );
  }
}

function validateTunnelConfigShape(
  config: Record<string, unknown>,
  configFilePath: string,
): void {
  const tunnel = config.tunnel;

  if (tunnel === undefined) {
    return;
  }

  if (!isRecord(tunnel)) {
    throwConfigShapeError(
      configFilePath,
      "tunnel",
      `must be an object when provided (received ${valueType(tunnel)})`,
    );
  }

  const providers = tunnel.providers;

  if (providers === undefined) {
    return;
  }

  if (
    !Array.isArray(providers) ||
    providers.some((provider) => typeof provider !== "string")
  ) {
    throwConfigShapeError(
      configFilePath,
      "tunnel.providers",
      "must be an array of strings when provided",
    );
  }
}

function validateExistingConfigShape(
  config: Record<string, unknown>,
  configFilePath: string,
): void {
  validateSchemaVersionShape(config, configFilePath);
  validateRuntimeConfigShape(config, configFilePath);
  validateTunnelConfigShape(config, configFilePath);
}

function mergeMissingDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  let changed = false;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const existingValue = target[key];

    if (existingValue === undefined) {
      target[key] = cloneValue(defaultValue);
      changed = true;
      continue;
    }

    if (isRecord(existingValue) && isRecord(defaultValue)) {
      changed = mergeMissingDefaults(existingValue, defaultValue) || changed;
    }
  }

  return changed;
}

function toConfigContent(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function bootstrapOrqisConfig(
  options: BootstrapOrqisConfigOptions = {},
): Promise<BootstrapOrqisConfigResult> {
  const configDir = resolveOrqisConfigDir(options.configDir);
  const configFilePath = join(configDir, ORQIS_CONFIG_FILE_NAME);

  await mkdir(configDir, { recursive: true });

  let status: BootstrapStatus = "unchanged";
  let config = cloneValue(DEFAULT_ORQIS_CONFIG) as Record<string, unknown>;

  try {
    const rawConfig = await readFile(configFilePath, "utf8");
    const parsed = JSON.parse(rawConfig) as unknown;

    if (!isRecord(parsed)) {
      throw new Error("Config file must contain a JSON object.");
    }

    config = parsed;
    validateExistingConfigShape(config, configFilePath);
    const updated = mergeMissingDefaults(
      config,
      cloneValue(DEFAULT_ORQIS_CONFIG) as Record<string, unknown>,
    );

    if (updated) {
      await writeFile(configFilePath, toConfigContent(config), "utf8");
      status = "updated";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(configFilePath, toConfigContent(config), "utf8");
      status = "created";
    } else if (error instanceof SyntaxError) {
      throw new Error(
        `Cannot parse config file at ${configFilePath}. Fix invalid JSON and retry.`,
      );
    } else {
      throw error;
    }
  }

  return {
    config,
    configDir,
    configFilePath,
    status,
  };
}
