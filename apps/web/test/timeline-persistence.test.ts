import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  createWorkspaceTimelineStore,
  WorkspaceTaskAssignmentConflictError,
  WorkspaceTaskClaimConflictError,
  WorkspaceTimelineValidationError,
} from "../src/persistence.ts";
import { WORKSPACE_CI_INTEGRATION_TIMEOUT_MS } from "./integration-timeouts.ts";

interface ApprovalAuditEventRow {
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string | null;
}

interface RunStatusRow {
  readonly status: string;
}

interface RunLifecycleDetailsRow {
  readonly status: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

function readApprovalAuditEvents(
  database: BetterSqlite3.Database,
  approvalId: string,
): ApprovalAuditEventRow[] {
  return database
    .prepare(
      [
        "SELECT",
        "  action,",
        "  actor_type AS actorType,",
        "  actor_id AS actorId",
        "FROM audit_events",
        "WHERE approval_id = ?",
        "ORDER BY rowid ASC",
      ].join("\n"),
    )
    .all(approvalId) as ApprovalAuditEventRow[];
}

function readRunStatus(
  database: BetterSqlite3.Database,
  runId: string,
): string | null {
  const row = database
    .prepare(
      [
        "SELECT",
        "  status",
        "FROM runs",
        "WHERE id = ?",
        "LIMIT 1",
      ].join("\n"),
    )
    .get(runId) as RunStatusRow | undefined;

  return row?.status ?? null;
}

function readRunLifecycleDetails(
  database: BetterSqlite3.Database,
  runId: string,
): RunLifecycleDetailsRow | null {
  const row = database
    .prepare(
      [
        "SELECT",
        "  status,",
        "  started_at AS startedAt,",
        "  ended_at AS endedAt",
        "FROM runs",
        "WHERE id = ?",
        "LIMIT 1",
      ].join("\n"),
    )
    .get(runId) as RunLifecycleDetailsRow | undefined;

  return row ?? null;
}

describe("@orqis/web workspace timeline persistence", () => {
  it(
    "persists messages across store restarts and keeps chronological workspace ordering",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-timeline-"));
      const databaseFilePath = join(tempDir, "timeline.db");

      const firstStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const firstMessage = firstStore.appendWorkspaceMessage({
          workspaceId: "workspace-alpha",
          projectId: "project-alpha",
          actorType: "user",
          actorId: "alice",
          content: "First timeline update",
        });

        const secondMessage = firstStore.appendWorkspaceMessage({
          workspaceId: "workspace-alpha",
          projectId: "project-alpha",
          actorType: "agent",
          actorId: "pm",
          content: "Second timeline update",
        });

        firstStore.appendWorkspaceMessage({
          workspaceId: "workspace-beta",
          projectId: "project-beta",
          actorType: "user",
          actorId: "bob",
          content: "Workspace beta update",
        });

        expect(firstMessage.createdAt <= secondMessage.createdAt).toBe(true);
      } finally {
        firstStore.close();
      }

      const secondStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const alphaTimeline = secondStore.listWorkspaceMessages("workspace-alpha");
        const betaTimeline = secondStore.listWorkspaceMessages("workspace-beta");
        const missingTimeline = secondStore.listWorkspaceMessages("workspace-missing");

        expect(alphaTimeline).toHaveLength(2);
        expect(alphaTimeline.map((message) => message.content)).toEqual([
          "First timeline update",
          "Second timeline update",
        ]);
        expect(
          alphaTimeline.every((message) => message.workspaceId === "workspace-alpha"),
        ).toBe(true);

        expect(betaTimeline).toHaveLength(1);
        expect(betaTimeline[0]?.content).toBe("Workspace beta update");

        expect(missingTimeline).toEqual([]);
      } finally {
        secondStore.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "creates projects with one persistent workspace mapping and unique slugs",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-projects-"));
      const databaseFilePath = join(tempDir, "projects.db");

      const firstStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      let firstProjectId = "";
      let secondProjectId = "";

      try {
        const firstProject = firstStore.createProject({
          name: "Website Redesign",
          description: "MVP project scope",
        });
        const secondProject = firstStore.createProject({
          name: "Website Redesign",
        });
        const listedProjects = firstStore.listProjects();

        firstProjectId = firstProject.projectId;
        secondProjectId = secondProject.projectId;

        expect(firstProject.workspaceId).not.toBe(secondProject.workspaceId);
        expect(firstProject.projectSlug).toBe("website-redesign");
        expect(secondProject.projectSlug).toBe("website-redesign-2");
        expect(firstProject.projectDescription).toBe("MVP project scope");
        expect(secondProject.projectDescription).toBeNull();
        expect(listedProjects).toHaveLength(2);
        expect(listedProjects.map((project) => project.projectId)).toEqual([
          firstProject.projectId,
          secondProject.projectId,
        ]);
      } finally {
        firstStore.close();
      }

      const secondStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const listedProjects = secondStore.listProjects();

        expect(listedProjects).toHaveLength(2);
        expect(listedProjects.map((project) => project.projectId)).toContain(
          firstProjectId,
        );
        expect(listedProjects.map((project) => project.projectId)).toContain(
          secondProjectId,
        );
      } finally {
        secondStore.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "persists provider, model, and agent-role configuration across store restarts",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-agent-config-"));
      const databaseFilePath = join(tempDir, "agent-config.db");

      const firstStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const defaultConfiguration = firstStore.getAgentConfiguration();

        expect(defaultConfiguration.providers[0]?.providerKey).toBe("openai");
        expect(defaultConfiguration.models[0]?.modelKey).toBe("gpt-5");
        expect(defaultConfiguration.agentRoles.length).toBeGreaterThanOrEqual(2);

        const savedConfiguration = firstStore.saveAgentConfiguration({
          providers: [
            {
              providerKey: "anthropic",
              displayName: "Anthropic",
              baseUrl: "https://api.anthropic.com/v1",
            },
          ],
          models: [
            {
              modelKey: "claude-sonnet-4",
              providerKey: "anthropic",
              displayName: "Claude Sonnet 4",
            },
          ],
          agentRoles: [
            {
              roleKey: "project_manager",
              displayName: "Project Manager",
              modelKey: "claude-sonnet-4",
              responsibility: "Creates plans and owns approvals.",
            },
            {
              roleKey: "reviewer",
              displayName: "Reviewer",
              modelKey: "claude-sonnet-4",
              responsibility: "Finds regressions before release.",
            },
          ],
        });

        expect(savedConfiguration).toEqual({
          providers: [
            {
              providerKey: "anthropic",
              displayName: "Anthropic",
              baseUrl: "https://api.anthropic.com/v1",
            },
          ],
          models: [
            {
              modelKey: "claude-sonnet-4",
              providerKey: "anthropic",
              displayName: "Claude Sonnet 4",
            },
          ],
          agentRoles: [
            {
              roleKey: "project_manager",
              displayName: "Project Manager",
              modelKey: "claude-sonnet-4",
              responsibility: "Creates plans and owns approvals.",
            },
            {
              roleKey: "reviewer",
              displayName: "Reviewer",
              modelKey: "claude-sonnet-4",
              responsibility: "Finds regressions before release.",
            },
          ],
        });
      } finally {
        firstStore.close();
      }

      const secondStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        expect(secondStore.getAgentConfiguration()).toEqual({
          providers: [
            {
              providerKey: "anthropic",
              displayName: "Anthropic",
              baseUrl: "https://api.anthropic.com/v1",
            },
          ],
          models: [
            {
              modelKey: "claude-sonnet-4",
              providerKey: "anthropic",
              displayName: "Claude Sonnet 4",
            },
          ],
          agentRoles: [
            {
              roleKey: "project_manager",
              displayName: "Project Manager",
              modelKey: "claude-sonnet-4",
              responsibility: "Creates plans and owns approvals.",
            },
            {
              roleKey: "reviewer",
              displayName: "Reviewer",
              modelKey: "claude-sonnet-4",
              responsibility: "Finds regressions before release.",
            },
          ],
        });
      } finally {
        secondStore.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects agent-role configurations that remove the reserved project_manager role key",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-agent-config-pm-"));
      const databaseFilePath = join(tempDir, "agent-config-pm.db");

      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        expect(() =>
          store.saveAgentConfiguration({
            providers: [
              {
                providerKey: "openai",
                displayName: "OpenAI",
                baseUrl: "https://api.openai.com/v1",
              },
            ],
            models: [
              {
                modelKey: "gpt-5",
                providerKey: "openai",
                displayName: "GPT-5",
              },
            ],
            agentRoles: [
              {
                roleKey: "backend_agent",
                displayName: "Backend Agent",
                modelKey: "gpt-5",
                responsibility: "Owns runtime behavior and persistence.",
              },
              {
                roleKey: "reviewer",
                displayName: "Reviewer",
                modelKey: "gpt-5",
                responsibility: "Finds regressions before release.",
              },
            ],
          }),
        ).toThrowError(
          new WorkspaceTimelineValidationError(
            'agentRoles must include the reserved "project_manager" role key for planner compatibility.',
          ),
        );

        expect(
          store.getAgentConfiguration().agentRoles.map((agentRole) => agentRole.roleKey),
        ).toContain("project_manager");

        const project = store.createProject({
          name: "Planner Guard Project",
        });
        const plan = store.createProjectManagerPlan({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          goal: "Ship the planner guard",
          requestedByActorId: "owner",
        });

        expect(plan.projectManagerRoleKey).toBe("project_manager");
      } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "persists a Project Manager plan as a run, task list, and visible workspace messages",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-planner-"));
      const databaseFilePath = join(tempDir, "planner.db");

      const firstStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      let createdProject:
        | {
            readonly projectId: string;
            readonly workspaceId: string;
          }
        | undefined;

      try {
        createdProject = firstStore.createProject({
          name: "Planner Project",
        });

        const plan = firstStore.createProjectManagerPlan({
          workspaceId: createdProject.workspaceId,
          projectId: createdProject.projectId,
          goal: "Implement the first approval workflow",
          requestedByActorId: "owner",
        });

        expect(plan.projectId).toBe(createdProject.projectId);
        expect(plan.workspaceId).toBe(createdProject.workspaceId);
        expect(plan.summary).toContain("first approval workflow");
        expect(plan.projectManagerRoleKey).toBe("project_manager");
        expect(plan.goalMessage).toMatchObject({
          actorType: "user",
          actorId: "owner",
          content: "Implement the first approval workflow",
        });
        expect(plan.planMessage).toMatchObject({
          actorType: "agent",
          actorId: "project_manager",
        });
        expect(plan.planMessage.content).toContain("Project Manager plan for:");
        expect(plan.tasks.map((task) => task.ownerRole)).toEqual([
          "frontend_agent",
          "backend_agent",
          "reviewer",
        ]);
        expect(plan.tasks.map((task) => task.assignment.roleKey)).toEqual([
          "frontend_agent",
          "backend_agent",
          "reviewer",
        ]);
        expect(plan.tasks[1]).toMatchObject({
          ownerDisplayName: "Backend Agent",
          assignment: {
            roleDisplayName: "Backend Agent",
            modelKey: "gpt-5",
          },
        });
      } finally {
        firstStore.close();
      }

      if (createdProject === undefined) {
        throw new Error("expected project details for planner persistence assertions");
      }

      const secondStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const messages = secondStore.listWorkspaceMessages(createdProject.workspaceId);
        const tasks = secondStore.listWorkspaceTasks(createdProject.workspaceId);

        expect(messages).toHaveLength(2);
        expect(messages.map((message) => message.actorType)).toEqual([
          "user",
          "agent",
        ]);
        expect(messages[0]?.content).toBe("Implement the first approval workflow");
        expect(messages[1]?.content).toContain("Project Manager plan for:");
        expect(tasks).toHaveLength(3);
        expect(tasks[1]).toMatchObject({
          ownerRole: "backend_agent",
          ownerDisplayName: "Backend Agent",
          assignment: {
            roleKey: "backend_agent",
            roleDisplayName: "Backend Agent",
            modelKey: "gpt-5",
          },
        });
      } finally {
        secondStore.close();
      }

      const database = new BetterSqlite3(databaseFilePath, {
        readonly: true,
      });

      try {
        const runs = database
          .prepare(
            [
              "SELECT",
              "  id,",
              "  status,",
              "  summary,",
              "  workspace_id AS workspaceId",
              "FROM runs",
            ].join("\n"),
          )
          .all() as Array<{
          id: string;
          status: string;
          summary: string;
          workspaceId: string;
        }>;
        const tasks = database
          .prepare(
            [
              "SELECT",
              "  owner_role AS ownerRole,",
              "  state",
              "FROM tasks",
              "ORDER BY rowid ASC",
            ].join("\n"),
          )
          .all() as Array<{
          ownerRole: string;
          state: string;
        }>;

        expect(runs).toEqual([
          expect.objectContaining({
            status: "planned",
            workspaceId: createdProject.workspaceId,
            summary: expect.stringContaining("first approval workflow"),
          }),
        ]);
        expect(tasks).toEqual([
          {
            ownerRole: "frontend_agent",
            state: "todo",
          },
          {
            ownerRole: "backend_agent",
            state: "todo",
          },
          {
            ownerRole: "reviewer",
            state: "todo",
          },
        ]);

        const assignments = database
          .prepare(
            [
              "SELECT",
              "  role_key AS roleKey,",
              "  role_display_name AS roleDisplayName,",
              "  model_key AS modelKey",
              "FROM task_assignments",
              "ORDER BY rowid ASC",
            ].join("\n"),
          )
          .all() as Array<{
          roleKey: string;
          roleDisplayName: string;
          modelKey: string | null;
        }>;

        expect(assignments).toEqual([
          {
            roleKey: "frontend_agent",
            roleDisplayName: "Frontend Agent",
            modelKey: "gpt-5",
          },
          {
            roleKey: "backend_agent",
            roleDisplayName: "Backend Agent",
            modelKey: "gpt-5",
          },
          {
            roleKey: "reviewer",
            roleDisplayName: "Reviewer",
            modelKey: "gpt-5",
          },
        ]);
      } finally {
        database.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "lists role-mapped tasks and rejects competing execution claims deterministically",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-task-claims-"));
      const databaseFilePath = join(tempDir, "task-claims.db");
      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const project = store.createProject({
          name: "Task Claims Project",
        });
        const plan = store.createProjectManagerPlan({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          goal: "Implement deterministic task checkout",
          requestedByActorId: "owner",
        });

        const backendTask = plan.tasks.find(
          (task) => task.ownerRole === "backend_agent",
        );

        if (backendTask === undefined) {
          throw new Error("expected backend task for claim assertions");
        }

        const listedTasks = store.listWorkspaceTasks(project.workspaceId);
        expect(listedTasks.map((task) => task.assignment?.roleKey)).toContain(
          "backend_agent",
        );

        const claimedTask = await store.claimTaskExecution({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          runId: plan.runId,
          ownerType: "agent",
          ownerId: "backend_agent",
          claimedAt: "2026-03-12T08:00:00.000Z",
        });

        expect(claimedTask).toMatchObject({
          id: backendTask.id,
          state: "in_progress",
          lockOwnerType: "agent",
          lockOwnerId: "backend_agent",
          checkoutRunId: plan.runId,
          executionRunId: plan.runId,
        });

        const claimAuditDatabase = new BetterSqlite3(databaseFilePath, {
          readonly: true,
        });

        try {
          expect(readRunStatus(claimAuditDatabase, plan.runId)).toBe("running");
        } finally {
          claimAuditDatabase.close();
        }

        await expect(
          store.claimTaskExecution({
            workspaceId: project.workspaceId,
            taskId: backendTask.id,
            runId: "run-competing",
            ownerType: "agent",
            ownerId: "reviewer",
          }),
        ).rejects.toMatchObject({
          code: "task_assigned_to_another_role",
          taskId: backendTask.id,
          assignedRoleKey: "backend_agent",
          attemptedRoleKey: "reviewer",
        } satisfies Partial<WorkspaceTaskAssignmentConflictError>);

        await expect(
          store.claimTaskExecution({
            workspaceId: project.workspaceId,
            taskId: backendTask.id,
            runId: "run-competing",
            ownerType: "agent",
            ownerId: "backend_agent",
          }),
        ).rejects.toMatchObject({
          code: "task_execution_locked",
          taskId: backendTask.id,
          currentExecutionRunId: plan.runId,
          currentCheckoutRunId: plan.runId,
        } satisfies Partial<WorkspaceTaskClaimConflictError>);

        const releasedTask = await store.releaseTaskExecution({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          runId: plan.runId,
          ownerType: "agent",
          ownerId: "backend_agent",
        });

        expect(releasedTask).toMatchObject({
          id: backendTask.id,
          state: "in_progress",
          checkoutRunId: plan.runId,
          executionRunId: null,
          lockOwnerType: "agent",
          lockOwnerId: "backend_agent",
        });
      } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects run-owned claim and release payloads when ownerId diverges from runId",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-run-owner-"));
      const databaseFilePath = join(tempDir, "run-owner.db");
      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const project = store.createProject({
          name: "Run Owner Validation Project",
        });
        const plan = store.createProjectManagerPlan({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          goal: "Validate run-owned task claims",
          requestedByActorId: "owner",
        });
        const task = plan.tasks[0];

        if (task === undefined) {
          throw new Error("expected task for run-owner validation assertions");
        }

        await expect(
          store.claimTaskExecution({
            workspaceId: project.workspaceId,
            taskId: task.id,
            runId: plan.runId,
            ownerType: "run",
            ownerId: "run-other",
          }),
        ).rejects.toMatchObject({
          message: "ownerId must equal runId when ownerType is run.",
        });

        const claimedTask = await store.claimTaskExecution({
          workspaceId: project.workspaceId,
          taskId: task.id,
          runId: plan.runId,
          ownerType: "run",
          ownerId: plan.runId,
        });

        expect(claimedTask).toMatchObject({
          id: task.id,
          lockOwnerType: "run",
          lockOwnerId: plan.runId,
          checkoutRunId: plan.runId,
          executionRunId: plan.runId,
        });

        await expect(
          store.releaseTaskExecution({
            workspaceId: project.workspaceId,
            taskId: task.id,
            runId: plan.runId,
            ownerType: "run",
            ownerId: "run-other",
          }),
        ).rejects.toMatchObject({
          message: "ownerId must equal runId when ownerType is run.",
        });
      } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "persists task output approval, revision request, resubmission, and final approval with audit history",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-task-approval-"));
      const databaseFilePath = join(tempDir, "task-approval.db");
      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      let approvalId = "";
      let runId = "";

      try {
        const project = store.createProject({
          name: "Task Approval Project",
        });
        const plan = store.createProjectManagerPlan({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          goal: "Implement the user approval loop",
          requestedByActorId: "owner",
        });
        const backendTask = plan.tasks.find(
          (task) => task.ownerRole === "backend_agent",
        );

        if (backendTask === undefined) {
          throw new Error("expected backend task for approval assertions");
        }

        runId = plan.runId;

        await store.claimTaskExecution({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          runId: plan.runId,
          ownerType: "agent",
          ownerId: "backend_agent",
        });

        const submitted = await store.submitTaskOutput({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          runId: plan.runId,
          ownerType: "agent",
          ownerId: "backend_agent",
          output: "Implemented the first approval flow.",
        });

        approvalId = submitted.approval.id;

        expect(submitted.task).toMatchObject({
          id: backendTask.id,
          state: "waiting_approval",
          executionRunId: null,
          checkoutRunId: plan.runId,
          lockOwnerId: "backend_agent",
        });
        expect(submitted.approval).toMatchObject({
          taskId: backendTask.id,
          runId: plan.runId,
          status: "pending",
          requestedByActorType: "agent",
          requestedByActorId: "backend_agent",
        });
        expect(submitted.outputMessage.content).toContain(
          `Task output submitted for "${backendTask.title}"`,
        );
        expect(submitted.projectManagerMessage.actorId).toBe("project_manager");

        const revisionRequested = await store.decideTaskApproval({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          decision: "revision_requested",
          decisionSummary: "Address the edge case before merge.",
          decidedByActorId: "owner",
        });

        expect(revisionRequested.task).toMatchObject({
          id: backendTask.id,
          state: "in_progress",
          executionRunId: null,
          checkoutRunId: plan.runId,
        });
        expect(revisionRequested.approval).toMatchObject({
          id: approvalId,
          status: "revision_requested",
          decisionByActorType: "user",
          decisionByActorId: "owner",
          decisionSummary: "Address the edge case before merge.",
        });

        await store.claimTaskExecution({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          runId: plan.runId,
          ownerType: "agent",
          ownerId: "backend_agent",
        });

        const resubmitted = await store.submitTaskOutput({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          runId: plan.runId,
          ownerType: "agent",
          ownerId: "backend_agent",
          output: "Addressed the edge case and updated the approval flow.",
        });

        expect(resubmitted.approval).toMatchObject({
          id: approvalId,
          status: "resubmitted",
          decisionByActorType: null,
          decisionByActorId: null,
          decisionSummary: null,
        });
        expect(resubmitted.task.state).toBe("waiting_approval");

        const approved = await store.decideTaskApproval({
          workspaceId: project.workspaceId,
          taskId: backendTask.id,
          decision: "approved",
          decidedByActorId: "owner",
        });

        expect(approved.task).toMatchObject({
          id: backendTask.id,
          state: "done",
        });
        expect(approved.task.completedAt).toBeTypeOf("string");
        expect(approved.approval).toMatchObject({
          id: approvalId,
          status: "approved",
          decisionByActorType: "user",
          decisionByActorId: "owner",
        });
        expect(approved.projectManagerMessage.content).toContain(
          `Project Manager received approval for "${backendTask.title}"`,
        );

        const messages = store.listWorkspaceMessages(project.workspaceId);
        expect(messages.map((message) => message.content)).toEqual(
          expect.arrayContaining([
            "Implement the user approval loop",
            expect.stringContaining(
              `Task output submitted for "${backendTask.title}"`,
            ),
            expect.stringContaining(
              `User "owner" requested revisions for "${backendTask.title}"`,
            ),
            expect.stringContaining(
              `User "owner" approved "${backendTask.title}"`,
            ),
          ]),
        );
      } finally {
        store.close();
      }

      const auditDatabase = new BetterSqlite3(databaseFilePath, {
        readonly: true,
      });

      try {
        expect(readApprovalAuditEvents(auditDatabase, approvalId)).toEqual([
          {
            action: "approval.created",
            actorType: "agent",
            actorId: "backend_agent",
          },
          {
            action: "approval.updated",
            actorType: "user",
            actorId: "owner",
          },
          {
            action: "approval.updated",
            actorType: "agent",
            actorId: "backend_agent",
          },
          {
            action: "approval.updated",
            actorType: "user",
            actorId: "owner",
          },
        ]);
        expect(readRunStatus(auditDatabase, runId)).toBe("running");
      } finally {
        auditDatabase.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "marks a run done when all run tasks are approved",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-run-done-"));
      const databaseFilePath = join(tempDir, "run-done.db");
      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      let runId = "";

      try {
        store.saveAgentConfiguration({
          providers: [
            {
              providerKey: "openai",
              displayName: "OpenAI",
              baseUrl: "https://api.openai.com/v1",
            },
          ],
          models: [
            {
              modelKey: "gpt-5",
              providerKey: "openai",
              displayName: "GPT-5",
            },
          ],
          agentRoles: [
            {
              roleKey: "project_manager",
              displayName: "Project Manager",
              modelKey: "gpt-5",
              responsibility: "Owns plan creation and approvals.",
            },
            {
              roleKey: "backend_agent",
              displayName: "Backend Agent",
              modelKey: "gpt-5",
              responsibility: "Owns runtime behavior.",
            },
          ],
        });

        const project = store.createProject({
          name: "Run Done Project",
        });
        const plan = store.createProjectManagerPlan({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          goal: "Close the first lifecycle run",
          requestedByActorId: "owner",
        });
        const task = plan.tasks[0];

        if (task === undefined) {
          throw new Error("expected one planned task for run completion assertions");
        }

        runId = plan.runId;

        await store.claimTaskExecution({
          workspaceId: project.workspaceId,
          taskId: task.id,
          runId,
          ownerType: "agent",
          ownerId: "backend_agent",
        });

        await store.submitTaskOutput({
          workspaceId: project.workspaceId,
          taskId: task.id,
          runId,
          ownerType: "agent",
          ownerId: "backend_agent",
          output: "Delivered the run completion slice.",
        });

        const approved = await store.decideTaskApproval({
          workspaceId: project.workspaceId,
          taskId: task.id,
          decision: "approved",
          decidedByActorId: "owner",
        });

        expect(approved.task.state).toBe("done");
      } finally {
        store.close();
      }

      const auditDatabase = new BetterSqlite3(databaseFilePath, {
        readonly: true,
      });

      try {
        expect(readRunLifecycleDetails(auditDatabase, runId)).toMatchObject({
          status: "done",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
        });
      } finally {
        auditDatabase.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "marks a run failed when a task approval decision is rejected",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-run-failed-"));
      const databaseFilePath = join(tempDir, "run-failed.db");
      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      let runId = "";

      try {
        store.saveAgentConfiguration({
          providers: [
            {
              providerKey: "openai",
              displayName: "OpenAI",
              baseUrl: "https://api.openai.com/v1",
            },
          ],
          models: [
            {
              modelKey: "gpt-5",
              providerKey: "openai",
              displayName: "GPT-5",
            },
          ],
          agentRoles: [
            {
              roleKey: "project_manager",
              displayName: "Project Manager",
              modelKey: "gpt-5",
              responsibility: "Owns plan creation and approvals.",
            },
            {
              roleKey: "backend_agent",
              displayName: "Backend Agent",
              modelKey: "gpt-5",
              responsibility: "Owns runtime behavior.",
            },
          ],
        });

        const project = store.createProject({
          name: "Run Failed Project",
        });
        const plan = store.createProjectManagerPlan({
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          goal: "Exercise the failure lifecycle path",
          requestedByActorId: "owner",
        });
        const task = plan.tasks[0];

        if (task === undefined) {
          throw new Error("expected one planned task for run failure assertions");
        }

        runId = plan.runId;

        await store.claimTaskExecution({
          workspaceId: project.workspaceId,
          taskId: task.id,
          runId,
          ownerType: "agent",
          ownerId: "backend_agent",
        });

        await store.submitTaskOutput({
          workspaceId: project.workspaceId,
          taskId: task.id,
          runId,
          ownerType: "agent",
          ownerId: "backend_agent",
          output: "Delivered a version that should be rejected.",
        });

        const rejected = await store.decideTaskApproval({
          workspaceId: project.workspaceId,
          taskId: task.id,
          decision: "rejected",
          decisionSummary: "The result is not acceptable.",
          decidedByActorId: "owner",
        });

        expect(rejected.task.state).toBe("blocked");
      } finally {
        store.close();
      }

      const auditDatabase = new BetterSqlite3(databaseFilePath, {
        readonly: true,
      });

      try {
        expect(readRunLifecycleDetails(auditDatabase, runId)).toMatchObject({
          status: "failed",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
        });
      } finally {
        auditDatabase.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "upgrades legacy phase 2 databases without a migration ledger and seeds agent configuration defaults",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-agent-legacy-"));
      const databaseFilePath = join(tempDir, "legacy.db");
      const legacyDatabase = new BetterSqlite3(databaseFilePath);

      try {
        legacyDatabase.exec(
          readFileSync(
            new URL(
              "../../../packages/db/migrations/0001_project_workspace_schema.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      } finally {
        legacyDatabase.close();
      }

      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const configuration = store.getAgentConfiguration();

        expect(configuration.providers[0]?.providerKey).toBe("openai");
        expect(configuration.models[0]?.modelKey).toBe("gpt-5");
        expect(configuration.agentRoles.length).toBeGreaterThanOrEqual(2);
      } finally {
        store.close();
      }

      const upgradedDatabase = new BetterSqlite3(databaseFilePath, {
        readonly: true,
      });

      try {
        const migrationFiles = upgradedDatabase
          .prepare(
            [
              "SELECT",
              "  file_name AS fileName",
              "FROM orqis_schema_migrations",
              "ORDER BY file_name ASC",
            ].join("\n"),
          )
          .all() as Array<{ fileName: string }>;

        expect(migrationFiles.map((row) => row.fileName)).toEqual([
          "0001_project_workspace_schema.sql",
          "0002_agent_configuration.sql",
          "0003_task_assignments.sql",
        ]);
      } finally {
        upgradedDatabase.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "backfills assignment snapshots for legacy tasks when 0003 migrations are applied",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-task-backfill-"));
      const databaseFilePath = join(tempDir, "legacy-backfill.db");
      const legacyDatabase = new BetterSqlite3(databaseFilePath);

      try {
        legacyDatabase.function("orqis_audit_actor_type", () => null);
        legacyDatabase.function("orqis_audit_actor_id", () => null);
        legacyDatabase.function("orqis_audit_correlation_run_id", () => null);
        legacyDatabase.exec(
          readFileSync(
            new URL(
              "../../../packages/db/migrations/0001_project_workspace_schema.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        legacyDatabase.exec(
          readFileSync(
            new URL(
              "../../../packages/db/migrations/0002_agent_configuration.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        legacyDatabase
          .prepare("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
          .run("project_legacy", "project-legacy", "Legacy Project");
        legacyDatabase
          .prepare("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)")
          .run("workspace_legacy", "project_legacy", "Legacy Workspace");
        legacyDatabase
          .prepare(
            "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
          )
          .run("run_legacy", "project_legacy", "workspace_legacy", "planned");
        legacyDatabase
          .prepare(
            "INSERT INTO provider_configs (provider_key, display_name) VALUES (?, ?)",
          )
          .run("openai", "OpenAI");
        legacyDatabase
          .prepare(
            "INSERT INTO model_configs (model_key, provider_key, display_name) VALUES (?, ?, ?)",
          )
          .run("gpt-5", "openai", "GPT-5");
        legacyDatabase
          .prepare(
            "INSERT INTO agent_profiles (role_key, display_name, model_key, responsibility) VALUES (?, ?, ?, ?)",
          )
          .run(
            "backend_agent",
            "Backend Agent",
            "gpt-5",
            "Owns runtime behavior",
          );
        legacyDatabase
          .prepare(
            [
              "INSERT INTO tasks",
              "  (id, project_id, workspace_id, run_id, owner_role, title, state, created_at, updated_at)",
              "VALUES",
              "  (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ].join("\n"),
          )
          .run(
            "task_legacy",
            "project_legacy",
            "workspace_legacy",
            "run_legacy",
            "backend_agent",
            "Legacy task",
            "todo",
            "2026-03-10T08:00:00.000Z",
            "2026-03-10T08:00:00.000Z",
          );
      } finally {
        legacyDatabase.close();
      }

      const store = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const tasks = store.listWorkspaceTasks("workspace_legacy");
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          ownerRole: "backend_agent",
          ownerDisplayName: "Backend Agent",
          assignment: {
            roleKey: "backend_agent",
            roleDisplayName: "Backend Agent",
            modelKey: "gpt-5",
            roleResponsibility: "Owns runtime behavior",
          },
        });
      } finally {
        store.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );
});
