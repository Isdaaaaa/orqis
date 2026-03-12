export const RUN_LIFECYCLE_STATUSES = [
  "planned",
  "running",
  "waiting_approval",
  "done",
  "failed",
] as const;
export type RunLifecycleStatus = (typeof RUN_LIFECYCLE_STATUSES)[number];

export type RunStatus = RunLifecycleStatus;

const RUN_LIFECYCLE_TRANSITION_TARGETS = {
  planned: ["running", "waiting_approval", "failed"],
  running: ["waiting_approval", "done", "failed"],
  waiting_approval: ["running", "done", "failed"],
  done: [],
  failed: [],
} as const satisfies Readonly<
  Record<RunLifecycleStatus, readonly RunLifecycleStatus[]>
>;

export function createInitialRunStatus(): RunLifecycleStatus {
  return "planned";
}

export function isRunLifecycleStatus(value: string): value is RunLifecycleStatus {
  return (RUN_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

export function getAllowedRunLifecycleTransitions(
  from: RunLifecycleStatus,
): readonly RunLifecycleStatus[] {
  return RUN_LIFECYCLE_TRANSITION_TARGETS[from];
}

export function canTransitionRunLifecycle(
  from: RunLifecycleStatus,
  to: RunLifecycleStatus,
): boolean {
  if (from === to) {
    return true;
  }

  return getAllowedRunLifecycleTransitions(from).includes(to);
}
