export const CORE_PACKAGE_NAME = "@orqis/core";

export type RunStatus = "planned" | "running";

export function createInitialRunStatus(): RunStatus {
  return "planned";
}
