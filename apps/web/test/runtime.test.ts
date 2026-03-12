import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startOrqisWebRuntime } from "../src/index.ts";
import { WORKSPACE_CI_INTEGRATION_TIMEOUT_MS } from "./integration-timeouts.ts";

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

async function createSession(
  baseUrl: string,
  actorId: string,
  headers: Record<string, string> = {},
): Promise<{
  readonly cacheControl: string | null;
  readonly sessionCookie: string;
  readonly setCookieHeader: string;
}> {
  const createSessionResponse = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: {
      ...headers,
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

  const setCookieHeader = createSessionResponse.headers.get("set-cookie");

  if (setCookieHeader === null || setCookieHeader.length === 0) {
    throw new Error("expected set-cookie header for session creation response");
  }

  return {
    cacheControl: createSessionResponse.headers.get("cache-control"),
    sessionCookie: resolveSessionCookieValue(setCookieHeader),
    setCookieHeader,
  };
}

async function createSessionCookie(
  baseUrl: string,
  actorId: string,
): Promise<string> {
  const session = await createSession(baseUrl, actorId);
  return session.sessionCookie;
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

async function expectAuthenticationRequiredResponse(
  response: Response,
): Promise<void> {
  const body = (await response.json()) as { error?: string };

  expect(response.status).toBe(401);
  expect(body.error).toBe("Authentication required.");
}

function expectNoStoreCacheControl(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
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
        expectNoStoreCacheControl(unauthorizedLandingResponse);

        const loginPageResponse = await fetch(`${runtime.baseUrl}/login`);
        const loginPage = await loginPageResponse.text();

        expect(loginPageResponse.status).toBe(200);
        expect(loginPage).toContain("Sign in to Orqis");
        expectNoStoreCacheControl(loginPageResponse);

        const unauthorizedProjectsResponse = await fetch(`${runtime.baseUrl}/api/projects`);
        const unauthorizedProjectsBody =
          (await unauthorizedProjectsResponse.json()) as { error?: string };

        expect(unauthorizedProjectsResponse.status).toBe(401);
        expect(unauthorizedProjectsBody.error).toBe("Authentication required.");
        expectNoStoreCacheControl(unauthorizedProjectsResponse);

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
        expectNoStoreCacheControl(sessionResponse);

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
        expectNoStoreCacheControl(firstLandingResponse);

        const refreshedLandingResponse = await fetch(runtime.baseUrl, {
          headers: withSessionCookie(sessionCookie),
        });

        expect(refreshedLandingResponse.status).toBe(200);
        expectNoStoreCacheControl(refreshedLandingResponse);
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "covers auth session lifecycle edges for login redirect, logout cookie clearing, and workspace message protection",
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
        const workspaceMessagesUrl =
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent("workspace-edge")}/messages`;

        await expectAuthenticationRequiredResponse(
          await fetch(workspaceMessagesUrl),
        );

        await expectAuthenticationRequiredResponse(
          await fetch(workspaceMessagesUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectId: "project-edge",
              actorType: "user",
              actorId: "owner",
              content: "Unauthorized message",
            }),
          }),
        );

        const sessionCookie = await createSessionCookie(runtime.baseUrl, "owner");

        const authenticatedLoginResponse = await fetch(`${runtime.baseUrl}/login`, {
          headers: withSessionCookie(sessionCookie),
          redirect: "manual",
        });

        expect(authenticatedLoginResponse.status).toBe(302);
        expect(authenticatedLoginResponse.headers.get("location")).toBe("/");
        expectNoStoreCacheControl(authenticatedLoginResponse);

        const deleteSessionResponse = await fetch(`${runtime.baseUrl}/api/session`, {
          method: "DELETE",
          headers: withSessionCookie(sessionCookie),
        });
        const deleteSessionBody = (await deleteSessionResponse.json()) as {
          authenticated?: boolean;
        };
        const clearedSessionCookie = deleteSessionResponse.headers.get("set-cookie");

        expect(deleteSessionResponse.status).toBe(200);
        expect(deleteSessionBody).toEqual({
          authenticated: false,
        });
        expect(clearedSessionCookie).toContain("orqis_session=");
        expect(clearedSessionCookie).toContain("Path=/");
        expect(clearedSessionCookie).toContain("Max-Age=0");
        expect(clearedSessionCookie).toContain("HttpOnly");
        expect(clearedSessionCookie).toContain("SameSite=Lax");
        expectNoStoreCacheControl(deleteSessionResponse);

        const postDeleteSessionResponse = await fetch(`${runtime.baseUrl}/api/session`, {
          headers: withSessionCookie(sessionCookie),
        });
        const postDeleteSessionBody = (await postDeleteSessionResponse.json()) as {
          authenticated?: boolean;
          session?: null;
        };

        expect(postDeleteSessionResponse.status).toBe(200);
        expect(postDeleteSessionBody).toEqual({
          authenticated: false,
          session: null,
        });
        expectNoStoreCacheControl(postDeleteSessionResponse);

        const postDeleteLandingResponse = await fetch(runtime.baseUrl, {
          headers: withSessionCookie(sessionCookie),
          redirect: "manual",
        });

        expect(postDeleteLandingResponse.status).toBe(302);
        expect(postDeleteLandingResponse.headers.get("location")).toBe("/login");
        expectNoStoreCacheControl(postDeleteLandingResponse);
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "serves authenticated agent-configuration reads and writes with persisted role mappings",
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
        const configurationUrl = `${runtime.baseUrl}/api/settings/agent-configuration`;

        await expectAuthenticationRequiredResponse(
          await fetch(configurationUrl),
        );

        const sessionCookie = await createSessionCookie(runtime.baseUrl, "owner");

        const initialConfigurationResponse = await fetch(configurationUrl, {
          headers: withSessionCookie(sessionCookie),
        });
        const initialConfigurationBody =
          (await initialConfigurationResponse.json()) as {
            configuration?: {
              providers?: Array<{ providerKey?: string }>;
              models?: Array<{ modelKey?: string }>;
              agentRoles?: Array<{ roleKey?: string }>;
            };
          };

        expect(initialConfigurationResponse.status).toBe(200);
        expectNoStoreCacheControl(initialConfigurationResponse);
        expect(
          initialConfigurationBody.configuration?.providers?.[0]?.providerKey,
        ).toBe("openai");
        expect(initialConfigurationBody.configuration?.models?.[0]?.modelKey).toBe(
          "gpt-5",
        );
        expect(
          initialConfigurationBody.configuration?.agentRoles?.length,
        ).toBeGreaterThanOrEqual(2);

        const saveConfigurationResponse = await fetch(configurationUrl, {
          method: "PUT",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
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
                responsibility: "Creates plans and coordinates approvals.",
              },
              {
                roleKey: "backend_agent",
                displayName: "Backend Agent",
                modelKey: "claude-sonnet-4",
                responsibility: "Owns runtime behavior and persistence changes.",
              },
            ],
          }),
        });
        const saveConfigurationBody =
          (await saveConfigurationResponse.json()) as {
            configuration?: {
              providers?: Array<{ providerKey?: string; baseUrl?: string | null }>;
              models?: Array<{ modelKey?: string; providerKey?: string }>;
              agentRoles?: Array<{ roleKey?: string; modelKey?: string }>;
            };
          };

        expect(saveConfigurationResponse.status).toBe(200);
        expectNoStoreCacheControl(saveConfigurationResponse);
        expect(
          saveConfigurationBody.configuration?.providers?.[0],
        ).toMatchObject({
          providerKey: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
        });
        expect(saveConfigurationBody.configuration?.models?.[0]).toMatchObject({
          modelKey: "claude-sonnet-4",
          providerKey: "anthropic",
        });
        expect(
          saveConfigurationBody.configuration?.agentRoles?.map((agentRole) =>
            agentRole.roleKey
          ),
        ).toEqual(["project_manager", "backend_agent"]);

        const invalidConfigurationResponse = await fetch(configurationUrl, {
          method: "PUT",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            providers: [
              {
                providerKey: "anthropic",
                displayName: "Anthropic",
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
                responsibility: "Creates plans and coordinates approvals.",
              },
            ],
          }),
        });
        const invalidConfigurationBody =
          (await invalidConfigurationResponse.json()) as { error?: string };

        expect(invalidConfigurationResponse.status).toBe(400);
        expectNoStoreCacheControl(invalidConfigurationResponse);
        expect(invalidConfigurationBody.error).toBe(
          "At least two agent role configurations are required.",
        );

        const missingProjectManagerResponse = await fetch(configurationUrl, {
          method: "PUT",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
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
                roleKey: "pm",
                displayName: "Project Manager",
                modelKey: "claude-sonnet-4",
                responsibility: "Creates plans and coordinates approvals.",
              },
              {
                roleKey: "backend_agent",
                displayName: "Backend Agent",
                modelKey: "claude-sonnet-4",
                responsibility: "Owns runtime behavior and persistence changes.",
              },
            ],
          }),
        });
        const missingProjectManagerBody =
          (await missingProjectManagerResponse.json()) as { error?: string };

        expect(missingProjectManagerResponse.status).toBe(400);
        expectNoStoreCacheControl(missingProjectManagerResponse);
        expect(missingProjectManagerBody.error).toBe(
          'agentRoles must include the reserved "project_manager" role key for planner compatibility.',
        );

        const createProjectResponse = await fetch(`${runtime.baseUrl}/api/projects`, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "Planner After Rejected Config",
          }),
        });
        const createProjectBody = (await createProjectResponse.json()) as {
          project?: {
            projectId: string;
            workspaceId: string;
          };
        };

        expect(createProjectResponse.status).toBe(201);

        const createdProject = createProjectBody.project;

        if (createdProject === undefined) {
          throw new Error("expected project details after rejected config save");
        }

        const createPlanResponse = await fetch(
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/planner/runs`,
          {
            method: "POST",
            headers: withSessionCookie(sessionCookie, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              projectId: createdProject.projectId,
              goal: "Plan after rejected PM rename",
            }),
          },
        );
        const createPlanBody = (await createPlanResponse.json()) as {
          plan?: {
            projectManagerRoleKey?: string;
          };
          error?: string;
        };

        expect(createPlanResponse.status).toBe(201);
        expectNoStoreCacheControl(createPlanResponse);
        expect(createPlanBody.plan?.projectManagerRoleKey).toBe("project_manager");
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "creates a Project Manager plan through the authenticated workspace planner API and emits visible timeline messages",
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
        const sessionCookie = await createSessionCookie(runtime.baseUrl, "owner");

        const createProjectResponse = await fetch(`${runtime.baseUrl}/api/projects`, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "Planner Runtime Project",
          }),
        });
        const createProjectBody = (await createProjectResponse.json()) as {
          project?: {
            projectId: string;
            workspaceId: string;
          };
        };

        expect(createProjectResponse.status).toBe(201);

        const createdProject = createProjectBody.project;

        if (createdProject === undefined) {
          throw new Error("expected project details for planner runtime assertions");
        }

        const plannerUrl =
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/planner/runs`;

        await expectAuthenticationRequiredResponse(
          await fetch(plannerUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectId: createdProject.projectId,
              goal: "Plan the first release candidate",
            }),
          }),
        );

        const createPlanResponse = await fetch(plannerUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            projectId: createdProject.projectId,
            goal: "Plan the first release candidate",
          }),
        });
        const createPlanBody = (await createPlanResponse.json()) as {
          plan?: {
            runId?: string;
            summary?: string;
            projectManagerRoleKey?: string;
            tasks?: Array<{ ownerRole?: string }>;
          };
          error?: string;
        };

        expect(createPlanResponse.status).toBe(201);
        expectNoStoreCacheControl(createPlanResponse);
        expect(createPlanBody.plan?.runId).toBeTypeOf("string");
        expect(createPlanBody.plan?.summary).toContain("release candidate");
        expect(createPlanBody.plan?.projectManagerRoleKey).toBe("project_manager");
        expect(createPlanBody.plan?.tasks?.map((task) => task.ownerRole)).toEqual([
          "frontend_agent",
          "backend_agent",
          "reviewer",
        ]);

        const timelineResponse = await fetch(
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/messages`,
          {
            headers: withSessionCookie(sessionCookie),
          },
        );
        const timelineBody = (await timelineResponse.json()) as {
          messages?: Array<{
            actorType?: string;
            actorId?: string | null;
            content?: string;
          }>;
        };

        expect(timelineResponse.status).toBe(200);
        expectNoStoreCacheControl(timelineResponse);
        expect(timelineBody.messages).toHaveLength(2);
        expect(timelineBody.messages?.[0]).toMatchObject({
          actorType: "user",
          actorId: "owner",
          content: "Plan the first release candidate",
        });
        expect(timelineBody.messages?.[1]).toMatchObject({
          actorType: "agent",
          actorId: "project_manager",
        });
        expect(timelineBody.messages?.[1]?.content).toContain(
          "Project Manager plan for:",
        );

        const landingResponse = await fetch(runtime.baseUrl, {
          headers: withSessionCookie(sessionCookie),
        });
        const landingPage = await landingResponse.text();

        expect(landingResponse.status).toBe(200);
        expect(landingPage).toContain("Create plan");
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "serves role-mapped task records and deterministic checkout conflicts through authenticated task APIs",
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
        const sessionCookie = await createSessionCookie(runtime.baseUrl, "owner");

        const createProjectResponse = await fetch(`${runtime.baseUrl}/api/projects`, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "Task API Project",
          }),
        });
        const createProjectBody = (await createProjectResponse.json()) as {
          project?: {
            projectId: string;
            workspaceId: string;
          };
        };

        expect(createProjectResponse.status).toBe(201);

        const createdProject = createProjectBody.project;

        if (createdProject === undefined) {
          throw new Error("expected project details for task API assertions");
        }

        const createPlanResponse = await fetch(
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/planner/runs`,
          {
            method: "POST",
            headers: withSessionCookie(sessionCookie, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              projectId: createdProject.projectId,
              goal: "Wire task assignment APIs",
            }),
          },
        );
        const createPlanBody = (await createPlanResponse.json()) as {
          plan?: {
            runId?: string;
          };
        };

        expect(createPlanResponse.status).toBe(201);

        const planRunId = createPlanBody.plan?.runId;

        if (planRunId === undefined) {
          throw new Error("expected plan runId for task API assertions");
        }

        const tasksUrl =
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/tasks`;

        await expectAuthenticationRequiredResponse(await fetch(tasksUrl));

        const tasksResponse = await fetch(tasksUrl, {
          headers: withSessionCookie(sessionCookie),
        });
        const tasksBody = (await tasksResponse.json()) as {
          tasks?: Array<{
            id?: string;
            ownerRole?: string | null;
            assignment?: {
              roleKey?: string;
              roleDisplayName?: string;
              modelKey?: string | null;
            } | null;
          }>;
        };

        expect(tasksResponse.status).toBe(200);
        expectNoStoreCacheControl(tasksResponse);
        expect(tasksBody.tasks).toHaveLength(3);

        const backendTask = tasksBody.tasks?.find(
          (task) => task.ownerRole === "backend_agent",
        );
        const reviewerTask = tasksBody.tasks?.find(
          (task) => task.ownerRole === "reviewer",
        );

        expect(backendTask?.assignment).toMatchObject({
          roleKey: "backend_agent",
          roleDisplayName: "Backend Agent",
          modelKey: "gpt-5",
        });

        const backendTaskId = backendTask?.id;

        if (backendTaskId === undefined) {
          throw new Error("expected backend task id for checkout assertions");
        }

        const reviewerTaskId = reviewerTask?.id;

        if (reviewerTaskId === undefined) {
          throw new Error("expected reviewer task id for run-owner assertions");
        }

        const checkoutUrl =
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/tasks/${encodeURIComponent(backendTaskId)}/checkout`;
        const reviewerCheckoutUrl =
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/tasks/${encodeURIComponent(reviewerTaskId)}/checkout`;
        const reviewerReleaseUrl =
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/tasks/${encodeURIComponent(reviewerTaskId)}/release`;

        const checkoutResponse = await fetch(checkoutUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: planRunId,
            ownerType: "agent",
            ownerId: "backend_agent",
          }),
        });
        const checkoutBody = (await checkoutResponse.json()) as {
          task?: {
            state?: string;
            executionRunId?: string | null;
            checkoutRunId?: string | null;
            lockOwnerId?: string | null;
          };
        };

        expect(checkoutResponse.status).toBe(200);
        expectNoStoreCacheControl(checkoutResponse);
        expect(checkoutBody.task).toMatchObject({
          state: "in_progress",
          executionRunId: planRunId,
          checkoutRunId: planRunId,
          lockOwnerId: "backend_agent",
        });

        const wrongRoleCheckoutResponse = await fetch(checkoutUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: "run-competing",
            ownerType: "agent",
            ownerId: "reviewer",
          }),
        });
        const wrongRoleCheckoutBody =
          (await wrongRoleCheckoutResponse.json()) as {
            code?: string;
            assignedRoleKey?: string | null;
            attemptedRoleKey?: string;
          };

        expect(wrongRoleCheckoutResponse.status).toBe(409);
        expectNoStoreCacheControl(wrongRoleCheckoutResponse);
        expect(wrongRoleCheckoutBody).toMatchObject({
          code: "task_assigned_to_another_role",
          assignedRoleKey: "backend_agent",
          attemptedRoleKey: "reviewer",
        });

        const lockedCheckoutResponse = await fetch(checkoutUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: "run-competing",
            ownerType: "agent",
            ownerId: "backend_agent",
          }),
        });
        const lockedCheckoutBody = (await lockedCheckoutResponse.json()) as {
          code?: string;
          currentExecutionRunId?: string | null;
          currentCheckoutRunId?: string | null;
        };

        expect(lockedCheckoutResponse.status).toBe(409);
        expectNoStoreCacheControl(lockedCheckoutResponse);
        expect(lockedCheckoutBody).toMatchObject({
          code: "task_execution_locked",
          currentExecutionRunId: planRunId,
          currentCheckoutRunId: planRunId,
        });

        const mismatchedRunCheckoutResponse = await fetch(reviewerCheckoutUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: planRunId,
            ownerType: "run",
            ownerId: "run-other",
          }),
        });
        const mismatchedRunCheckoutBody =
          (await mismatchedRunCheckoutResponse.json()) as {
            error?: string;
          };

        expect(mismatchedRunCheckoutResponse.status).toBe(400);
        expectNoStoreCacheControl(mismatchedRunCheckoutResponse);
        expect(mismatchedRunCheckoutBody.error).toBe(
          "ownerId must equal runId when ownerType is run.",
        );

        const runCheckoutResponse = await fetch(reviewerCheckoutUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: planRunId,
            ownerType: "run",
          }),
        });
        const runCheckoutBody = (await runCheckoutResponse.json()) as {
          task?: {
            lockOwnerType?: string | null;
            lockOwnerId?: string | null;
            executionRunId?: string | null;
          };
        };

        expect(runCheckoutResponse.status).toBe(200);
        expectNoStoreCacheControl(runCheckoutResponse);
        expect(runCheckoutBody.task).toMatchObject({
          lockOwnerType: "run",
          lockOwnerId: planRunId,
          executionRunId: planRunId,
        });

        const mismatchedRunReleaseResponse = await fetch(reviewerReleaseUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: planRunId,
            ownerType: "run",
            ownerId: "run-other",
          }),
        });
        const mismatchedRunReleaseBody =
          (await mismatchedRunReleaseResponse.json()) as {
            error?: string;
          };

        expect(mismatchedRunReleaseResponse.status).toBe(400);
        expectNoStoreCacheControl(mismatchedRunReleaseResponse);
        expect(mismatchedRunReleaseBody.error).toBe(
          "ownerId must equal runId when ownerType is run.",
        );

        const runReleaseResponse = await fetch(reviewerReleaseUrl, {
          method: "POST",
          headers: withSessionCookie(sessionCookie, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            runId: planRunId,
            ownerType: "run",
          }),
        });
        const runReleaseBody = (await runReleaseResponse.json()) as {
          task?: {
            lockOwnerId?: string | null;
            executionRunId?: string | null;
          };
        };

        expect(runReleaseResponse.status).toBe(200);
        expectNoStoreCacheControl(runReleaseResponse);
        expect(runReleaseBody.task).toMatchObject({
          lockOwnerId: planRunId,
          executionRunId: null,
        });

        const releaseResponse = await fetch(
          `${runtime.baseUrl}/api/workspaces/${encodeURIComponent(createdProject.workspaceId)}/tasks/${encodeURIComponent(backendTaskId)}/release`,
          {
            method: "POST",
            headers: withSessionCookie(sessionCookie, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              runId: planRunId,
              ownerType: "agent",
              ownerId: "backend_agent",
            }),
          },
        );
        const releaseBody = (await releaseResponse.json()) as {
          task?: {
            executionRunId?: string | null;
            checkoutRunId?: string | null;
            lockOwnerId?: string | null;
          };
        };

        expect(releaseResponse.status).toBe(200);
        expectNoStoreCacheControl(releaseResponse);
        expect(releaseBody.task).toMatchObject({
          executionRunId: null,
          checkoutRunId: planRunId,
          lockOwnerId: "backend_agent",
        });
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "adds Secure to session cookies when auth requests are forwarded as HTTPS",
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
        const localHttpSession = await createSession(runtime.baseUrl, "owner-local");
        expect(localHttpSession.setCookieHeader).not.toContain("Secure");
        expect(localHttpSession.cacheControl).toBe("no-store");

        const forwardedHttpsSession = await createSession(
          runtime.baseUrl,
          "owner-tunnel",
          {
            "x-forwarded-proto": "https",
          },
        );

        expect(forwardedHttpsSession.setCookieHeader).toContain("Secure");
        expect(forwardedHttpsSession.cacheControl).toBe("no-store");

        const deleteSessionResponse = await fetch(`${runtime.baseUrl}/api/session`, {
          method: "DELETE",
          headers: withSessionCookie(forwardedHttpsSession.sessionCookie, {
            "x-forwarded-proto": "https",
          }),
        });
        const clearedSessionCookie = deleteSessionResponse.headers.get("set-cookie");

        expect(deleteSessionResponse.status).toBe(200);
        expect(clearedSessionCookie).toContain("Secure");
        expectNoStoreCacheControl(deleteSessionResponse);
      } finally {
        await runtime.stop();
        await cleanup();
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
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
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
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
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );
});
