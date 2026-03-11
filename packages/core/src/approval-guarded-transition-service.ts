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

export const APPROVAL_GUARDED_RUN_STATUSES = [
  "planned",
  "running",
  "waiting_approval",
  "done",
  "failed",
] as const;
export type ApprovalGuardedRunStatus =
  (typeof APPROVAL_GUARDED_RUN_STATUSES)[number];

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

export interface TaskTransitionGuardInput {
  readonly taskId: string;
  readonly from: ApprovalGuardedTaskState;
  readonly to: ApprovalGuardedTaskState;
  readonly approvals: readonly ApprovalGuardRecord[];
}

export interface RunTransitionGuardInput {
  readonly runId: string;
  readonly from: ApprovalGuardedRunStatus;
  readonly to: ApprovalGuardedRunStatus;
  readonly approvals: readonly ApprovalGuardRecord[];
}

export class ApprovalGuardedTransitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
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
  assertTaskTransitionAllowed(input: TaskTransitionGuardInput): void;
  assertRunTransitionAllowed(input: RunTransitionGuardInput): void;
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

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeRequiredString(value, "approval reference");
}

function normalizeTaskState(state: string): ApprovalGuardedTaskState {
  const normalized = normalizeRequiredString(state, "from/to");

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
  const normalized = normalizeRequiredString(state, "from/to");

  if (
    !(APPROVAL_GUARDED_RUN_STATUSES as readonly string[]).includes(normalized)
  ) {
    throw new ApprovalGuardedTransitionValidationError(
      `run transition status must be one of: ${APPROVAL_GUARDED_RUN_STATUSES.join(", ")}.`,
    );
  }

  return normalized as ApprovalGuardedRunStatus;
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

class DefaultApprovalGuardedTransitionService
  implements ApprovalGuardedTransitionService
{
  assertTaskTransitionAllowed(input: TaskTransitionGuardInput): void {
    const normalizedTaskId = normalizeRequiredString(input.taskId, "taskId");
    const normalizedFrom = normalizeTaskState(input.from);
    const normalizedTo = normalizeTaskState(input.to);

    if (!isGuardedTransition(normalizedFrom, normalizedTo)) {
      return;
    }

    const blockingApprovals = findBlockingApprovals(
      normalizeApprovals(input.approvals),
      "task",
      normalizedTaskId,
    );

    if (blockingApprovals.length === 0) {
      return;
    }

    throw new ApprovalGuardedTransitionBlockedError({
      entityType: "task",
      entityId: normalizedTaskId,
      from: normalizedFrom,
      to: normalizedTo,
      blockingApprovalIds: blockingApprovals.map((approval) => approval.id),
    });
  }

  assertRunTransitionAllowed(input: RunTransitionGuardInput): void {
    const normalizedRunId = normalizeRequiredString(input.runId, "runId");
    const normalizedFrom = normalizeRunStatus(input.from);
    const normalizedTo = normalizeRunStatus(input.to);

    if (!isGuardedTransition(normalizedFrom, normalizedTo)) {
      return;
    }

    const blockingApprovals = findBlockingApprovals(
      normalizeApprovals(input.approvals),
      "run",
      normalizedRunId,
    );

    if (blockingApprovals.length === 0) {
      return;
    }

    throw new ApprovalGuardedTransitionBlockedError({
      entityType: "run",
      entityId: normalizedRunId,
      from: normalizedFrom,
      to: normalizedTo,
      blockingApprovalIds: blockingApprovals.map((approval) => approval.id),
    });
  }
}

export function createApprovalGuardedTransitionService(): ApprovalGuardedTransitionService {
  return new DefaultApprovalGuardedTransitionService();
}
