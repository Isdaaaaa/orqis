import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createWorkspaceTimelineStore } from "../src/persistence.ts";

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
    75_000,
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
    75_000,
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
    75_000,
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
    75_000,
  );
});
