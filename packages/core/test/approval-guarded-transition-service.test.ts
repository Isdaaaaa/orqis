import { describe, expect, it } from "vitest";

import {
  ApprovalGuardedTransitionBlockedError,
  createApprovalGuardedTransitionService,
  type ApprovalGuardRecord,
} from "../src/index.ts";

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

describe("approval guarded transition service", () => {
  it("blocks guarded task transitions while related approvals remain unresolved", () => {
    const service = createApprovalGuardedTransitionService();

    let error: unknown;

    try {
      service.assertTaskTransitionAllowed({
        taskId: "task_1",
        from: "waiting_approval",
        to: "done",
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
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(ApprovalGuardedTransitionBlockedError);
    expect(error).toMatchObject({
      code: "required_approvals_unresolved",
      entityType: "task",
      entityId: "task_1",
      from: "waiting_approval",
      to: "done",
      blockingApprovalIds: ["approval_pending"],
    } satisfies Partial<ApprovalGuardedTransitionBlockedError>);
  });

  it("blocks guarded run transitions while related approvals are resubmitted", () => {
    const service = createApprovalGuardedTransitionService();

    let error: unknown;

    try {
      service.assertRunTransitionAllowed({
        runId: "run_1",
        from: "waiting_approval",
        to: "running",
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
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(ApprovalGuardedTransitionBlockedError);
    expect(error).toMatchObject({
      code: "required_approvals_unresolved",
      entityType: "run",
      entityId: "run_1",
      from: "waiting_approval",
      to: "running",
      blockingApprovalIds: ["approval_resubmitted"],
    } satisfies Partial<ApprovalGuardedTransitionBlockedError>);
  });

  it("allows guarded task completion once related approvals are approved", () => {
    const service = createApprovalGuardedTransitionService();

    expect(() =>
      service.assertTaskTransitionAllowed({
        taskId: "task_1",
        from: "waiting_approval",
        to: "done",
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
      }),
    ).not.toThrow();
  });

  it("allows guarded run retries once related approvals are resolved", () => {
    const service = createApprovalGuardedTransitionService();

    expect(() =>
      service.assertRunTransitionAllowed({
        runId: "run_1",
        from: "waiting_approval",
        to: "running",
        approvals: [
          createApproval({
            id: "approval_revision_requested",
            status: "revision_requested",
            runId: "run_1",
          }),
        ],
      }),
    ).not.toThrow();
  });

  it("ignores unresolved approvals for non-guarded task and run transitions", () => {
    const service = createApprovalGuardedTransitionService();
    const approvals = [
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
    ];

    expect(() =>
      service.assertTaskTransitionAllowed({
        taskId: "task_1",
        from: "todo",
        to: "in_progress",
        approvals,
      }),
    ).not.toThrow();
    expect(() =>
      service.assertRunTransitionAllowed({
        runId: "run_1",
        from: "planned",
        to: "running",
        approvals,
      }),
    ).not.toThrow();
  });
});
