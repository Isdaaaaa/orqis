import { describe, expect, it } from "vitest";

import {
  createTaskClaimService,
  TaskClaimConflictError,
  type TaskClaimRecord,
  type TaskClaimRepository,
  TaskClaimValidationError,
} from "../src/index.ts";

interface TaskClaimSnapshot {
  readonly state: TaskClaimRecord["state"];
  readonly lockOwnerType: TaskClaimRecord["lockOwnerType"];
  readonly lockOwnerId: TaskClaimRecord["lockOwnerId"];
  readonly lockAcquiredAt: TaskClaimRecord["lockAcquiredAt"];
  readonly checkoutRunId: TaskClaimRecord["checkoutRunId"];
  readonly executionRunId: TaskClaimRecord["executionRunId"];
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

function createTask(
  overrides: Partial<TaskClaimRecord> = {},
): TaskClaimRecord {
  return {
    id: "task_1",
    state: "todo",
    lockOwnerType: null,
    lockOwnerId: null,
    lockAcquiredAt: null,
    checkoutRunId: null,
    executionRunId: null,
    ...overrides,
  };
}

class InMemoryTaskClaimRepository implements TaskClaimRepository {
  private readonly tasks = new Map<string, TaskClaimRecord>();

  compareAndSwapCalls = 0;
  onCompareAndSwap?:
    | ((
        taskId: string,
        expected: TaskClaimSnapshot,
        next: TaskClaimSnapshot,
        current: TaskClaimRecord,
      ) => boolean)
    | undefined;

  constructor(tasks: readonly TaskClaimRecord[]) {
    for (const task of tasks) {
      this.tasks.set(task.id, { ...task });
    }
  }

  async getTask(taskId: string): Promise<TaskClaimRecord | undefined> {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : { ...task };
  }

  async compareAndSwapTaskClaim(
    taskId: string,
    expected: TaskClaimSnapshot,
    next: TaskClaimSnapshot,
  ): Promise<boolean> {
    this.compareAndSwapCalls += 1;

    const current = this.tasks.get(taskId);

    if (current === undefined) {
      return false;
    }

    if (this.onCompareAndSwap?.(taskId, expected, next, { ...current }) === false) {
      return false;
    }

    if (!snapshotsEqual(toSnapshot(current), expected)) {
      return false;
    }

    this.tasks.set(taskId, {
      ...current,
      ...next,
    });

    return true;
  }

