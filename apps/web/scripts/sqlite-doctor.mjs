#!/usr/bin/env node

import BetterSqlite3 from "better-sqlite3";

const RECOVERY_COMMANDS = [
  "pnpm install",
  "pnpm run orqis:web:sqlite:bootstrap",
  "pnpm run orqis:web:sqlite:doctor",
];

function printRecoverySteps() {
  console.error("Recovery:");

  for (const [index, command] of RECOVERY_COMMANDS.entries()) {
    console.error(`  ${index + 1}. ${command}`);
  }
}

try {
  const database = new BetterSqlite3(":memory:");

  try {
    database.pragma("foreign_keys = ON");
    const row = database
      .prepare("SELECT sqlite_version() AS version")
      .get();

    console.log(
      `SQLite doctor passed: better-sqlite3 bindings are available (sqlite_version=${String((row ?? {}).version ?? "unknown")}).`,
    );
  } finally {
    database.close();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  console.error(
    "SQLite doctor failed: better-sqlite3 native bindings are unavailable.",
  );
  console.error(`Reason: ${message}`);
  printRecoverySteps();
  process.exitCode = 1;
}
