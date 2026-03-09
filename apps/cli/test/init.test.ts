import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.ts";
import {
  DEFAULT_ORQIS_CONFIG,
  ORQIS_CONFIG_DIR_ENV_VAR,
  ORQIS_CONFIG_FILE_NAME,
  ORQIS_CONFIG_SCHEMA_VERSION,
  bootstrapOrqisConfig,
  resolveOrqisConfigDir,
} from "../src/config.ts";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orqis init config bootstrap", () => {
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
      }),
    ).rejects.toThrowError(/cannot migrate from 1 to 2; add migration handler/);
  });

  it("fails fast when config contains invalid JSON", async () => {
    const configDir = await makeTempDir("orqis-init-invalid-json-");
    const configPath = join(configDir, ORQIS_CONFIG_FILE_NAME);

    await writeFile(`${configPath}`, '{"schemaVersion":1,,}\n');

    await expect(
      bootstrapOrqisConfig({ configDir }),
    ).rejects.toThrowError(/Cannot parse config file at .*\. Fix invalid JSON and retry\./);
  });

  it("resolves config dir from ORQIS_CONFIG_DIR when no option is passed", async () => {
    const configDir = await makeTempDir("orqis-init-env-dir-");

    vi.stubEnv(ORQIS_CONFIG_DIR_ENV_VAR, configDir);

    expect(resolveOrqisConfigDir()).toBe(configDir);

    const result = await bootstrapOrqisConfig();

    expect(result.status).toBe("created");
    expect(result.configDir).toBe(configDir);
  });

  it("executes via `orqis init` command arguments", async () => {
    const configDir = await makeTempDir("orqis-init-cli-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      return;
    });

    const exitCode = await runCli([
      "node",
      "orqis",
      "init",
      "--config-dir",
      configDir,
    ]);

    expect(exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith("orqis init: created");
  });

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
