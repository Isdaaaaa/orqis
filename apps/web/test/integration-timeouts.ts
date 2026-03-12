// Full-workspace CI runs these real persistence/runtime tests under enough contention
// that the original 75s budget is too tight for passing cases.
export const WORKSPACE_CI_INTEGRATION_TIMEOUT_MS = 180_000;
