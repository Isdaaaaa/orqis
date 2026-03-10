import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createWorkspaceTimelineStore,
  type AppendWorkspaceTimelineMessageInput,
  type WorkspaceMessageActorType,
  type WorkspaceTimelineStore,
  type WorkspaceTimelineStoreOptions,
  WorkspaceTimelineConflictError,
  WorkspaceTimelineValidationError,
} from "./persistence.js";

export const WEB_PACKAGE_NAME = "@orqis/web";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const PROJECTS_PATH = "/api/projects";
const WORKSPACE_MESSAGES_PATH_PATTERN = /^\/api\/workspaces\/([^/]+)\/messages$/;
const WORKSPACE_MESSAGE_ACTOR_TYPES = ["user", "agent", "system"] as const;

export interface StartOrqisWebRuntimeOptions {
  readonly host: string;
  readonly port: number;
  readonly persistence?: WorkspaceTimelineStoreOptions;
}

export interface OrqisWebRuntimeHealthPayload {
  readonly service: typeof WEB_PACKAGE_NAME;
  readonly status: "ok";
  readonly uptimeMs: number;
}

export interface OrqisWebRuntimeHandle {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly healthUrl: string;
  readonly databaseFilePath: string;
  stop(): Promise<void>;
}

interface RuntimeRequestContext {
  readonly startedAt: number;
  readonly timelineStore: WorkspaceTimelineStore;
}

interface PostWorkspaceMessageBody {
  readonly projectId?: string;
  readonly actorType: WorkspaceMessageActorType;
  readonly actorId?: string;
  readonly content: string;
}

interface CreateProjectBody {
  readonly name: string;
  readonly description?: string;
}

class RequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

