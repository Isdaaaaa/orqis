import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ORQIS_CONFIG_DIR_ENV_VAR = "ORQIS_CONFIG_DIR";
export const ORQIS_CONFIG_FILE_NAME = "config.json";
export const ORQIS_CONFIG_SCHEMA_VERSION = 1;
const ORQIS_CONFIG_BASELINE_SCHEMA_VERSION = 1;
const ORQIS_CONFIG_DIR_MODE = 0o700;
const ORQIS_CONFIG_FILE_MODE = 0o600;
const ENFORCE_POSIX_PERMISSIONS = process.platform !== "win32";

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

export type OrqisConfigMigration = (config: Record<string, unknown>) => void;

export const ORQIS_CONFIG_MIGRATIONS: Readonly<
  Record<number, OrqisConfigMigration>
> = Object.freeze({});

interface BootstrapOrqisConfigOptions {
  configDir?: string;
  targetSchemaVersion?: number;
  migrations?: Readonly<Record<number, OrqisConfigMigration>>;
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

function resolveTargetSchemaVersion(targetSchemaVersion?: number): number {
  if (targetSchemaVersion === undefined) {
    return ORQIS_CONFIG_SCHEMA_VERSION;
  }

  if (
    typeof targetSchemaVersion !== "number" ||
    !Number.isInteger(targetSchemaVersion) ||
    targetSchemaVersion < 1
  ) {
    throw new Error(
      `Invalid target schema version "${String(targetSchemaVersion)}". Expected integer >= 1.`,
    );
  }

  return targetSchemaVersion;
}

function createDefaultConfig(targetSchemaVersion: number): Record<string, unknown> {
  return {
    ...cloneValue(DEFAULT_ORQIS_CONFIG),
    schemaVersion: targetSchemaVersion,
  };
}

function assertCompleteMigrationChain(
  targetSchemaVersion: number,
  migrations: Readonly<Record<number, OrqisConfigMigration>>,
): void {
  for (
    let schemaVersion = ORQIS_CONFIG_BASELINE_SCHEMA_VERSION;
    schemaVersion < targetSchemaVersion;
    schemaVersion += 1
  ) {
    if (migrations[schemaVersion] === undefined) {
      throw new Error(
        `Config schema migrations are incomplete: missing handler for ${schemaVersion} -> ${schemaVersion + 1}.`,
      );
    }
  }
}

export function assertDefaultMigrationChain(): void {
  assertCompleteMigrationChain(
    ORQIS_CONFIG_SCHEMA_VERSION,
    ORQIS_CONFIG_MIGRATIONS,
  );
}

assertDefaultMigrationChain();

function throwConfigShapeError(
  configFilePath: string,
  keyPath: string,
  message: string,
): never {
  throw new Error(
    `Invalid config file at ${configFilePath}: "${keyPath}" ${message}. Fix or remove "${keyPath}" and retry.`,
  );
}

function parseSchemaVersion(
  config: Record<string, unknown>,
  configFilePath: string,
): number | undefined {
  const schemaVersion = config.schemaVersion;

  if (schemaVersion === undefined) {
    return undefined;
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

  return schemaVersion;
}

function resolveExistingSchemaVersion(
  config: Record<string, unknown>,
  configFilePath: string,
  targetSchemaVersion: number,
): number {
  const schemaVersion =
    parseSchemaVersion(config, configFilePath) ??
    ORQIS_CONFIG_BASELINE_SCHEMA_VERSION;

  if (schemaVersion > targetSchemaVersion) {
    throwConfigShapeError(
      configFilePath,
      "schemaVersion",
      `is not supported by this CLI version (max supported ${targetSchemaVersion}, received ${schemaVersion})`,
    );
  }

  return schemaVersion;
}

function applySchemaMigrations(
  config: Record<string, unknown>,
  configFilePath: string,
  schemaVersion: number,
  targetSchemaVersion: number,
  migrations: Readonly<Record<number, OrqisConfigMigration>>,
): boolean {
  let changed = false;
  let workingVersion = schemaVersion;

  while (workingVersion < targetSchemaVersion) {
    const migration = migrations[workingVersion];

    if (!migration) {
      throwConfigShapeError(
        configFilePath,
        "schemaVersion",
        `cannot migrate from ${workingVersion} to ${workingVersion + 1}; add migration handler`,
      );
    }

    migration(config);
    workingVersion += 1;
    config.schemaVersion = workingVersion;
    changed = true;
  }

  return changed;
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
  parseSchemaVersion(config, configFilePath);
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

function parseConfigContent(
  rawConfig: string,
  configFilePath: string,
): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Cannot parse config file at ${configFilePath}. Fix invalid JSON and retry.`,
      );
    }

    throw error;
  }

  if (!isRecord(parsed)) {
    throw new Error("Config file must contain a JSON object.");
  }

  return parsed;
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

async function normalizeConfigPermissions(
  configDir: string,
  configFilePath: string,
): Promise<void> {
  if (!ENFORCE_POSIX_PERMISSIONS) {
    return;
  }

  await chmod(configDir, ORQIS_CONFIG_DIR_MODE);

  try {
    await chmod(configFilePath, ORQIS_CONFIG_FILE_MODE);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
}

export async function bootstrapOrqisConfig(
  options: BootstrapOrqisConfigOptions = {},
): Promise<BootstrapOrqisConfigResult> {
  const targetSchemaVersion = resolveTargetSchemaVersion(
    options.targetSchemaVersion,
  );
  const migrations = options.migrations ?? ORQIS_CONFIG_MIGRATIONS;
  assertCompleteMigrationChain(targetSchemaVersion, migrations);
  const configDir = resolveOrqisConfigDir(options.configDir);
  const configFilePath = join(configDir, ORQIS_CONFIG_FILE_NAME);
  const defaultConfig = createDefaultConfig(targetSchemaVersion);

  await mkdir(
    configDir,
    ENFORCE_POSIX_PERMISSIONS
      ? { recursive: true, mode: ORQIS_CONFIG_DIR_MODE }
      : { recursive: true },
  );
  await normalizeConfigPermissions(configDir, configFilePath);

  let status: BootstrapStatus = "unchanged";
  let config = cloneValue(defaultConfig);

  let rawConfig: string | undefined;
  try {
    rawConfig = await readFile(configFilePath, "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      await writeFile(configFilePath, toConfigContent(config), {
        encoding: "utf8",
        ...(ENFORCE_POSIX_PERMISSIONS ? { mode: ORQIS_CONFIG_FILE_MODE } : {}),
      });
      status = "created";
    } else {
      throw error;
    }
  }

  if (rawConfig !== undefined) {
    config = parseConfigContent(rawConfig, configFilePath);
    const existingSchemaVersion = resolveExistingSchemaVersion(
      config,
      configFilePath,
      targetSchemaVersion,
    );
    const migrated = applySchemaMigrations(
      config,
      configFilePath,
      existingSchemaVersion,
      targetSchemaVersion,
      migrations,
    );
    validateExistingConfigShape(config, configFilePath);
    const updated = mergeMissingDefaults(config, cloneValue(defaultConfig));

    if (migrated || updated) {
      await writeFile(configFilePath, toConfigContent(config), {
        encoding: "utf8",
        ...(ENFORCE_POSIX_PERMISSIONS ? { mode: ORQIS_CONFIG_FILE_MODE } : {}),
      });
      status = "updated";
    }
  }

  await normalizeConfigPermissions(configDir, configFilePath);

  return {
    config,
    configDir,
    configFilePath,
    status,
  };
}
