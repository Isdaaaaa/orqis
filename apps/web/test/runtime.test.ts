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

function resolveSessionCookieValue(setCookieHeader: string | null): string {
  if (setCookieHeader === null || setCookieHeader.length === 0) {
    throw new Error("expected set-cookie header for session creation response");
  }

  const [cookie] = setCookieHeader.split(";");

  if (cookie === undefined || cookie.length === 0) {
    throw new Error("session cookie header did not include a cookie value");
  }

  return cookie;
}

async function createSessionCookie(
  baseUrl: string,
  actorId: string,
): Promise<string> {
  const createSessionResponse = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      actorId,
    }),
  });
  const createSessionBody = (await createSessionResponse.json()) as {
    authenticated?: boolean;
    session?: {
      actorId?: string;
    };
    error?: string;
  };

  expect(createSessionResponse.status).toBe(201);
  expect(createSessionBody.authenticated).toBe(true);
  expect(createSessionBody.session?.actorId).toBe(actorId);

  return resolveSessionCookieValue(createSessionResponse.headers.get("set-cookie"));
}

function withSessionCookie(
  sessionCookie: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    cookie: sessionCookie,
  };
}

describe("@orqis/web runtime", () => {
  it(
    "serves a health endpoint and enforces local session auth before loading the workspace shell",
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

        const unauthorizedLandingResponse = await fetch(runtime.baseUrl, {
          redirect: "manual",
        });

        expect(unauthorizedLandingResponse.status).toBe(302);
        expect(unauthorizedLandingResponse.headers.get("location")).toBe("/login");

        const loginPageResponse = await fetch(`${runtime.baseUrl}/login`);
        const loginPage = await loginPageResponse.text();

        expect(loginPageResponse.status).toBe(200);
        expect(loginPage).toContain("Sign in to Orqis");

        const unauthorizedProjectsResponse = await fetch(`${runtime.baseUrl}/api/projects`);
        const unauthorizedProjectsBody =
          (await unauthorizedProjectsResponse.json()) as { error?: string };

        expect(unauthorizedProjectsResponse.status).toBe(401);
        expect(unauthorizedProjectsBody.error).toBe("Authentication required.");

        const sessionCookie = await createSessionCookie(runtime.baseUrl, "owner");

        const sessionResponse = await fetch(`${runtime.baseUrl}/api/session`, {
          headers: withSessionCookie(sessionCookie),
        });
        const sessionBody = (await sessionResponse.json()) as {
          authenticated?: boolean;
          session?: {
            actorId?: string;
          };
        };

        expect(sessionResponse.status).toBe(200);
        expect(sessionBody.authenticated).toBe(true);
        expect(sessionBody.session?.actorId).toBe("owner");

        const firstLandingResponse = await fetch(runtime.baseUrl, {
          headers: withSessionCookie(sessionCookie),
        });
        const firstLandingPage = await firstLandingResponse.text();

        expect(firstLandingResponse.status).toBe(200);
        expect(firstLandingPage).toContain("Orqis control center");
        expect(firstLandingPage).toContain("Main Chat");
        expect(firstLandingPage).toContain("Files");
        expect(firstLandingPage).toContain("Agent Threads");
        expect(firstLandingPage).toContain("PM -> Frontend Agent");
        expect(firstLandingPage).toContain("PM -> Backend Agent");
        expect(firstLandingPage).toContain("PM -> Reviewer");
        expect(firstLandingPage).toContain("Assigned Agents");
        expect(firstLandingPage).toContain("Log out");

        const refreshedLandingResponse = await fetch(runtime.baseUrl, {
          headers: withSessionCookie(sessionCookie),
        });

        expect(refreshedLandingResponse.status).toBe(200);
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    75_000,
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
      let firstRuntimeSessionCookie = "";

      try {
        firstRuntimeSessionCookie = await createSessionCookie(
          firstRuntime.baseUrl,
          "owner",
        );

        const createProjectResponse = await fetch(`${firstRuntime.baseUrl}/api/projects`, {
          method: "POST",
          headers: withSessionCookie(firstRuntimeSessionCookie, {
            "content-type": "application/json",
          }),
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

        const listProjectsResponse = await fetch(`${firstRuntime.baseUrl}/api/projects`, {
          headers: withSessionCookie(firstRuntimeSessionCookie),
        });
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
            headers: withSessionCookie(firstRuntimeSessionCookie, {
              "content-type": "application/json",
            }),
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
        const staleSessionResponse = await fetch(`${secondRuntime.baseUrl}/api/projects`, {
          headers: withSessionCookie(firstRuntimeSessionCookie),
        });

        expect(staleSessionResponse.status).toBe(401);

        const secondRuntimeSessionCookie = await createSessionCookie(
          secondRuntime.baseUrl,
          "owner",
        );

        const listProjectsResponse = await fetch(`${secondRuntime.baseUrl}/api/projects`, {
          headers: withSessionCookie(secondRuntimeSessionCookie),
        });
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
          {
            headers: withSessionCookie(secondRuntimeSessionCookie),
          },
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
    75_000,
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
    75_000,
  );
});
