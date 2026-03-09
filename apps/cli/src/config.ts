import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ORQIS_CONFIG_DIR_ENV_VAR = "ORQIS_CONFIG_DIR";
export const ORQIS_CONFIG_FILE_NAME = "config.json";

export const DEFAULT_ORQIS_CONFIG = {
  schemaVersion: 1,
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
