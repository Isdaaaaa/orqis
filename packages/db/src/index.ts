export const DB_PACKAGE_NAME = "@orqis/db";

export interface SqliteConfig {
  readonly filename: string;
}

export function createDefaultSqliteConfig(): SqliteConfig {
  return { filename: "orqis.db" };
}

export * from "./migrations.js";
export * from "./schema.js";
