import {
  RUN_LIFECYCLE_STATUSES,
  canTransitionRunLifecycle,
  getAllowedRunLifecycleTransitions,
  type RunLifecycleStatus,
} from "./run-lifecycle.js";

type Awaitable<T> = T | Promise<T>;

export const APPROVAL_GUARDED_TASK_STATES = [
  "todo",
  "in_progress",
  "waiting_approval",
  "done",
  "failed",
  "blocked",
] as const;
export type ApprovalGuardedTaskState =
  (typeof APPROVAL_GUARDED_TASK_STATES)[number];

export const APPROVAL_GUARDED_RUN_STATUSES = RUN_LIFECYCLE_STATUSES;
export type ApprovalGuardedRunStatus = RunLifecycleStatus;

export const APPROVAL_GUARD_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "revision_requested",
  "resubmitted",
] as const;
export type ApprovalGuardApprovalStatus =
  (typeof APPROVAL_GUARD_APPROVAL_STATUSES)[number];

export const UNRESOLVED_APPROVAL_STATUSES = [
  "pending",
  "resubmitted",
] as const;
export type UnresolvedApprovalStatus =
  (typeof UNRESOLVED_APPROVAL_STATUSES)[number];

export interface ApprovalGuardRecord {
  readonly id: string;
  readonly status: ApprovalGuardApprovalStatus;
  readonly taskId: string | null;
  readonly runId: string | null;
}

export interface ApprovalGuardedTaskRecord {
  readonly id: string;
  readonly state: ApprovalGuardedTaskState;
}

export interface ApprovalGuardedRunRecord {
  readonly id: string;
  readonly status: ApprovalGuardedRunStatus;
}

export interface TaskTransitionInput {
  readonly taskId: string;
  readonly from: ApprovalGuardedTaskState;
  readonly to: ApprovalGuardedTaskState;
}

export interface RunTransitionInput {
  readonly runId: string;
  readonly from: ApprovalGuardedRunStatus;
  readonly to: ApprovalGuardedRunStatus;
}

export interface ApprovalGuardedTransitionRepository {
  getTask(taskId: string): Awaitable<ApprovalGuardedTaskRecord | undefined>;
  getRun(runId: string): Awaitable<ApprovalGuardedRunRecord | undefined>;
  listTaskApprovals(taskId: string): Awaitable<readonly ApprovalGuardRecord[]>;
  listRunApprovals(runId: string): Awaitable<readonly ApprovalGuardRecord[]>;
  compareAndSwapTaskState(
    taskId: string,
    expected: ApprovalGuardedTaskState,
    next: ApprovalGuardedTaskState,
  ): Awaitable<boolean>;
  compareAndSwapRunStatus(
    runId: string,
    expected: ApprovalGuardedRunStatus,
    next: ApprovalGuardedRunStatus,
  ): Awaitable<boolean>;
}

export class ApprovalGuardedTransitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ApprovalGuardedTransitionNotFoundError extends Error {
  readonly entityType: "task" | "run";
  readonly entityId: string;

