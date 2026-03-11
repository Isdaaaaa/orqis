type Awaitable<T> = T | Promise<T>;

export const TASK_CLAIM_SERVICE_TASK_STATES = [
  "todo",
  "in_progress",
  "waiting_approval",
  "done",
  "failed",
  "blocked",
] as const;
export type TaskClaimServiceTaskState =
  (typeof TASK_CLAIM_SERVICE_TASK_STATES)[number];

export const TASK_CLAIMABLE_STATES = ["todo", "in_progress"] as const;
export type TaskClaimableState = (typeof TASK_CLAIMABLE_STATES)[number];

export const TASK_CLAIM_OWNER_TYPES = ["run", "agent", "user"] as const;
export type TaskClaimOwnerType = (typeof TASK_CLAIM_OWNER_TYPES)[number];

export const TASK_CLAIM_CONFLICT_CODES = [
  "task_execution_locked",
  "task_checked_out_by_another_run",
  "task_owned_by_another_actor",
] as const;
export type TaskClaimConflictCode = (typeof TASK_CLAIM_CONFLICT_CODES)[number];

export interface TaskClaimRecord {
  readonly id: string;
  readonly state: TaskClaimServiceTaskState;
  readonly lockOwnerType: TaskClaimOwnerType | null;
  readonly lockOwnerId: string | null;
  readonly lockAcquiredAt: string | null;
  readonly checkoutRunId: string | null;
  readonly executionRunId: string | null;
}

interface TaskClaimSnapshot {
  readonly state: TaskClaimServiceTaskState;
  readonly lockOwnerType: TaskClaimOwnerType | null;
  readonly lockOwnerId: string | null;
  readonly lockAcquiredAt: string | null;
  readonly checkoutRunId: string | null;
  readonly executionRunId: string | null;
}

export interface TaskClaimRepository {
  getTask(taskId: string): Awaitable<TaskClaimRecord | undefined>;
  compareAndSwapTaskClaim(
    taskId: string,
    expected: TaskClaimSnapshot,
    next: TaskClaimSnapshot,
  ): Awaitable<boolean>;
}

export interface TaskExecutionClaimInput {
  readonly taskId: string;
  readonly runId: string;
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
  readonly claimedAt?: string;
}

export interface TaskExecutionReleaseInput {
  readonly taskId: string;
  readonly runId: string;
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
}

