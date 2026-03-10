import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startOrqisWebRuntime } from "../src/index.ts";

async function createRuntimeDatabaseFilePath(): Promise<{
  readonly databaseFilePath: string;
  cleanup(): Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-runtime-"));

  return {
    databaseFilePath: join(tempDir, "runtime.db"),
    cleanup: async (): Promise<void> => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe("@orqis/web runtime", () => {
  it(
    "serves a health endpoint and landing page",
    async () => {
      const { databaseFilePath, cleanup } = await createRuntimeDatabaseFilePath();
      const runtime = await startOrqisWebRuntime({
        host: "127.0.0.1",
        port: 0,
        persistence: {
          databaseFilePath,
        },
      });

      try {
        const healthResponse = await fetch(runtime.healthUrl);
        const health = (await healthResponse.json()) as {
          service?: string;
          status?: string;
          uptimeMs?: number;
        };

        expect(healthResponse.status).toBe(200);
        expect(health).toMatchObject({
          service: "@orqis/web",
          status: "ok",
        });
        expect(health.uptimeMs).toBeTypeOf("number");

        const landingResponse = await fetch(runtime.baseUrl);
        const landingPage = await landingResponse.text();

        expect(landingResponse.status).toBe(200);
        expect(landingPage).toContain("Orqis control center");
        expect(landingPage).toContain("Main Chat");
        expect(landingPage).toContain("Files");
        expect(landingPage).toContain("Agent Threads");
        expect(landingPage).toContain("PM -> Frontend Agent");
        expect(landingPage).toContain("PM -> Backend Agent");
        expect(landingPage).toContain("PM -> Reviewer");
        expect(landingPage).toContain("Assigned Agents");
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    45_000,
  );

  it(
    "creates and lists projects with a persistent workspace mapping across runtime restarts",
    async () => {
      const { databaseFilePath, cleanup } = await createRuntimeDatabaseFilePath();

      const firstRuntime = await startOrqisWebRuntime({
        host: "127.0.0.1",
        port: 0,
        persistence: {
          databaseFilePath,
        },
      });

      let createdProject:
        | {
            readonly projectId: string;
            readonly projectSlug: string;
            readonly projectName: string;
            readonly workspaceId: string;
          }
        | undefined;

      try {
        const createProjectResponse = await fetch(`${firstRuntime.baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Project Alpha",
            description: "Scope for alpha",
          }),
        });
        const createProjectBody = (await createProjectResponse.json()) as {
          project?: {
            projectId: string;
            projectSlug: string;
            projectName: string;
            workspaceId: string;
            projectDescription: string | null;
          };
          error?: string;
        };

        expect(createProjectResponse.status).toBe(201);
        expect(createProjectBody.project).toBeDefined();
        expect(createProjectBody.project).toMatchObject({
          projectSlug: "project-alpha",
          projectName: "Project Alpha",
          projectDescription: "Scope for alpha",
        });

        createdProject = createProjectBody.project;

        if (createdProject === undefined) {
          throw new Error("project create response did not include project details");
        }

        const listProjectsResponse = await fetch(`${firstRuntime.baseUrl}/api/projects`);
        const listProjectsBody = (await listProjectsResponse.json()) as {
          projects?: Array<{
            projectId: string;
            projectSlug: string;
            projectName: string;
            workspaceId: string;
          }>;
          error?: string;
        };

        expect(listProjectsResponse.status).toBe(200);
        expect(listProjectsBody.projects).toHaveLength(1);
        expect(listProjectsBody.projects?.[0]).toMatchObject({
          projectId: createdProject.projectId,
          workspaceId: createdProject.workspaceId,
        });

        const appendMessageResponse = await fetch(
          `${firstRuntime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectId: createdProject.projectId,
              actorType: "user",
              actorId: "alice",
              content: "Kickoff message",
            }),
          },
        );

        expect(appendMessageResponse.status).toBe(201);
      } finally {
        await firstRuntime.stop();
      }

      expect(createdProject).toBeDefined();
      const persistedProject = createdProject;

      if (persistedProject === undefined) {
        throw new Error("created project is required for persistence assertions");
      }

      const secondRuntime = await startOrqisWebRuntime({
        host: "127.0.0.1",
        port: 0,
        persistence: {
          databaseFilePath,
        },
      });

      try {
        const listProjectsResponse = await fetch(`${secondRuntime.baseUrl}/api/projects`);
        const listProjectsBody = (await listProjectsResponse.json()) as {
          projects?: Array<{
            projectId: string;
            workspaceId: string;
          }>;
          error?: string;
        };

        expect(listProjectsResponse.status).toBe(200);
        expect(listProjectsBody.projects).toHaveLength(1);
        expect(listProjectsBody.projects?.[0]).toMatchObject({
          projectId: persistedProject.projectId,
          workspaceId: persistedProject.workspaceId,
        });

        const timelineResponse = await fetch(
          `${secondRuntime.baseUrl}/api/workspaces/${encodeURIComponent(persistedProject.workspaceId)}/messages`,
        );
        const timelineBody = (await timelineResponse.json()) as {
          messages?: Array<{
            projectId: string;
            workspaceId: string;
            content: string;
          }>;
          error?: string;
        };

        expect(timelineResponse.status).toBe(200);
        expect(timelineBody.messages).toHaveLength(1);
        expect(timelineBody.messages?.[0]).toMatchObject({
          projectId: persistedProject.projectId,
          workspaceId: persistedProject.workspaceId,
          content: "Kickoff message",
        });
      } finally {
        await secondRuntime.stop();
        await cleanup();
      }
    },
    45_000,
  );

  it(
    "returns 404 for unknown routes and can stop twice safely",
    async () => {
      const { databaseFilePath, cleanup } = await createRuntimeDatabaseFilePath();
      const runtime = await startOrqisWebRuntime({
        host: "127.0.0.1",
        port: 0,
        persistence: {
          databaseFilePath,
        },
      });

      try {
        const response = await fetch(`${runtime.baseUrl}/missing`);
        const body = (await response.json()) as { error?: string; path?: string };

        expect(response.status).toBe(404);
        expect(body).toEqual({
          error: "Not Found",
          path: "/missing",
        });
      } finally {
        await runtime.stop();
        await runtime.stop();
        await cleanup();
      }
    },
    45_000,
  );
});