  replaceTask(task: TaskClaimRecord): void {
    this.tasks.set(task.id, { ...task });
  }
}

describe("task claim service", () => {
  it("claims an unowned task and promotes todo work to in_progress", async () => {
    const repository = new InMemoryTaskClaimRepository([createTask()]);
    const service = createTaskClaimService(repository);

    const claimed = await service.claimTaskExecution({
      taskId: "task_1",
      runId: "run_1",
      ownerType: "agent",
      ownerId: "backend_agent",
      claimedAt: "2026-03-11T01:02:03.000Z",
    });

    expect(claimed).toEqual(
      createTask({
        state: "in_progress",
        lockOwnerType: "agent",
        lockOwnerId: "backend_agent",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_1",
        executionRunId: "run_1",
      }),
    );
  });

  it("treats reclaims by the current owner and run as idempotent", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "in_progress",
        lockOwnerType: "agent",
        lockOwnerId: "backend_agent",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_1",
        executionRunId: "run_1",
      }),
    ]);
    const service = createTaskClaimService(repository);

    const claimed = await service.claimTaskExecution({
      taskId: "task_1",
      runId: "run_1",
      ownerType: "agent",
      ownerId: "backend_agent",
      claimedAt: "2026-03-11T09:00:00.000Z",
    });

    expect(claimed.lockAcquiredAt).toBe("2026-03-11T01:02:03.000Z");
    expect(repository.compareAndSwapCalls).toBe(0);
  });

  it("rejects claims from non-claimable task states", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "waiting_approval",
      }),
    ]);
    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "agent",
        ownerId: "backend_agent",
      }),
    ).rejects.toEqual(
      new TaskClaimValidationError(
        'Task "task_1" cannot be claimed from state "waiting_approval".',
      ),
    );
  });

  it("rejects run-owned claims whose ownerId does not match the runId", async () => {
    const repository = new InMemoryTaskClaimRepository([createTask()]);
    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "run",
        ownerId: "run_2",
      }),
    ).rejects.toEqual(
      new TaskClaimValidationError(
        "ownerId must equal runId when ownerType is run.",
      ),
    );
  });

  it("returns a deterministic execution-lock conflict when another run is active", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "in_progress",
        lockOwnerType: "agent",
        lockOwnerId: "frontend_agent",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_2",
        executionRunId: "run_2",
      }),
    ]);
    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "agent",
        ownerId: "backend_agent",
      }),
    ).rejects.toMatchObject({
      code: "task_execution_locked",
      currentExecutionRunId: "run_2",
      currentCheckoutRunId: "run_2",
      currentOwnerType: "agent",
      currentOwnerId: "frontend_agent",
    } satisfies Partial<TaskClaimConflictError>);
  });

  it("returns a deterministic checkout conflict before execution starts", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "in_progress",
        lockOwnerType: "user",
        lockOwnerId: "user_1",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_2",
        executionRunId: null,
      }),
    ]);
    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "agent",
        ownerId: "backend_agent",
      }),
    ).rejects.toMatchObject({
      code: "task_checked_out_by_another_run",
      currentExecutionRunId: null,
      currentCheckoutRunId: "run_2",
    } satisfies Partial<TaskClaimConflictError>);
  });

  it("returns a deterministic owner conflict when a different actor already owns the task", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "in_progress",
        lockOwnerType: "user",
        lockOwnerId: "user_1",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: null,
        executionRunId: null,
      }),
    ]);
    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "agent",
        ownerId: "backend_agent",
      }),
    ).rejects.toMatchObject({
      code: "task_owned_by_another_actor",
      currentOwnerType: "user",
      currentOwnerId: "user_1",
    } satisfies Partial<TaskClaimConflictError>);
  });

  it("reclassifies compare-and-swap races into the same deterministic conflict code", async () => {
    const repository = new InMemoryTaskClaimRepository([createTask()]);
    let compareAttempts = 0;
    repository.onCompareAndSwap = () => {
      compareAttempts += 1;

      if (compareAttempts !== 1) {
        return true;
      }

      repository.replaceTask(
        createTask({
          state: "in_progress",
          lockOwnerType: "agent",
          lockOwnerId: "frontend_agent",
          lockAcquiredAt: "2026-03-11T05:00:00.000Z",
          checkoutRunId: "run_2",
          executionRunId: "run_2",
        }),
      );

      return false;
    };

    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "agent",
        ownerId: "backend_agent",
      }),
    ).rejects.toMatchObject({
      code: "task_execution_locked",
      currentExecutionRunId: "run_2",
    } satisfies Partial<TaskClaimConflictError>);
  });

  it("returns a deterministic concurrent-update conflict after repeated compare-and-swap misses", async () => {
    const repository = new InMemoryTaskClaimRepository([createTask()]);
    let compareAttempts = 0;
    repository.onCompareAndSwap = () => {
      compareAttempts += 1;
      return false;
    };

    const service = createTaskClaimService(repository);

    await expect(
      service.claimTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "agent",
        ownerId: "backend_agent",
      }),
    ).rejects.toMatchObject({
      code: "task_claim_concurrent_update",
      currentExecutionRunId: null,
      currentCheckoutRunId: null,
    } satisfies Partial<TaskClaimConflictError>);

    expect(compareAttempts).toBe(3);
  });

  it("releases the execution claim when the same run and owner release it", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "in_progress",
        lockOwnerType: "agent",
        lockOwnerId: "backend_agent",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_1",
        executionRunId: "run_1",
      }),
    ]);
    const service = createTaskClaimService(repository);

    const released = await service.releaseTaskExecution({
      taskId: "task_1",
      runId: "run_1",
      ownerType: "agent",
      ownerId: "backend_agent",
    });

    expect(released).toEqual(
      createTask({
        state: "in_progress",
        lockOwnerType: "agent",
        lockOwnerId: "backend_agent",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_1",
        executionRunId: null,
      }),
    );
  });

  it("rejects run-owned releases whose ownerId does not match the runId", async () => {
    const repository = new InMemoryTaskClaimRepository([
      createTask({
        state: "in_progress",
        lockOwnerType: "run",
        lockOwnerId: "run_1",
        lockAcquiredAt: "2026-03-11T01:02:03.000Z",
        checkoutRunId: "run_1",
        executionRunId: "run_1",
      }),
    ]);
    const service = createTaskClaimService(repository);

    await expect(
      service.releaseTaskExecution({
        taskId: "task_1",
        runId: "run_1",
        ownerType: "run",
        ownerId: "run_2",
      }),
    ).rejects.toEqual(
      new TaskClaimValidationError(
        "ownerId must equal runId when ownerType is run.",
      ),
    );
  });
});
