import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DB_MIGRATION_FILES = [
  "0001_project_workspace_schema.sql",
  "0002_agent_configuration.sql",
  "0003_task_assignments.sql",
] as const;

export type DbMigrationFileName = (typeof DB_MIGRATION_FILES)[number];

function currentModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveDbMigrationsDir(): string {
  const moduleDir = currentModuleDir();
  const candidates = [
    resolve(moduleDir, "../migrations"),
    resolve(moduleDir, "../../migrations"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Cannot resolve @orqis/db migration directory from ${moduleDir}. Expected one of: ${candidates.join(", ")}`,
  );
}

export async function readDbMigrationSql(
  fileName: DbMigrationFileName,
): Promise<string> {
  const migrationPath = join(resolveDbMigrationsDir(), fileName);
  return readFile(migrationPath, "utf8");
}
