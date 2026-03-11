export const CORE_PACKAGE_NAME = "@orqis/core";

export type RunStatus = "planned" | "running";

export function createInitialRunStatus(): RunStatus {
  return "planned";
}

export * from "./approval-guarded-transition-service.js";
export * from "./specialist-agent-adapter-registry.js";
export * from "./task-claim-service.js";
