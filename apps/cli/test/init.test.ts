import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.ts";
import {
  DEFAULT_ORQIS_CONFIG,
  ORQIS_CONFIG_FILE_NAME,
  bootstrapOrqisConfig,
} from "../src/config.ts";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();

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
});
