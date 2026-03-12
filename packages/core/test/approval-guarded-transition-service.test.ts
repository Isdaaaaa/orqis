import { describe, expect, it } from "vitest";

import {
  ApprovalGuardedTransitionBlockedError,
  ApprovalGuardedTransitionConflictError,
  createApprovalGuardedTransitionService,
  type ApprovalGuardedRunRecord,
  type ApprovalGuardedTaskRecord,
  type ApprovalGuardedTransitionRepository,
  type ApprovalGuardRecord,
} from "../src/index.ts";

function createTask(
  overrides: Partial<ApprovalGuardedTaskRecord> = {},
): ApprovalGuardedTaskRecord {
  return {
    id: "task_1",
    state: "todo",
    ...overrides,
  };
}

function createRun(
  overrides: Partial<ApprovalGuardedRunRecord> = {},
): ApprovalGuardedRunRecord {
  return {
    id: "run_1",
    status: "planned",
    ...overrides,
  };
}

function createApproval(
  overrides: Partial<ApprovalGuardRecord> = {},
): ApprovalGuardRecord {
  return {
    id: "approval_1",
    status: "pending",
    taskId: null,
    runId: null,
    ...overrides,
  };
}

class InMemoryApprovalGuardedTransitionRepository
  implements ApprovalGuardedTransitionRepository
{
  private readonly tasks = new Map<string, ApprovalGuardedTaskRecord>();
  private readonly runs = new Map<string, ApprovalGuardedRunRecord>();
  private readonly approvals: readonly ApprovalGuardRecord[];

  compareAndSwapTaskCalls = 0;
  compareAndSwapRunCalls = 0;
  onCompareAndSwapTask?: (() => boolean) | undefined;
  onCompareAndSwapRun?: (() => boolean) | undefined;

  constructor(input: {
    tasks?: readonly ApprovalGuardedTaskRecord[];
    runs?: readonly ApprovalGuardedRunRecord[];
    approvals?: readonly ApprovalGuardRecord[];
  }) {
    for (const task of input.tasks ?? []) {
      this.tasks.set(task.id, { ...task });
    }

    for (const run of input.runs ?? []) {
      this.runs.set(run.id, { ...run });
    }

    this.approvals = (input.approvals ?? []).map((approval) => ({ ...approval }));
  }

  async getTask(
    taskId: string,
  ): Promise<ApprovalGuardedTaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : { ...task };
  }

  async getRun(runId: string): Promise<ApprovalGuardedRunRecord | undefined> {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : { ...run };
  }

  async listTaskApprovals(
    _taskId: string,
  ): Promise<readonly ApprovalGuardRecord[]> {
    return this.approvals.map((approval) => ({ ...approval }));
  }

  async listRunApprovals(
    _runId: string,
  ): Promise<readonly ApprovalGuardRecord[]> {
    return this.approvals.map((approval) => ({ ...approval }));
  }

  async compareAndSwapTaskState(
    taskId: string,
    expected: ApprovalGuardedTaskRecord["state"],
    next: ApprovalGuardedTaskRecord["state"],
  ): Promise<boolean> {
    this.compareAndSwapTaskCalls += 1;

    if (this.onCompareAndSwapTask?.() === false) {
      return false;
    }

    const current = this.tasks.get(taskId);

    if (current === undefined || current.state !== expected) {
      return false;
    }

    this.tasks.set(taskId, {
      ...current,
      state: next,
    });

    return true;
  }

  async compareAndSwapRunStatus(
    runId: string,
    expected: ApprovalGuardedRunRecord["status"],
    next: ApprovalGuardedRunRecord["status"],
  ): Promise<boolean> {
    this.compareAndSwapRunCalls += 1;

    if (this.onCompareAndSwapRun?.() === false) {
      return false;
    }

    const current = this.runs.get(runId);

    if (current === undefined || current.status !== expected) {
      return false;
    }

    this.runs.set(runId, {
      ...current,
      status: next,
    });

    return true;
  }

  replaceTask(task: ApprovalGuardedTaskRecord): void {
    this.tasks.set(task.id, { ...task });
  }

  replaceRun(run: ApprovalGuardedRunRecord): void {
    this.runs.set(run.id, { ...run });
  }
}