class RequestBodyTooLargeError extends RequestBodyError {}
class RequestBodyJsonParseError extends RequestBodyError {}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getWebAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orqis Workspace Timeline</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #f3f4f6; color: #111827; }
    main { max-width: 960px; margin: 0 auto; padding: 1.5rem 1rem 2rem; }
    h1 { margin-bottom: 0.25rem; }
    p { margin-top: 0; color: #4b5563; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1rem; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    .controls { display: grid; gap: 0.75rem; margin-bottom: 1rem; }
    .row { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); align-items: end; }
    .project-summary { font-size: 0.88rem; color: #374151; }
    label { display: grid; gap: 0.35rem; font-size: 0.9rem; color: #374151; }
    input, select, textarea, button { font: inherit; border-radius: 8px; border: 1px solid #d1d5db; }
    input, select, textarea { padding: 0.5rem 0.65rem; background: #fff; }
    textarea { min-height: 90px; resize: vertical; }
    button { padding: 0.55rem 0.9rem; background: #111827; color: #fff; border: none; cursor: pointer; }
    button.secondary { background: #4b5563; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    #status { min-height: 1.25rem; font-size: 0.9rem; color: #1f2937; }
    #messages { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
    #messages li { border: 1px solid #e5e7eb; border-radius: 10px; padding: 0.75rem; background: #fafafa; }
    .meta { font-size: 0.78rem; color: #6b7280; margin-bottom: 0.4rem; }
    .content { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <main>
    <h1>Orqis workspace timeline</h1>
    <p>Orqis control center workspace group chat timeline with persistent message history.</p>
    <section class="card">
      <div class="controls">
        <div class="row">
          <label>Create project
            <input id="new-project-name" placeholder="Website redesign" />
          </label>
          <label>Project description (optional)
            <input id="new-project-description" placeholder="Internal scope notes" />
          </label>
          <div class="actions">
            <button id="create-project">Create project</button>
            <button id="refresh-projects" class="secondary">Refresh projects</button>
          </div>
        </div>
        <div class="row">
          <label>Select project
            <select id="project-select"></select>
          </label>
          <div class="project-summary">Workspace: <strong id="selected-workspace">none</strong></div>
        </div>
        <div class="row">
          <label>Actor type
            <select id="actor-type">
              <option value="user">user</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
          </label>
          <label>Actor ID (optional) <input id="actor-id" placeholder="pm-agent" /></label>
        </div>
        <label>Message <textarea id="message-content" placeholder="Post a workspace update..."></textarea></label>
        <div class="actions">
          <button id="send-message">Send message</button>
          <button id="reload-messages" class="secondary">Reload timeline</button>
        </div>
        <div id="status"></div>
      </div>
      <ul id="messages"></ul>
    </section>
  </main>
  <script type="module">
    const projectNameInput = document.getElementById("new-project-name");
    const projectDescriptionInput = document.getElementById("new-project-description");
    const createProjectButton = document.getElementById("create-project");
    const refreshProjectsButton = document.getElementById("refresh-projects");
    const projectSelect = document.getElementById("project-select");
    const selectedWorkspace = document.getElementById("selected-workspace");
    const actorTypeInput = document.getElementById("actor-type");
    const actorIdInput = document.getElementById("actor-id");
    const contentInput = document.getElementById("message-content");
    const sendButton = document.getElementById("send-message");
    const reloadButton = document.getElementById("reload-messages");
    const status = document.getElementById("status");
    const messagesList = document.getElementById("messages");
    const projectsUrl = "/api/projects";

    let projects = [];

    const setStatus = (message, isError = false) => {
      status.textContent = message;
      status.style.color = isError ? "#b91c1c" : "#1f2937";
    };

    const renderMessages = (messages) => {
      messagesList.innerHTML = "";
      if (!Array.isArray(messages) || messages.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No messages yet for this workspace.";
        messagesList.appendChild(item);
        return;
      }

      for (const message of messages) {
        const item = document.createElement("li");
        const meta = document.createElement("div");
        meta.className = "meta";

        const actorLabel = message.actorId
          ? message.actorType + ":" + message.actorId
          : message.actorType;

        meta.textContent =
          (message.createdAt ?? "") +
          " • " +
          actorLabel +
          " • project=" +
          message.projectId +
          " • workspace=" +
          message.workspaceId;

        const content = document.createElement("div");
        content.className = "content";
        content.textContent = String(message.content ?? "");

        item.append(meta, content);
        messagesList.appendChild(item);
      }
    };

    const getSelectedProject = () => {
      const selectedProjectId = projectSelect.value;

      for (const project of projects) {
        if (project.projectId === selectedProjectId) {
          return project;
        }
      }

      return null;
    };

    const updateSelectedProjectState = () => {
      const selectedProject = getSelectedProject();

      if (selectedProject === null) {
        selectedWorkspace.textContent = "none";
        sendButton.disabled = true;
        reloadButton.disabled = true;
        return;
      }

      selectedWorkspace.textContent = selectedProject.workspaceId;
      sendButton.disabled = false;
      reloadButton.disabled = false;
    };

    const timelineUrl = () => {
      const selectedProject = getSelectedProject();

      if (selectedProject === null) {
        return null;
      }

      return "/api/workspaces/" + encodeURIComponent(selectedProject.workspaceId) + "/messages";
    };

    const reloadTimeline = async (announce = true) => {
      const selectedProject = getSelectedProject();
      const url = timelineUrl();

      if (selectedProject === null || url === null) {
        renderMessages([]);
        if (announce) {
          setStatus("Create and select a project first.", true);
        }
        return;
      }

      const response = await fetch(url);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load timeline.");
      }

      renderMessages(payload.messages);

      if (announce) {
        setStatus("Timeline loaded for " + selectedProject.projectName + ".");
      }
    };

    const renderProjectOptions = (preferredProjectId) => {
      projectSelect.innerHTML = "";

      if (projects.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No projects yet";
        option.disabled = true;
        option.selected = true;
        projectSelect.appendChild(option);
        projectSelect.disabled = true;
        updateSelectedProjectState();
        renderMessages([]);
        return null;
      }

      for (const project of projects) {
        const option = document.createElement("option");
        option.value = project.projectId;
        option.textContent = project.projectName + " (" + project.projectSlug + ")";
        projectSelect.appendChild(option);
      }

      projectSelect.disabled = false;
      const hasPreferredProject = projects.some(
        (project) => project.projectId === preferredProjectId,
      );
      projectSelect.value = hasPreferredProject
        ? preferredProjectId
        : projects[0].projectId;
      updateSelectedProjectState();
      return getSelectedProject();
    };

    const loadProjects = async (preferredProjectId = undefined) => {
      const response = await fetch(projectsUrl);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load projects.");
      }

      projects = Array.isArray(payload.projects) ? payload.projects : [];

      const selectedProject = renderProjectOptions(preferredProjectId ?? projectSelect.value);

      if (selectedProject === null) {
        return false;
      }

      await reloadTimeline(false);
      return true;
    };

    const createProject = async () => {
      const name = projectNameInput.value.trim();
      const description = projectDescriptionInput.value.trim();

      if (name.length === 0) {
        setStatus("Project name is required.", true);
        return;
      }

      const response = await fetch(projectsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: description.length > 0 ? description : undefined,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to create project.");
      }

      projectNameInput.value = "";
      projectDescriptionInput.value = "";
      await loadProjects(payload.project?.projectId);
      setStatus("Project created.");
    };

    const sendMessage = async () => {
      const selectedProject = getSelectedProject();
      const url = timelineUrl();

      if (selectedProject === null || url === null) {
        setStatus("Create and select a project first.", true);
        return;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProject.projectId,
          actorType: actorTypeInput.value,
          actorId: actorIdInput.value.trim() || undefined,
          content: contentInput.value,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to send message.");
      }

      contentInput.value = "";
      await reloadTimeline(false);
      setStatus("Message stored.");
    };

    createProjectButton.addEventListener("click", async () => {
      try {
        await createProject();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    refreshProjectsButton.addEventListener("click", async () => {
      try {
        const hasProjects = await loadProjects();
        setStatus(
          hasProjects
            ? "Projects loaded."
            : "Create your first project to start the workspace timeline.",
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    projectSelect.addEventListener("change", async () => {
      try {
        updateSelectedProjectState();
        await reloadTimeline();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    sendButton.addEventListener("click", async () => {
      try {
        await sendMessage();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    reloadButton.addEventListener("click", async () => {
      try {
        await reloadTimeline();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    void loadProjects()
      .then((hasProjects) => {
        setStatus(
          hasProjects
            ? "Project timeline loaded."
            : "Create your first project to start the workspace timeline.",
        );
      })
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error), true);
      });
  </script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isWorkspaceMessageActorType(
  value: string,
): value is WorkspaceMessageActorType {
  return (
    WORKSPACE_MESSAGE_ACTOR_TYPES as readonly string[]
  ).includes(value);
}

function parsePostWorkspaceMessageBody(
  body: unknown,
): { ok: true; value: PostWorkspaceMessageBody } | { ok: false; error: string } {
  if (!isRecord(body)) {
    return {
      ok: false,
      error: "Message payload must be a JSON object.",
    };
  }

  const actorType = normalizeOptionalString(body.actorType);

  if (actorType === undefined || !isWorkspaceMessageActorType(actorType)) {
    return {
      ok: false,
      error: `actorType must be one of: ${WORKSPACE_MESSAGE_ACTOR_TYPES.join(", ")}.`,
    };
  }

  const content = normalizeOptionalString(body.content);

  if (content === undefined) {
    return {
      ok: false,
      error: "content must be a non-empty string.",
    };
  }

  const projectId = normalizeOptionalString(body.projectId);
  const actorId = normalizeOptionalString(body.actorId);

  return {
    ok: true,
    value: {
      actorType,
      content,
      projectId,
      actorId,
    },
  };
}

function parseCreateProjectBody(
  body: unknown,
): { ok: true; value: CreateProjectBody } | { ok: false; error: string } {
  if (!isRecord(body)) {
    return {
      ok: false,
      error: "Project payload must be a JSON object.",
    };
  }

  const name = normalizeOptionalString(body.name);

  if (name === undefined) {
    return {
      ok: false,
      error: "name must be a non-empty string.",
    };
  }

  const description = normalizeOptionalString(body.description);

  return {
    ok: true,
    value: {
      name,
      description,
    },
  };
}

function resolveWorkspaceMessagesPath(pathname: string): string | undefined {
  const match = pathname.match(WORKSPACE_MESSAGES_PATH_PATTERN);

  if (match === null) {
    return undefined;
  }

  const encodedWorkspaceId = match[1];

  if (encodedWorkspaceId === undefined) {
    return undefined;
  }

  try {
    const decodedWorkspaceId = decodeURIComponent(encodedWorkspaceId);
    return decodedWorkspaceId.trim().length > 0 ? decodedWorkspaceId : undefined;
  } catch {
    return undefined;
  }
}

function getWebRuntimeLabel(): string {
  return "Orqis Web runtime scaffold";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveRuntimeClientHost(
  host: string,
  address: AddressInfo,
): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (host === "::" || host === "[::]") {
    return address.family === "IPv6" ? "::1" : "127.0.0.1";
  }

  return host;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
  });
  response.end(body);
}

function createHealthPayload(startedAt: number): OrqisWebRuntimeHealthPayload {
  return {
    service: WEB_PACKAGE_NAME,
    status: "ok",
    uptimeMs: Math.max(0, Date.now() - startedAt),
  };
}

function resolvePathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
  let totalBytes = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const chunkBuffer =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);

    totalBytes += chunkBuffer.byteLength;

    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError(
        `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
      );
    }

    chunks.push(chunkBuffer);
  }

  if (chunks.length === 0) {
    throw new RequestBodyJsonParseError("request body must be valid JSON");
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new RequestBodyJsonParseError("request body must be valid JSON");
  }
}

async function handleProjectsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RuntimeRequestContext,
): Promise<void> {
  if (request.method === "GET") {
    try {
      const projects = context.timelineStore.listProjects();

      writeJson(response, 200, {
        projects,
      });
      return;
    } catch (error) {
      if (error instanceof WorkspaceTimelineValidationError) {
        writeJson(response, 400, {
          error: error.message,
        });
        return;
      }

      throw error;
    }
  }

  if (request.method === "POST") {
    let payload;

    try {
      payload = await readJsonRequestBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(response, 413, {
          error: error.message,
        });
        return;
      }

      if (error instanceof RequestBodyJsonParseError) {
        writeJson(response, 400, {
          error: error.message,
        });
        return;
      }

      throw error;
    }

    const parsedBody = parseCreateProjectBody(payload);

    if (!parsedBody.ok) {
      writeJson(response, 400, {
        error: parsedBody.error,
      });
      return;
    }

    try {
      const project = context.timelineStore.createProject({
        name: parsedBody.value.name,
        description: parsedBody.value.description,
      });

      writeJson(response, 201, {
        project,
      });
      return;
    } catch (error) {
      if (error instanceof WorkspaceTimelineValidationError) {
        writeJson(response, 400, {
          error: error.message,
        });
        return;
      }

      if (error instanceof WorkspaceTimelineConflictError) {
        writeJson(response, 409, {
          error: error.message,
        });
        return;
      }

      throw error;
    }
  }

  response.setHeader("allow", "GET, POST");
  writeJson(response, 405, {
    error: "Method Not Allowed",
    method: request.method ?? "UNKNOWN",
  });
}

async function handleWorkspaceMessagesRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RuntimeRequestContext,
  workspaceId: string,
): Promise<void> {
  if (request.method === "GET") {
    try {
      const messages = context.timelineStore.listWorkspaceMessages(workspaceId);

      writeJson(response, 200, {
        workspaceId,
        messages,
      });
      return;
    } catch (error) {
      if (error instanceof WorkspaceTimelineValidationError) {
        writeJson(response, 400, {
          error: error.message,
        });
        return;
      }

      throw error;
    }
  }

  if (request.method === "POST") {
    let payload;

    try {
      payload = await readJsonRequestBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(response, 413, {
          error: error.message,
        });
        return;
      }

      if (error instanceof RequestBodyJsonParseError) {
        writeJson(response, 400, {
          error: error.message,
        });
        return;
      }

      throw error;
    }

    const parsedBody = parsePostWorkspaceMessageBody(payload);

    if (!parsedBody.ok) {
      writeJson(response, 400, {
        error: parsedBody.error,
      });
      return;
    }

    const appendInput: AppendWorkspaceTimelineMessageInput = {
      workspaceId,
      projectId: parsedBody.value.projectId,
      actorType: parsedBody.value.actorType,
      actorId: parsedBody.value.actorId,
      content: parsedBody.value.content,
    };

    try {
      const message = context.timelineStore.appendWorkspaceMessage(appendInput);

      writeJson(response, 201, {
        message,
      });
      return;
    } catch (error) {
      if (error instanceof WorkspaceTimelineValidationError) {
        writeJson(response, 400, {
          error: error.message,
        });
        return;
      }

      if (error instanceof WorkspaceTimelineConflictError) {
        writeJson(response, 409, {
          error: error.message,
        });
        return;
      }

      throw error;
    }
  }

  response.setHeader("allow", "GET, POST");
  writeJson(response, 405, {
    error: "Method Not Allowed",
    method: request.method ?? "UNKNOWN",
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RuntimeRequestContext,
): Promise<void> {
  const pathname = resolvePathname(request);

  if (request.method === "GET" && pathname === "/health") {
    writeJson(response, 200, createHealthPayload(context.startedAt));
    return;
  }

  if (request.method === "GET" && pathname === "/") {
    writeText(response, 200, getWebAppHtml(), "text/html; charset=utf-8");
    return;
  }

  if (pathname === PROJECTS_PATH) {
    await handleProjectsRoute(request, response, context);
    return;
  }

  const workspaceId = resolveWorkspaceMessagesPath(pathname);

  if (workspaceId !== undefined) {
    await handleWorkspaceMessagesRoute(request, response, context, workspaceId);
    return;
  }

  writeJson(response, 404, {
    error: "Not Found",
    path: pathname,
  });
}

async function listen(
  host: string,
  port: number,
  context: RuntimeRequestContext,
): Promise<{ address: AddressInfo; stop: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const handleFailure = (error: unknown): void => {
      if (response.writableEnded) {
        return;
      }

      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }

      writeJson(response, 500, {
        error: "Internal Server Error",
        message: getErrorMessage(error),
      });
    };

    void handleRequest(request, response, context).catch(handleFailure);
  });

  const stop = async (): Promise<void> => {
    if (!server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  };

  try {
    const address = await new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = (): void => {
        server.off("error", onError);
        const value = server.address();

        if (!value || typeof value === "string") {
          reject(new Error("Orqis web runtime did not expose a TCP address."));
          return;
        }

        resolve(value);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

    return { address, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

export { getWebRuntimeLabel };

export async function startOrqisWebRuntime(
  options: StartOrqisWebRuntimeOptions,
): Promise<OrqisWebRuntimeHandle> {
  const startedAt = Date.now();
  const timelineStore = createWorkspaceTimelineStore(options.persistence);

  try {
    const { address, stop: stopServer } = await listen(options.host, options.port, {
      startedAt,
      timelineStore,
    });

    const host = resolveRuntimeClientHost(options.host, address);
    const baseUrl = `http://${formatHostForUrl(host)}:${address.port}`;

    let stopPromise: Promise<void> | undefined;

    const stop = async (): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopPromise = (async () => {
        await stopServer();
        timelineStore.close();
      })();

      return stopPromise;
    };

    return {
      host,
      port: address.port,
      baseUrl,
      healthUrl: `${baseUrl}/health`,
      databaseFilePath: timelineStore.databaseFilePath,
      stop,
    };
  } catch (error) {
    timelineStore.close();
    throw error;
  }
}
