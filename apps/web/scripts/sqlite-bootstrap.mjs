#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const betterSqliteDir = resolve(scriptDir, "../node_modules/better-sqlite3");
const pnpmStoreDir = resolve(scriptDir, "../../../node_modules/.pnpm");
const prebuildInstallEntrypoint = (() => {
  if (!existsSync(pnpmStoreDir)) {
    return undefined;
  }

  const prebuildDir = readdirSync(pnpmStoreDir).find((entry) =>
    entry.startsWith("prebuild-install@"),
  );

  if (prebuildDir === undefined) {
    return undefined;
  }

  return resolve(
    pnpmStoreDir,
    prebuildDir,
    "node_modules/prebuild-install/bin.js",
  );
})();
const doctorEntrypoint = resolve(scriptDir, "sqlite-doctor.mjs");

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

if (
  prebuildInstallEntrypoint === undefined ||
  !existsSync(prebuildInstallEntrypoint)
) {
  console.error(
    "SQLite bootstrap failed: missing better-sqlite3 dependencies. Run `pnpm install` first.",
  );
  printRecoverySteps();
  process.exit(1);
}

try {
  execFileSync(
    process.execPath,
    [
      prebuildInstallEntrypoint,
      "--verbose",
      "--runtime=node",
      `--target=${process.versions.node}`,
    ],
    {
      cwd: betterSqliteDir,
      stdio: "inherit",
    },
  );

  execFileSync(process.execPath, [doctorEntrypoint], {
    stdio: "inherit",
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("SQLite bootstrap failed.");
  console.error(`Reason: ${message}`);
  printRecoverySteps();
  process.exit(1);
}