  constructor(entityType: "task" | "run", entityId: string) {
    super(`${capitalize(entityType)} "${entityId}" was not found.`);
    this.name = new.target.name;
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

export const APPROVAL_GUARDED_TRANSITION_CONFLICT_CODES = [
  "task_transition_concurrent_update",
  "run_transition_concurrent_update",
] as const;
export type ApprovalGuardedTransitionConflictCode =
  (typeof APPROVAL_GUARDED_TRANSITION_CONFLICT_CODES)[number];

export class ApprovalGuardedTransitionConflictError extends Error {
  readonly code: ApprovalGuardedTransitionConflictCode;
  readonly entityType: "task" | "run";
  readonly entityId: string;
  readonly expectedFrom: string;
  readonly targetTo: string;
  readonly currentValue: string;

  constructor(input: {
    code: ApprovalGuardedTransitionConflictCode;
    entityType: "task" | "run";
    entityId: string;
    expectedFrom: string;
    targetTo: string;
    currentValue: string;
  }) {
    super(
      `${capitalize(input.entityType)} "${input.entityId}" changed from expected "${input.expectedFrom}" to "${input.currentValue}" before transition to "${input.targetTo}" could be applied.`,
    );
    this.name = new.target.name;
    this.code = input.code;
    this.entityType = input.entityType;
    this.entityId = input.entityId;
    this.expectedFrom = input.expectedFrom;
    this.targetTo = input.targetTo;
    this.currentValue = input.currentValue;
  }
}

export class ApprovalGuardedTransitionBlockedError extends Error {
  readonly code = "required_approvals_unresolved";
  readonly entityType: "task" | "run";
  readonly entityId: string;
  readonly from: string;
  readonly to: string;
  readonly blockingApprovalIds: readonly string[];

  constructor(input: {
    entityType: "task" | "run";
    entityId: string;
    from: string;
    to: string;
    blockingApprovalIds: readonly string[];
  }) {
    super(
      `${input.entityType} "${input.entityId}" cannot transition from "${input.from}" to "${input.to}" while approvals remain unresolved: ${input.blockingApprovalIds.join(", ")}.`,
    );
    this.name = new.target.name;
    this.entityType = input.entityType;
    this.entityId = input.entityId;
    this.from = input.from;
    this.to = input.to;
    this.blockingApprovalIds = input.blockingApprovalIds;
  }
}

export interface ApprovalGuardedTransitionService {
  transitionTask(input: TaskTransitionInput): Promise<ApprovalGuardedTaskRecord>;
  transitionRun(input: RunTransitionInput): Promise<ApprovalGuardedRunRecord>;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new ApprovalGuardedTransitionValidationError(
      `${label} must be a non-empty string.`,
    );
  }

  return normalized;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeRequiredString(value, "approval reference");
}

function normalizeTaskState(state: string): ApprovalGuardedTaskState {
  const normalized = normalizeRequiredString(state, "task transition state");

  if (
    !(APPROVAL_GUARDED_TASK_STATES as readonly string[]).includes(normalized)
  ) {
    throw new ApprovalGuardedTransitionValidationError(
      `task transition state must be one of: ${APPROVAL_GUARDED_TASK_STATES.join(", ")}.`,
    );
  }

  return normalized as ApprovalGuardedTaskState;
}

function normalizeRunStatus(state: string): ApprovalGuardedRunStatus {
  const normalized = normalizeRequiredString(state, "run transition status");

  if (
    !(APPROVAL_GUARDED_RUN_STATUSES as readonly string[]).includes(normalized)
  ) {
    throw new ApprovalGuardedTransitionValidationError(
      `run transition status must be one of: ${APPROVAL_GUARDED_RUN_STATUSES.join(", ")}.`,
    );
  }

  return normalized as ApprovalGuardedRunStatus;
}

function assertValidRunTransition(input: {
  readonly from: ApprovalGuardedRunStatus;
  readonly to: ApprovalGuardedRunStatus;
}): void {
  if (canTransitionRunLifecycle(input.from, input.to)) {
    return;
  }

  const allowedTargets = getAllowedRunLifecycleTransitions(input.from);
  const allowedList =
    allowedTargets.length > 0
      ? allowedTargets.join(", ")
      : "(terminal state with no outgoing transitions)";

  throw new ApprovalGuardedTransitionValidationError(
    `run transition from "${input.from}" to "${input.to}" is invalid. Allowed targets from "${input.from}": ${allowedList}.`,
  );
}

function normalizeApprovalStatus(status: string): ApprovalGuardApprovalStatus {
  const normalized = normalizeRequiredString(status, "approval.status");

  if (
    !(APPROVAL_GUARD_APPROVAL_STATUSES as readonly string[]).includes(
      normalized,
    )
  ) {
    throw new ApprovalGuardedTransitionValidationError(
      `approval.status must be one of: ${APPROVAL_GUARD_APPROVAL_STATUSES.join(", ")}.`,
    );
  }

  return normalized as ApprovalGuardApprovalStatus;
}

function normalizeApprovals(
  approvals: readonly ApprovalGuardRecord[],
): readonly ApprovalGuardRecord[] {
  return approvals.map((approval) => ({
    id: normalizeRequiredString(approval.id, "approval.id"),
    status: normalizeApprovalStatus(approval.status),
    taskId: normalizeOptionalString(approval.taskId),
    runId: normalizeOptionalString(approval.runId),
  }));
}

function isGuardedTransition(from: string, to: string): boolean {
  return from === "waiting_approval" && to !== "waiting_approval";
}

function isApprovalResolved(status: ApprovalGuardApprovalStatus): boolean {
  return !(UNRESOLVED_APPROVAL_STATUSES as readonly string[]).includes(status);
}

function findBlockingApprovals(
  approvals: readonly ApprovalGuardRecord[],
  entityType: "task" | "run",
  entityId: string,
): readonly ApprovalGuardRecord[] {
  return approvals.filter((approval) => {
    const relatedId = entityType === "task" ? approval.taskId : approval.runId;
    return relatedId === entityId && !isApprovalResolved(approval.status);
  });
}

async function getTaskOrThrow(
  repository: ApprovalGuardedTransitionRepository,
  taskId: string,
): Promise<ApprovalGuardedTaskRecord> {
  const task = await repository.getTask(taskId);

  if (task === undefined) {
    throw new ApprovalGuardedTransitionNotFoundError("task", taskId);
  }

  return {
    ...task,
    state: normalizeTaskState(task.state),
  };
}

async function getRunOrThrow(
  repository: ApprovalGuardedTransitionRepository,
  runId: string,
): Promise<ApprovalGuardedRunRecord> {
  const run = await repository.getRun(runId);

  if (run === undefined) {
    throw new ApprovalGuardedTransitionNotFoundError("run", runId);
  }

  return {
    ...run,
    status: normalizeRunStatus(run.status),
  };
}

function createConflictError(input: {
  entityType: "task" | "run";
  entityId: string;
  expectedFrom: string;
  targetTo: string;
  currentValue: string;
}): ApprovalGuardedTransitionConflictError {
  return new ApprovalGuardedTransitionConflictError({
    code:
      input.entityType === "task"
        ? "task_transition_concurrent_update"
        : "run_transition_concurrent_update",
    ...input,
  });
}

class DefaultApprovalGuardedTransitionService
  implements ApprovalGuardedTransitionService
{
  constructor(
    private readonly repository: ApprovalGuardedTransitionRepository,
  ) {}

  async transitionTask(
    input: TaskTransitionInput,
  ): Promise<ApprovalGuardedTaskRecord> {
    const normalizedInput = {
      taskId: normalizeRequiredString(input.taskId, "taskId"),
      from: normalizeTaskState(input.from),
      to: normalizeTaskState(input.to),
    } satisfies TaskTransitionInput;

    let current = await getTaskOrThrow(this.repository, normalizedInput.taskId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (current.state !== normalizedInput.from) {
        throw createConflictError({
          entityType: "task",
          entityId: normalizedInput.taskId,
          expectedFrom: normalizedInput.from,
          targetTo: normalizedInput.to,
          currentValue: current.state,
        });
      }

      if (current.state === normalizedInput.to) {
        return current;
      }

      const approvals = normalizeApprovals(
        await this.repository.listTaskApprovals(normalizedInput.taskId),
      );
      const blockingApprovals = isGuardedTransition(
        normalizedInput.from,
        normalizedInput.to,
      )
        ? findBlockingApprovals(approvals, "task", normalizedInput.taskId)
        : [];

      if (blockingApprovals.length > 0) {
        throw new ApprovalGuardedTransitionBlockedError({
          entityType: "task",
          entityId: normalizedInput.taskId,
          from: normalizedInput.from,
          to: normalizedInput.to,
          blockingApprovalIds: blockingApprovals.map((approval) => approval.id),
        });
      }

      if (normalizedInput.from === normalizedInput.to) {
        return current;
      }

      const updated = await this.repository.compareAndSwapTaskState(
        normalizedInput.taskId,
        normalizedInput.from,
        normalizedInput.to,
      );

      if (updated) {
        return {
          ...current,
          state: normalizedInput.to,
        };
      }

      current = await getTaskOrThrow(this.repository, normalizedInput.taskId);
    }

    throw createConflictError({
      entityType: "task",
      entityId: normalizedInput.taskId,
      expectedFrom: normalizedInput.from,
      targetTo: normalizedInput.to,
      currentValue: current.state,
    });
  }

  async transitionRun(
    input: RunTransitionInput,
  ): Promise<ApprovalGuardedRunRecord> {
    const normalizedInput = {
      runId: normalizeRequiredString(input.runId, "runId"),
      from: normalizeRunStatus(input.from),
      to: normalizeRunStatus(input.to),
    } satisfies RunTransitionInput;
    assertValidRunTransition(normalizedInput);

    let current = await getRunOrThrow(this.repository, normalizedInput.runId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (current.status !== normalizedInput.from) {
        throw createConflictError({
          entityType: "run",
          entityId: normalizedInput.runId,
          expectedFrom: normalizedInput.from,
          targetTo: normalizedInput.to,
          currentValue: current.status,
        });
      }

      if (current.status === normalizedInput.to) {
        return current;
      }

      const approvals = normalizeApprovals(
        await this.repository.listRunApprovals(normalizedInput.runId),
      );
      const blockingApprovals = isGuardedTransition(
        normalizedInput.from,
        normalizedInput.to,
      )
        ? findBlockingApprovals(approvals, "run", normalizedInput.runId)
        : [];

      if (blockingApprovals.length > 0) {
        throw new ApprovalGuardedTransitionBlockedError({
          entityType: "run",
          entityId: normalizedInput.runId,
          from: normalizedInput.from,
          to: normalizedInput.to,
          blockingApprovalIds: blockingApprovals.map((approval) => approval.id),
        });
      }

      if (normalizedInput.from === normalizedInput.to) {
        return current;
      }

      const updated = await this.repository.compareAndSwapRunStatus(
        normalizedInput.runId,
        normalizedInput.from,
        normalizedInput.to,
      );

      if (updated) {
        return {
          ...current,
          status: normalizedInput.to,
        };
      }

      current = await getRunOrThrow(this.repository, normalizedInput.runId);
    }

    throw createConflictError({
      entityType: "run",
      entityId: normalizedInput.runId,
      expectedFrom: normalizedInput.from,
      targetTo: normalizedInput.to,
      currentValue: current.status,
    });
  }
}

export function createApprovalGuardedTransitionService(
  repository: ApprovalGuardedTransitionRepository,
): ApprovalGuardedTransitionService {
  return new DefaultApprovalGuardedTransitionService(repository);
}
