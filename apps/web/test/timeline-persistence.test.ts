import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  createWorkspaceTimelineStore,
  WorkspaceTimelineValidationError,
} from "../src/persistence.ts";
import { WORKSPACE_CI_INTEGRATION_TIMEOUT_MS } from "./integration-timeouts.ts";

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

        expect(messages).toHaveLength(2);
        expect(messages.map((message) => message.actorType)).toEqual([
          "user",
          "agent",
        ]);
        expect(messages[0]?.content).toBe("Implement the first approval workflow");
        expect(messages[1]?.content).toContain("Project Manager plan for:");
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
      } finally {
        database.close();
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
        ]);
      } finally {
        upgradedDatabase.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );
});