describe("approval guarded transition service", () => {
  it("transitions a guarded task through the production mutation path once related approvals are resolved", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      tasks: [createTask({ state: "waiting_approval" })],
      approvals: [
        createApproval({
          id: "approval_approved",
          status: "approved",
          taskId: "task_1",
        }),
        createApproval({
          id: "approval_other_task",
          status: "pending",
          taskId: "task_2",
        }),
      ],
    });
    const service = createApprovalGuardedTransitionService(repository);

    const transitioned = await service.transitionTask({
      taskId: "task_1",
      from: "waiting_approval",
      to: "done",
    });

    expect(transitioned).toEqual(createTask({ state: "done" }));
    expect(repository.compareAndSwapTaskCalls).toBe(1);
  });

  it("blocks guarded task transitions while related approvals remain unresolved", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      tasks: [createTask({ state: "waiting_approval" })],
      approvals: [
        createApproval({
          id: "approval_pending",
          status: "pending",
          taskId: "task_1",
        }),
        createApproval({
          id: "approval_other_task",
          status: "pending",
          taskId: "task_2",
        }),
      ],
    });
    const service = createApprovalGuardedTransitionService(repository);

    await expect(
      service.transitionTask({
        taskId: "task_1",
        from: "waiting_approval",
        to: "done",
      }),
    ).rejects.toMatchObject({
      code: "required_approvals_unresolved",
      entityType: "task",
      entityId: "task_1",
      from: "waiting_approval",
      to: "done",
      blockingApprovalIds: ["approval_pending"],
    } satisfies Partial<ApprovalGuardedTransitionBlockedError>);

    expect(repository.compareAndSwapTaskCalls).toBe(0);
  });

  it("transitions a guarded run once the related approval has been resolved", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      runs: [createRun({ status: "waiting_approval" })],
      approvals: [
        createApproval({
          id: "approval_revision_requested",
          status: "revision_requested",
          runId: "run_1",
        }),
      ],
    });
    const service = createApprovalGuardedTransitionService(repository);

    const transitioned = await service.transitionRun({
      runId: "run_1",
      from: "waiting_approval",
      to: "running",
    });

    expect(transitioned).toEqual(createRun({ status: "running" }));
    expect(repository.compareAndSwapRunCalls).toBe(1);
  });

  it("blocks guarded run transitions while related approvals are resubmitted", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      runs: [createRun({ status: "waiting_approval" })],
      approvals: [
        createApproval({
          id: "approval_resubmitted",
          status: "resubmitted",
          runId: "run_1",
        }),
        createApproval({
          id: "approval_other_run",
          status: "pending",
          runId: "run_2",
        }),
      ],
    });
    const service = createApprovalGuardedTransitionService(repository);

    await expect(
      service.transitionRun({
        runId: "run_1",
        from: "waiting_approval",
        to: "running",
      }),
    ).rejects.toMatchObject({
      code: "required_approvals_unresolved",
      entityType: "run",
      entityId: "run_1",
      from: "waiting_approval",
      to: "running",
      blockingApprovalIds: ["approval_resubmitted"],
    } satisfies Partial<ApprovalGuardedTransitionBlockedError>);

    expect(repository.compareAndSwapRunCalls).toBe(0);
  });

  it("ignores unresolved approvals for non-guarded transitions", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      tasks: [createTask({ state: "todo" })],
      runs: [createRun({ status: "planned" })],
      approvals: [
        createApproval({
          id: "task_pending",
          status: "pending",
          taskId: "task_1",
        }),
        createApproval({
          id: "run_pending",
          status: "pending",
          runId: "run_1",
        }),
      ],
    });
    const service = createApprovalGuardedTransitionService(repository);

    await expect(
      service.transitionTask({
        taskId: "task_1",
        from: "todo",
        to: "in_progress",
      }),
    ).resolves.toEqual(createTask({ state: "in_progress" }));
    await expect(
      service.transitionRun({
        runId: "run_1",
        from: "planned",
        to: "running",
      }),
    ).resolves.toEqual(createRun({ status: "running" }));
  });

  it("reports a deterministic conflict when the task state changes before the transition can be applied", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      tasks: [createTask({ state: "waiting_approval" })],
      approvals: [
        createApproval({
          id: "approval_approved",
          status: "approved",
          taskId: "task_1",
        }),
      ],
    });
    repository.onCompareAndSwapTask = () => {
      repository.replaceTask(createTask({ id: "task_1", state: "blocked" }));
      return false;
    };

    const service = createApprovalGuardedTransitionService(repository);

    await expect(
      service.transitionTask({
        taskId: "task_1",
        from: "waiting_approval",
        to: "done",
      }),
    ).rejects.toMatchObject({
      code: "task_transition_concurrent_update",
      entityType: "task",
      entityId: "task_1",
      expectedFrom: "waiting_approval",
      targetTo: "done",
      currentValue: "blocked",
    } satisfies Partial<ApprovalGuardedTransitionConflictError>);
  });

  it("rejects stale task transitions even when the task already equals the requested target state", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      tasks: [createTask({ state: "done" })],
    });
    const service = createApprovalGuardedTransitionService(repository);

    await expect(
      service.transitionTask({
        taskId: "task_1",
        from: "waiting_approval",
        to: "done",
      }),
    ).rejects.toMatchObject({
      code: "task_transition_concurrent_update",
      entityType: "task",
      entityId: "task_1",
      expectedFrom: "waiting_approval",
      targetTo: "done",
      currentValue: "done",
    } satisfies Partial<ApprovalGuardedTransitionConflictError>);

    expect(repository.compareAndSwapTaskCalls).toBe(0);
  });

  it("rejects stale run transitions even when the run already equals the requested target status", async () => {
    const repository = new InMemoryApprovalGuardedTransitionRepository({
      runs: [createRun({ status: "running" })],
    });
    const service = createApprovalGuardedTransitionService(repository);

    await expect(
      service.transitionRun({
        runId: "run_1",
        from: "waiting_approval",
        to: "running",
      }),
    ).rejects.toMatchObject({
      code: "run_transition_concurrent_update",
      entityType: "run",
      entityId: "run_1",
      expectedFrom: "waiting_approval",
      targetTo: "running",
      currentValue: "running",
    } satisfies Partial<ApprovalGuardedTransitionConflictError>);

    expect(repository.compareAndSwapRunCalls).toBe(0);
  });
});
