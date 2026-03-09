import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDefaultSqliteConfig,
  DB_MIGRATION_FILES,
  DB_PACKAGE_NAME,
  resolveDbMigrationsDir,
} from "../src/index.ts";

describe("@orqis/db scaffold", () => {
  it("exports a stable package identifier", () => {
    expect(DB_PACKAGE_NAME).toBe("@orqis/db");
  });

  it("returns default sqlite config", () => {
    expect(createDefaultSqliteConfig()).toEqual({ filename: "orqis.db" });
  });

  it("resolves known migration files", () => {
    const migrationsDir = resolveDbMigrationsDir();

    for (const fileName of DB_MIGRATION_FILES) {
      expect(existsSync(join(migrationsDir, fileName))).toBe(true);
    }
  });
});
