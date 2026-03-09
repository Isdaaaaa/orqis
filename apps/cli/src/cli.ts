#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bootstrapOrqisConfig } from "./config.js";

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = new Command();
  program.exitOverride();

  program
    .name("orqis")
    .description("Orqis CLI")
    .showHelpAfterError()
    .command("init")
    .description("Bootstrap Orqis local configuration")
    .option(
      "--config-dir <path>",
      "Use a custom config directory (defaults to ORQIS_CONFIG_DIR or ~/.orqis)",
    )
    .action(async (options: { configDir?: string }) => {
      const result = await bootstrapOrqisConfig({
        configDir: options.configDir,
      });

      console.log(`orqis init: ${result.status}`);
      console.log(`config_dir=${result.configDir}`);
      console.log(`config_file=${result.configFilePath}`);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : "Unknown CLI error.";
    console.error(message);
    return 1;
  }

  return 0;
}

type ResolveFilePath = (filePath: string) => string;

export function isCliEntrypoint(
  moduleUrl: string,
  argvEntry: string | undefined,
  resolveFilePath: ResolveFilePath = realpathSync,
): boolean {
  if (argvEntry === undefined) {
    return false;
  }

  try {
    return (
      resolveFilePath(fileURLToPath(moduleUrl)) === resolveFilePath(argvEntry)
    );
  } catch {
    return moduleUrl === pathToFileURL(argvEntry).href;
  }
}

const isEntrypoint = isCliEntrypoint(import.meta.url, process.argv[1]);

if (isEntrypoint) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