export class TaskClaimValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class TaskClaimNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task "${taskId}" was not found.`);
    this.name = new.target.name;
  }
}

export class TaskClaimConflictError extends Error {
  readonly code: TaskClaimConflictCode;
  readonly taskId: string;
  readonly currentExecutionRunId: string | null;
  readonly currentCheckoutRunId: string | null;
  readonly currentOwnerType: TaskClaimOwnerType | null;
  readonly currentOwnerId: string | null;

  constructor(code: TaskClaimConflictCode, task: TaskClaimRecord) {
    super(describeConflict(code, task));
    this.name = new.target.name;
    this.code = code;
    this.taskId = task.id;
    this.currentExecutionRunId = task.executionRunId;
    this.currentCheckoutRunId = task.checkoutRunId;
    this.currentOwnerType = task.lockOwnerType;
    this.currentOwnerId = task.lockOwnerId;
  }
}

export interface TaskClaimService {
  claimTaskExecution(input: TaskExecutionClaimInput): Promise<TaskClaimRecord>;
  releaseTaskExecution(input: TaskExecutionReleaseInput): Promise<TaskClaimRecord>;
}

function describeConflict(
  code: TaskClaimConflictCode,
  task: TaskClaimRecord,
): string {
  switch (code) {
    case "task_execution_locked":
      return `Task "${task.id}" already has an active execution lock for run "${task.executionRunId}".`;
    case "task_checked_out_by_another_run":
      return `Task "${task.id}" is already checked out by run "${task.checkoutRunId}".`;
    case "task_owned_by_another_actor":
      return `Task "${task.id}" is already owned by ${task.lockOwnerType ?? "unknown"} "${task.lockOwnerId ?? "unknown"}".`;
  }
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TaskClaimValidationError(`${label} must be a non-empty string.`);
  }

  return normalized;
}

function normalizeOwnerType(ownerType: string): TaskClaimOwnerType {
  const normalized = normalizeRequiredString(ownerType, "ownerType");

  if (
    !(TASK_CLAIM_OWNER_TYPES as readonly string[]).includes(normalized)
  ) {
    throw new TaskClaimValidationError(
      `ownerType must be one of: ${TASK_CLAIM_OWNER_TYPES.join(", ")}.`,
    );
  }

  return normalized as TaskClaimOwnerType;
}

function toSnapshot(task: TaskClaimRecord): TaskClaimSnapshot {
  return {
    state: task.state,
    lockOwnerType: task.lockOwnerType,
    lockOwnerId: task.lockOwnerId,
    lockAcquiredAt: task.lockAcquiredAt,
    checkoutRunId: task.checkoutRunId,
    executionRunId: task.executionRunId,
  };
}

function applySnapshot(
  task: TaskClaimRecord,
  snapshot: TaskClaimSnapshot,
): TaskClaimRecord {
  return {
    ...task,
    ...snapshot,
  };
}

function snapshotsEqual(
  left: TaskClaimSnapshot,
  right: TaskClaimSnapshot,
): boolean {
  return (
    left.state === right.state &&
    left.lockOwnerType === right.lockOwnerType &&
    left.lockOwnerId === right.lockOwnerId &&
    left.lockAcquiredAt === right.lockAcquiredAt &&
    left.checkoutRunId === right.checkoutRunId &&
    left.executionRunId === right.executionRunId
  );
}

function isClaimableState(
  state: TaskClaimServiceTaskState,
): state is TaskClaimableState {
  return (TASK_CLAIMABLE_STATES as readonly string[]).includes(state);
}

function assertClaimableTask(task: TaskClaimRecord): void {
  if (isClaimableState(task.state)) {
    return;
  }

  throw new TaskClaimValidationError(
    `Task "${task.id}" cannot be claimed from state "${task.state}".`,
  );
}

function classifyClaimConflict(
  task: TaskClaimRecord,
  input: TaskExecutionClaimInput,
): TaskClaimConflictError | undefined {
  if (task.executionRunId !== null && task.executionRunId !== input.runId) {
    return new TaskClaimConflictError("task_execution_locked", task);
  }

  if (task.checkoutRunId !== null && task.checkoutRunId !== input.runId) {
    return new TaskClaimConflictError(
      "task_checked_out_by_another_run",
      task,
    );
  }

  if (
    task.lockOwnerType !== null ||
    task.lockOwnerId !== null
  ) {
    if (
      task.lockOwnerType !== input.ownerType ||
      task.lockOwnerId !== input.ownerId
    ) {
      return new TaskClaimConflictError("task_owned_by_another_actor", task);
    }
  }

  return undefined;
}

function classifyReleaseConflict(
  task: TaskClaimRecord,
  input: TaskExecutionReleaseInput,
): TaskClaimConflictError | undefined {
  if (task.executionRunId !== null && task.executionRunId !== input.runId) {
    return new TaskClaimConflictError("task_execution_locked", task);
  }

  if (task.checkoutRunId !== null && task.checkoutRunId !== input.runId) {
    return new TaskClaimConflictError(
      "task_checked_out_by_another_run",
      task,
    );
  }

  if (
    task.lockOwnerType !== null ||
    task.lockOwnerId !== null
  ) {
    if (
      task.lockOwnerType !== input.ownerType ||
      task.lockOwnerId !== input.ownerId
    ) {
      return new TaskClaimConflictError("task_owned_by_another_actor", task);
    }
  }

  return undefined;
}

function buildClaimSnapshot(
  task: TaskClaimRecord,
  input: TaskExecutionClaimInput,
): TaskClaimSnapshot {
  return {
    state: task.state === "todo" ? "in_progress" : task.state,
    lockOwnerType: input.ownerType,
    lockOwnerId: input.ownerId,
    lockAcquiredAt:
      task.lockAcquiredAt ?? input.claimedAt ?? new Date().toISOString(),
    checkoutRunId: input.runId,
    executionRunId: input.runId,
  };
}

function buildReleasedSnapshot(task: TaskClaimRecord): TaskClaimSnapshot {
  return {
    state: task.state,
    lockOwnerType: null,
    lockOwnerId: null,
    lockAcquiredAt: null,
    checkoutRunId: null,
    executionRunId: null,
  };
}

async function getTaskOrThrow(
  repository: TaskClaimRepository,
  taskId: string,
): Promise<TaskClaimRecord> {
  const task = await repository.getTask(taskId);

  if (task === undefined) {
    throw new TaskClaimNotFoundError(taskId);
  }

  return task;
}

class DefaultTaskClaimService implements TaskClaimService {
  constructor(private readonly repository: TaskClaimRepository) {}

  async claimTaskExecution(
    input: TaskExecutionClaimInput,
  ): Promise<TaskClaimRecord> {
    const normalizedInput = {
      taskId: normalizeRequiredString(input.taskId, "taskId"),
      runId: normalizeRequiredString(input.runId, "runId"),
      ownerType: normalizeOwnerType(input.ownerType),
      ownerId: normalizeRequiredString(input.ownerId, "ownerId"),
      claimedAt:
        input.claimedAt === undefined
          ? undefined
          : normalizeRequiredString(input.claimedAt, "claimedAt"),
    } satisfies TaskExecutionClaimInput;

    return await this.mutateTaskClaim(
      normalizedInput.taskId,
      (task) => {
        assertClaimableTask(task);

        const conflict = classifyClaimConflict(task, normalizedInput);

        if (conflict !== undefined) {
          throw conflict;
        }

        return buildClaimSnapshot(task, normalizedInput);
      },
    );
  }

  async releaseTaskExecution(
    input: TaskExecutionReleaseInput,
  ): Promise<TaskClaimRecord> {
    const normalizedInput = {
      taskId: normalizeRequiredString(input.taskId, "taskId"),
      runId: normalizeRequiredString(input.runId, "runId"),
      ownerType: normalizeOwnerType(input.ownerType),
      ownerId: normalizeRequiredString(input.ownerId, "ownerId"),
    } satisfies TaskExecutionReleaseInput;

    return await this.mutateTaskClaim(
      normalizedInput.taskId,
      (task) => {
        const conflict = classifyReleaseConflict(task, normalizedInput);

        if (conflict !== undefined) {
          throw conflict;
        }

        return buildReleasedSnapshot(task);
      },
    );
  }

  private async mutateTaskClaim(
    taskId: string,
    buildNextSnapshot: (task: TaskClaimRecord) => TaskClaimSnapshot,
  ): Promise<TaskClaimRecord> {
    let current = await getTaskOrThrow(this.repository, taskId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const expected = toSnapshot(current);
      const next = buildNextSnapshot(current);

      if (snapshotsEqual(expected, next)) {
        return current;
      }

      const updated = await this.repository.compareAndSwapTaskClaim(
        taskId,
        expected,
        next,
      );

      if (updated) {
        return applySnapshot(current, next);
      }

      current = await getTaskOrThrow(this.repository, taskId);

      if (snapshotsEqual(toSnapshot(current), next)) {
        return current;
      }
    }

    throw new TaskClaimValidationError(
      `Task "${taskId}" could not be updated because its claim state changed too many times.`,
    );
  }
}

export function createTaskClaimService(
  repository: TaskClaimRepository,
): TaskClaimService {
  return new DefaultTaskClaimService(repository);
}
