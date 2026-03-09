export const CLI_PACKAGE_NAME = "@orqis/cli";

export function getCliBanner(): string {
  return "Orqis CLI";
}

export {
  DEFAULT_ORQIS_CONFIG,
  ORQIS_CONFIG_DIR_ENV_VAR,
  ORQIS_CONFIG_FILE_NAME,
  bootstrapOrqisConfig,
  resolveOrqisConfigDir,
  type BootstrapOrqisConfigResult,
  type BootstrapStatus,
} from "./config.js";

export {
  isCliEntrypoint,
  runCli,
  startOrqisInitSession,
  waitForRuntimeShutdown,
  waitForWebRuntimeHealth,
  type OrqisInitSession,
  type WaitForWebRuntimeHealthOptions,
} from "./cli.js";
