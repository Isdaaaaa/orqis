import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
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
const LOGIN_PATH = "/login";
const SESSION_PATH = "/api/session";
const PROJECTS_PATH = "/api/projects";
const WORKSPACE_MESSAGES_PATH_PATTERN = /^\/api\/workspaces\/([^/]+)\/messages$/;
const WORKSPACE_MESSAGE_ACTOR_TYPES = ["user", "agent", "system"] as const;
const SESSION_COOKIE_NAME = "orqis_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const AUTH_REQUIRED_ERROR_MESSAGE = "Authentication required.";
const NO_STORE_CACHE_CONTROL_VALUE = "no-store";

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
  readonly sessionStore: RuntimeSessionStore;
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

interface CreateSessionBody {
  readonly actorId: string;
}

interface RuntimeSession {
  readonly id: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface RuntimeSessionStore {
  createSession(actorId: string): RuntimeSession;
  getSession(sessionId: string): RuntimeSession | undefined;
  deleteSession(sessionId: string): void;
}

class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly sessions = new Map<string, RuntimeSession>();

  createSession(actorId: string): RuntimeSession {
    const normalizedActorId = actorId.trim();

    if (normalizedActorId.length === 0) {
      throw new Error("actorId must be a non-empty string.");
    }

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(
      now + SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
    ).toISOString();
    const session: RuntimeSession = {
      id: randomUUID(),
      actorId: normalizedActorId,
      createdAt,
      expiresAt,
    };

    this.deleteExpiredSessions(now);
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): RuntimeSession | undefined {
    const normalizedSessionId = sessionId.trim();

    if (normalizedSessionId.length === 0) {
      return undefined;
    }

    const session = this.sessions.get(normalizedSessionId);

    if (session === undefined) {
      return undefined;
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(normalizedSessionId);
      return undefined;
    }

    return session;
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId.trim());
  }

  private deleteExpiredSessions(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
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
  <title>Orqis Workspace Shell</title>
  <style>
    :root {
      color-scheme: dark;
      --font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      --rail-bg: #151820;
      --sidebar-bg: #1f2430;
      --panel-bg: radial-gradient(circle at top right, #3f4b6f 0%, #323a54 24%, #2a2f3c 55%, #232734 100%);
      --panel-overlay: rgba(20, 24, 35, 0.52);
      --panel-border: rgba(255, 255, 255, 0.1);
      --text-main: #f4f7ff;
      --text-muted: #9ea8c7;
      --text-soft: #7f8ab0;
      --accent: #7ea7ff;
      --accent-strong: #5f8ef8;
      --error: #ff8c94;
      --chip-bg: rgba(126, 167, 255, 0.2);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-family);
      color: var(--text-main);
      background: linear-gradient(145deg, #0f1320 0%, #111624 42%, #0d111d 100%);
      overflow: hidden;
    }

    button, input, select, textarea {
      font: inherit;
      color: inherit;
    }

    .app-shell {
      display: grid;
      grid-template-columns: 72px 280px minmax(0, 1fr);
      height: 100vh;
      width: 100%;
    }

    .project-rail {
      position: relative;
      background: linear-gradient(180deg, #111520 0%, #171b25 100%);
      border-right: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.75rem 0.5rem;
      gap: 0.85rem;
      overflow: visible;
    }

    .rail-top,
    .rail-bottom {
      display: grid;
      gap: 0.55rem;
      justify-items: center;
    }

    .rail-projects {
      flex: 1;
      width: 100%;
      display: grid;
      grid-auto-rows: min-content;
      justify-items: center;
      gap: 0.5rem;
      overflow-y: auto;
      padding: 0.35rem 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
    }

    .rail-icon {
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.88rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      cursor: pointer;
      transition: transform 120ms ease, border-radius 120ms ease, background 120ms ease, color 120ms ease;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-main);
    }

    .rail-icon:hover {
      transform: translateY(-1px);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.18);
    }

    .rail-icon[aria-current="true"] {
      border-radius: 10px;
      background: linear-gradient(135deg, #89b2ff 0%, #6091ff 100%);
      color: #101729;
    }

    .rail-icon--brand {
      background: linear-gradient(145deg, #90bbff 0%, #6588eb 100%);
      color: #111827;
    }

    .rail-icon--ghost {
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(20, 24, 35, 0.55);
    }

    .rail-empty {
      font-size: 0.72rem;
      color: var(--text-soft);
      text-align: center;
      line-height: 1.35;
      padding: 0 0.35rem;
    }

    .quick-create-popover {
      position: absolute;
      left: 76px;
      bottom: 14px;
      width: 260px;
      background: rgba(15, 19, 31, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 14px;
      box-shadow: 0 18px 34px rgba(2, 5, 13, 0.6);
      padding: 0.85rem;
      display: grid;
      gap: 0.55rem;
      z-index: 20;
    }

    .quick-create-popover h2 {
      margin: 0;
      font-size: 0.92rem;
    }

    label {
      display: grid;
      gap: 0.3rem;
      font-size: 0.78rem;
      color: var(--text-muted);
      letter-spacing: 0.02em;
    }

    input,
    select,
    textarea {
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(12, 15, 26, 0.8);
      color: var(--text-main);
      padding: 0.52rem 0.62rem;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    input:focus,
    select:focus,
    textarea:focus,
    button:focus-visible {
      outline: none;
      border-color: rgba(126, 167, 255, 0.8);
      box-shadow: 0 0 0 2px rgba(126, 167, 255, 0.24);
    }

    button {
      border: 0;
      border-radius: 10px;
      cursor: pointer;
      background: linear-gradient(135deg, #88aeff 0%, #6a93ff 100%);
      color: #121c33;
      padding: 0.55rem 0.75rem;
      font-weight: 600;
      transition: filter 100ms ease;
    }

    button:hover {
      filter: brightness(1.06);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      filter: none;
    }

    button.secondary {
      background: rgba(255, 255, 255, 0.12);
      color: var(--text-main);
      border: 1px solid rgba(255, 255, 255, 0.16);
    }

    .quick-create-actions {
      display: flex;
      gap: 0.45rem;
      margin-top: 0.2rem;
    }

    .workspace-nav {
      display: flex;
      flex-direction: column;
      background: linear-gradient(180deg, #1d2330 0%, #1d2230 55%, #1a1f2a 100%);
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      padding: 1rem 0.9rem 0.9rem;
      gap: 1rem;
      overflow: hidden;
    }

    .workspace-nav-header {
      display: grid;
      gap: 0.25rem;
      padding: 0.15rem 0.25rem 0;
    }

    .workspace-nav-eyebrow {
      margin: 0;
      font-size: 0.68rem;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--text-soft);
    }

    .workspace-nav-header h1 {
      margin: 0;
      font-size: 1.03rem;
      line-height: 1.25;
      word-break: break-word;
    }

    .workspace-nav-header p {
      margin: 0;
      font-size: 0.78rem;
      color: var(--text-muted);
      line-height: 1.35;
    }

    .workspace-selector label {
      font-size: 0.73rem;
    }

    .channel-groups {
      display: grid;
      gap: 0.3rem;
      align-content: start;
      overflow-y: auto;
      padding-right: 0.2rem;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
    }

    .channel-group-label {
      margin: 0.55rem 0 0.2rem;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-soft);
      padding-left: 0.36rem;
    }

    .channel-item {
      width: 100%;
      text-align: left;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      border-radius: 9px;
      padding: 0.45rem 0.58rem;
      font-size: 0.88rem;
      font-weight: 500;
    }

    .channel-item:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-main);
    }

    .channel-item--thread {
      font-size: 0.82rem;
      padding-left: 0.76rem;
    }

    .channel-item--active {
      background: linear-gradient(135deg, rgba(126, 167, 255, 0.3) 0%, rgba(126, 167, 255, 0.18) 100%);
      border-color: rgba(126, 167, 255, 0.52);
      color: #eaf1ff;
    }

    .workspace-meta {
      margin-top: auto;
      padding: 0.65rem 0.75rem;
      border-radius: 12px;
      background: rgba(9, 13, 24, 0.52);
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: grid;
      gap: 0.22rem;
    }

    .workspace-meta span {
      font-size: 0.68rem;
      color: var(--text-soft);
      text-transform: uppercase;
      letter-spacing: 0.09em;
    }

    .workspace-meta strong {
      font-size: 0.8rem;
      color: var(--text-main);
      font-weight: 600;
      word-break: break-all;
    }

    .panel {
      min-width: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--panel-bg);
      position: relative;
    }

    .panel::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(11, 16, 28, 0.1) 0%, rgba(10, 13, 22, 0.4) 100%);
      pointer-events: none;
    }

    .panel > * {
      position: relative;
      z-index: 1;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.9rem;
      padding: 1rem 1.15rem 0.85rem;
      border-bottom: 1px solid var(--panel-border);
      backdrop-filter: blur(6px);
      background: var(--panel-overlay);
    }

    .panel-actions {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .session-actor {
      font-size: 0.74rem;
      color: var(--text-muted);
    }

    .panel-context {
      margin: 0;
      font-size: 0.71rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-soft);
    }

    .panel-header h2 {
      margin: 0.2rem 0 0.3rem;
      font-size: 1.25rem;
      line-height: 1.2;
    }

    .panel-header p {
      margin: 0;
      font-size: 0.86rem;
      color: var(--text-muted);
      line-height: 1.4;
      max-width: 680px;
    }

    .status {
      min-height: 2.15rem;
      margin: 0.8rem 1.15rem 0;
      padding: 0.6rem 0.75rem;
      border-radius: 10px;
      background: rgba(9, 13, 24, 0.46);
      border: 1px solid rgba(255, 255, 255, 0.09);
      color: var(--text-muted);
      font-size: 0.82rem;
      line-height: 1.35;
    }

    .status[data-variant="error"] {
      border-color: rgba(255, 140, 148, 0.48);
      color: #ffe8ea;
      background: rgba(52, 18, 23, 0.6);
    }

    .timeline-region {
      flex: 1;
      overflow-y: auto;
      padding: 0.85rem 1.15rem 1rem;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }

    #messages {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.78rem;
      align-content: start;
    }

    #messages li {
      border-radius: 13px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(11, 15, 26, 0.72);
      padding: 0.72rem 0.8rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    }

    #messages li.empty {
      color: var(--text-muted);
      font-size: 0.86rem;
      text-align: center;
      padding: 1rem;
    }

    .meta {
      font-size: 0.74rem;
      color: var(--text-soft);
      margin-bottom: 0.42rem;
      line-height: 1.3;
      word-break: break-all;
    }

    .content {
      white-space: pre-wrap;
      word-break: break-word;
      color: #f8faff;
      font-size: 0.93rem;
      line-height: 1.4;
    }

    .detail-region {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 1rem 1.15rem;
    }

    .detail-card {
      max-width: 760px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(13, 18, 30, 0.76);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      padding: 1rem;
    }

    .detail-card h3 {
      margin: 0 0 0.45rem;
      font-size: 1.02rem;
    }

    .detail-card p {
      margin: 0;
      color: var(--text-muted);
      line-height: 1.45;
      font-size: 0.88rem;
    }

    .agent-list {
      list-style: none;
      padding: 0;
      margin: 0.85rem 0 0;
      display: grid;
      gap: 0.55rem;
    }

    .agent-list li {
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(7, 11, 20, 0.5);
      padding: 0.55rem 0.6rem;
      display: grid;
      gap: 0.15rem;
    }

    .agent-list strong {
      font-size: 0.86rem;
    }

    .agent-list span {
      color: var(--text-muted);
      font-size: 0.78rem;
    }

    .composer-shell {
      border-top: 1px solid var(--panel-border);
      background: rgba(14, 19, 31, 0.93);
      backdrop-filter: blur(8px);
      padding: 0.75rem 1.15rem 0.9rem;
      display: grid;
      gap: 0.5rem;
      position: sticky;
      bottom: 0;
      z-index: 3;
    }

    .composer-topline {
      display: grid;
      grid-template-columns: minmax(0, 180px) minmax(0, 1fr);
      gap: 0.6rem;
    }

    .composer-message-label {
      font-size: 0.76rem;
    }

    textarea {
      width: 100%;
      min-height: 84px;
      resize: vertical;
    }

    .composer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.45rem;
    }

    @media (max-width: 1080px) {
      .app-shell {
        grid-template-columns: 68px 250px minmax(0, 1fr);
      }

      .panel-header {
        padding-inline: 0.95rem;
      }

      .timeline-region,
      .detail-region,
      .composer-shell {
        padding-left: 0.95rem;
        padding-right: 0.95rem;
      }
    }

    @media (max-width: 860px) {
      body {
        overflow: auto;
      }

      .app-shell {
        display: block;
        height: auto;
      }

      .project-rail {
        width: 100%;
        height: auto;
        padding: 0.65rem;
        border-right: 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
      }

      .rail-top,
      .rail-bottom {
        display: flex;
        gap: 0.45rem;
      }

      .rail-projects {
        display: flex;
        flex-direction: row;
        overflow-x: auto;
        overflow-y: hidden;
        gap: 0.45rem;
        padding: 0 0.45rem;
      }

      .quick-create-popover {
        left: 0.7rem;
        right: 0.7rem;
        width: auto;
        top: calc(100% + 0.55rem);
        bottom: auto;
      }

      .workspace-nav {
        border-right: 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        max-height: none;
      }

      .panel {
        height: auto;
        min-height: calc(100vh - 240px);
      }

      .composer-topline {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="project-rail" aria-label="Project rail">
      <div class="rail-top">
        <button class="rail-icon rail-icon--brand" id="orqis-home" type="button" title="Orqis control center" aria-label="Orqis control center">
          OQ
        </button>
      </div>
      <div id="project-rail-list" class="rail-projects" aria-label="Projects"></div>
      <div class="rail-bottom">
        <button class="rail-icon rail-icon--ghost" id="open-project-create" type="button" title="Quick create project" aria-label="Quick create project">
          +
        </button>
        <button class="rail-icon rail-icon--ghost" id="refresh-projects" type="button" title="Refresh projects" aria-label="Refresh projects">
          ↻
        </button>
      </div>
      <div id="quick-create-popover" class="quick-create-popover" hidden>
        <h2>Quick project</h2>
        <label>Project name
          <input id="new-project-name" placeholder="Website redesign" />
        </label>
        <label>Description (optional)
          <input id="new-project-description" placeholder="Internal scope notes" />
        </label>
        <div class="quick-create-actions">
          <button id="create-project" type="button">Create</button>
          <button id="close-project-create" class="secondary" type="button">Cancel</button>
        </div>
      </div>
    </aside>

    <aside class="workspace-nav" aria-label="Workspace navigation">
      <header class="workspace-nav-header">
        <p class="workspace-nav-eyebrow">Project Workspace</p>
        <h1 id="selected-project-name">No project selected</h1>
        <p id="selected-project-slug">Create a project from the left rail to start.</p>
      </header>

      <div class="workspace-selector">
        <label for="project-select">Switch project
          <select id="project-select"></select>
        </label>
      </div>

      <nav class="channel-groups" aria-label="Workspace channels">
        <button class="channel-item channel-item--active" type="button" data-view-id="main-chat" aria-current="true">Main Chat</button>
        <button class="channel-item" type="button" data-view-id="files" aria-current="false">Files</button>
        <p class="channel-group-label">Agent Threads</p>
        <button class="channel-item channel-item--thread" type="button" data-view-id="thread-frontend" aria-current="false">PM -> Frontend Agent</button>
        <button class="channel-item channel-item--thread" type="button" data-view-id="thread-backend" aria-current="false">PM -> Backend Agent</button>
        <button class="channel-item channel-item--thread" type="button" data-view-id="thread-reviewer" aria-current="false">PM -> Reviewer</button>
        <button class="channel-item" type="button" data-view-id="assigned-agents" aria-current="false">Assigned Agents</button>
      </nav>

      <div class="workspace-meta">
        <span>Workspace</span>
        <strong id="selected-workspace">none</strong>
      </div>
    </aside>

    <main class="panel">
      <header class="panel-header">
        <div>
          <p id="panel-context" class="panel-context">Channel</p>
          <h2 id="panel-title">Main Chat</h2>
          <p id="panel-subtitle">Orqis control center workspace group chat timeline with persistent message history.</p>
        </div>
        <div class="panel-actions">
          <span id="session-actor" class="session-actor"></span>
          <button id="reload-messages" class="secondary" type="button">Reload timeline</button>
          <button id="logout" class="secondary" type="button">Log out</button>
        </div>
      </header>

      <section id="status" class="status" role="status"></section>

      <section id="timeline-region" class="timeline-region">
        <ul id="messages"></ul>
      </section>

      <section id="detail-region" class="detail-region" hidden></section>

      <footer id="composer-shell" class="composer-shell">
        <div class="composer-topline">
          <label>Actor type
            <select id="actor-type">
              <option value="user">user</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
          </label>
          <label>Actor ID (optional)
            <input id="actor-id" placeholder="pm-agent" />
          </label>
        </div>
        <label class="composer-message-label" for="message-content">Message</label>
        <textarea id="message-content" placeholder="Post a workspace update..."></textarea>
        <div class="composer-actions">
          <button id="send-message" type="button">Send message</button>
        </div>
      </footer>
    </main>
  </div>
  <script type="module">
    const projectNameInput = document.getElementById("new-project-name");
    const projectDescriptionInput = document.getElementById("new-project-description");
    const createProjectButton = document.getElementById("create-project");
    const closeProjectCreateButton = document.getElementById("close-project-create");
    const openProjectCreateButton = document.getElementById("open-project-create");
    const refreshProjectsButton = document.getElementById("refresh-projects");
    const projectRailList = document.getElementById("project-rail-list");
    const orqisHomeButton = document.getElementById("orqis-home");
    const quickCreatePopover = document.getElementById("quick-create-popover");
    const projectSelect = document.getElementById("project-select");
    const selectedProjectName = document.getElementById("selected-project-name");
    const selectedProjectSlug = document.getElementById("selected-project-slug");
    const selectedWorkspace = document.getElementById("selected-workspace");
    const panelContext = document.getElementById("panel-context");
    const panelTitle = document.getElementById("panel-title");
    const panelSubtitle = document.getElementById("panel-subtitle");
    const sessionActor = document.getElementById("session-actor");
    const timelineRegion = document.getElementById("timeline-region");
    const detailRegion = document.getElementById("detail-region");
    const composerShell = document.getElementById("composer-shell");
    const actorTypeInput = document.getElementById("actor-type");
    const actorIdInput = document.getElementById("actor-id");
    const contentInput = document.getElementById("message-content");
    const sendButton = document.getElementById("send-message");
    const reloadButton = document.getElementById("reload-messages");
    const logoutButton = document.getElementById("logout");
    const status = document.getElementById("status");
    const messagesList = document.getElementById("messages");
    const navigationButtons = Array.from(
      document.querySelectorAll("[data-view-id]"),
    );

    const projectsUrl = "/api/projects";
    const sessionUrl = "/api/session";

    const viewMeta = {
      "main-chat": {
        context: "Channel",
        title: "Main Chat",
        subtitle: "Project-wide chat timeline for planning, execution, and approvals.",
        timeline: true,
      },
      files: {
        context: "Section",
        title: "Files",
        subtitle: "Project files panel placeholder while timeline and task flows are stabilized.",
        timeline: false,
      },
      "thread-frontend": {
        context: "Agent Thread",
        title: "PM -> Frontend Agent",
        subtitle: "UI and client-side implementation coordination thread.",
        timeline: true,
      },
      "thread-backend": {
        context: "Agent Thread",
        title: "PM -> Backend Agent",
        subtitle: "API and orchestration-focused execution thread.",
        timeline: true,
      },
      "thread-reviewer": {
        context: "Agent Thread",
        title: "PM -> Reviewer",
        subtitle: "Validation and quality review thread.",
        timeline: true,
      },
      "assigned-agents": {
        context: "Section",
        title: "Assigned Agents",
        subtitle: "Live ownership roster for the current workspace.",
        timeline: false,
      },
    };

    let projects = [];
    let selectedProjectId = "";
    let activeViewId = "main-chat";

    const setStatus = (message, isError = false) => {
      status.textContent = message;
      status.dataset.variant = isError ? "error" : "info";
    };

    const renderMessages = (messages) => {
      messagesList.innerHTML = "";

      if (!Array.isArray(messages) || messages.length === 0) {
        const item = document.createElement("li");
        item.className = "empty";
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

    const renderDetailView = () => {
      if (activeViewId === "files") {
        detailRegion.innerHTML =
          '<div class="detail-card"><h3>Files</h3><p>File navigation is staged for a follow-up slice. Continue collaboration in Main Chat and Agent Threads while this panel remains read-only.</p></div>';
        return;
      }

      if (activeViewId === "assigned-agents") {
        detailRegion.innerHTML =
          '<div class="detail-card"><h3>Assigned Agents</h3><p>Role routing for this workspace.</p><ul class="agent-list"><li><strong>Project Manager</strong><span>Coordinates plans, assignments, and approvals.</span></li><li><strong>Frontend Agent</strong><span>Owns UI shell and interaction delivery.</span></li><li><strong>Backend Agent</strong><span>Owns API contracts, state transitions, and persistence behavior.</span></li><li><strong>Reviewer</strong><span>Validates correctness, tests, and release readiness.</span></li></ul></div>';
        return;
      }

      detailRegion.innerHTML =
        '<div class="detail-card"><h3>Section</h3><p>Select Main Chat or one of the Agent Threads to continue timeline collaboration.</p></div>';
    };

    const isTimelineView = (viewId) => {
      const view = viewMeta[viewId];
      return view !== undefined && view.timeline === true;
    };

    const syncNavigationState = () => {
      for (const button of navigationButtons) {
        const viewId = button.dataset.viewId;
        const isActive = viewId === activeViewId;
        button.classList.toggle("channel-item--active", isActive);
        button.setAttribute("aria-current", isActive ? "true" : "false");
      }
    };

    const getSelectedProject = () => {
      for (const project of projects) {
        if (project.projectId === selectedProjectId) {
          return project;
        }
      }

      return null;
    };

    const getProjectBadge = (projectName) => {
      const parts = String(projectName)
        .trim()
        .split(/\\s+/)
        .filter((part) => part.length > 0);

      if (parts.length === 0) {
        return "PR";
      }

      if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
      }

      return (parts[0][0] + parts[1][0]).toUpperCase();
    };

    const renderProjectRail = () => {
      projectRailList.innerHTML = "";

      if (projects.length === 0) {
        const emptyLabel = document.createElement("p");
        emptyLabel.className = "rail-empty";
        emptyLabel.textContent = "No projects";
        projectRailList.appendChild(emptyLabel);
        return;
      }

      for (const project of projects) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rail-icon";
        button.textContent = getProjectBadge(project.projectName);
        button.title = project.projectName;
        button.setAttribute("aria-label", "Select " + project.projectName);
        button.setAttribute(
          "aria-current",
          project.projectId === selectedProjectId ? "true" : "false",
        );
        button.addEventListener("click", async () => {
          if (selectedProjectId === project.projectId) {
            return;
          }

          selectedProjectId = project.projectId;
          projectSelect.value = project.projectId;
          renderProjectRail();
          updateSelectedProjectState();

          try {
            if (isTimelineView(activeViewId)) {
              await reloadTimeline();
            }
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), true);
          }
        });
        projectRailList.appendChild(button);
      }
    };

    const applyView = () => {
      const view = viewMeta[activeViewId] ?? viewMeta["main-chat"];

      panelContext.textContent = view.context;
      panelTitle.textContent = view.title;
      panelSubtitle.textContent = view.subtitle;
      syncNavigationState();

      const showTimeline = view.timeline === true;
      timelineRegion.hidden = !showTimeline;
      detailRegion.hidden = showTimeline;
      composerShell.hidden = !showTimeline;

      if (!showTimeline) {
        renderDetailView();
      }

      updateSelectedProjectState();
    };

    const updateSelectedProjectState = () => {
      const selectedProject = getSelectedProject();
      const timelineEnabled = selectedProject !== null && isTimelineView(activeViewId);

      if (selectedProject === null) {
        selectedProjectName.textContent = "No project selected";
        selectedProjectSlug.textContent = "Create a project from the left rail to start.";
        selectedWorkspace.textContent = "none";
        sendButton.disabled = true;
        reloadButton.disabled = true;
        actorTypeInput.disabled = true;
        actorIdInput.disabled = true;
        contentInput.disabled = true;
        return;
      }

      selectedProjectName.textContent = selectedProject.projectName;
      selectedProjectSlug.textContent = selectedProject.projectSlug;
      selectedWorkspace.textContent = selectedProject.workspaceId;
      sendButton.disabled = !timelineEnabled;
      reloadButton.disabled = !timelineEnabled;
      actorTypeInput.disabled = !timelineEnabled;
      actorIdInput.disabled = !timelineEnabled;
      contentInput.disabled = !timelineEnabled;
    };

    const timelineUrl = () => {
      const selectedProject = getSelectedProject();

      if (selectedProject === null) {
        return null;
      }

      return "/api/workspaces/" + encodeURIComponent(selectedProject.workspaceId) + "/messages";
    };

    const reloadTimeline = async (announce = true) => {
      if (!isTimelineView(activeViewId)) {
        return;
      }

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
        const view = viewMeta[activeViewId] ?? viewMeta["main-chat"];
        setStatus(view.title + " loaded for " + selectedProject.projectName + ".");
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
        selectedProjectId = "";
        renderProjectRail();
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
      selectedProjectId = hasPreferredProject
        ? preferredProjectId
        : projects[0].projectId;
      projectSelect.value = selectedProjectId;
      renderProjectRail();
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

      if (isTimelineView(activeViewId)) {
        await reloadTimeline(false);
      }

      return true;
    };

    const loadSession = async () => {
      const response = await fetch(sessionUrl);
      const payload = await response.json();

      if (!response.ok || payload.authenticated !== true) {
        window.location.assign("${LOGIN_PATH}");
        return false;
      }

      const actorId = typeof payload.session?.actorId === "string"
        ? payload.session.actorId
        : "";
      sessionActor.textContent = actorId.length > 0 ? "Signed in as " + actorId : "";
      return true;
    };

    const toggleQuickCreatePopover = (open) => {
      quickCreatePopover.hidden = !open;

      if (open) {
        projectNameInput.focus();
      }
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
      toggleQuickCreatePopover(false);
      await loadProjects(payload.project?.projectId);
      setStatus("Project created and selected.");
    };

    const sendMessage = async () => {
      if (!isTimelineView(activeViewId)) {
        setStatus("Switch to Main Chat or an Agent Thread to send timeline messages.", true);
        return;
      }

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

    const setActiveView = async (viewId) => {
      if (viewMeta[viewId] === undefined || activeViewId === viewId) {
        return;
      }

      activeViewId = viewId;
      applyView();

      if (isTimelineView(activeViewId)) {
        await reloadTimeline();
        return;
      }

      const selectedProject = getSelectedProject();
      if (selectedProject === null) {
        setStatus("Create and select a project to use workspace sections.");
      } else {
        setStatus((viewMeta[activeViewId] ?? viewMeta["main-chat"]).title + " selected.");
      }
    };

    openProjectCreateButton.addEventListener("click", () => {
      toggleQuickCreatePopover(quickCreatePopover.hidden);
    });

    closeProjectCreateButton.addEventListener("click", () => {
      toggleQuickCreatePopover(false);
    });

    orqisHomeButton.addEventListener("click", async () => {
      try {
        await setActiveView("main-chat");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

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
        selectedProjectId = projectSelect.value;
        renderProjectRail();
        updateSelectedProjectState();

        if (isTimelineView(activeViewId)) {
          await reloadTimeline();
          return;
        }

        setStatus("Project selected.");
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

    logoutButton.addEventListener("click", async () => {
      logoutButton.disabled = true;

      try {
        await fetch(sessionUrl, {
          method: "DELETE",
        });
        window.location.assign("${LOGIN_PATH}");
      } catch (error) {
        logoutButton.disabled = false;
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    for (const button of navigationButtons) {
      button.addEventListener("click", async () => {
        const viewId = button.dataset.viewId;

        if (viewId === undefined) {
          return;
        }

        try {
          await setActiveView(viewId);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), true);
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        toggleQuickCreatePopover(false);
      }
    });

    applyView();

    void loadSession()
      .then((isAuthenticated) => {
        if (!isAuthenticated) {
          return false;
        }

        return loadProjects();
      })
      .then((hasProjects) => {
        if (hasProjects === false) {
          return;
        }

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

function getWebLoginHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orqis Sign In</title>
  <style>
    :root {
      color-scheme: dark;
      --font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      --bg: radial-gradient(circle at 15% 20%, #32486b 0%, #1f2c44 36%, #121a2b 72%, #0b111d 100%);
      --card-bg: rgba(14, 20, 33, 0.84);
      --border: rgba(255, 255, 255, 0.16);
      --text-main: #f0f5ff;
      --text-muted: #a7b4d6;
      --error: #ffb5be;
      --input-bg: rgba(10, 14, 24, 0.8);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-family);
      color: var(--text-main);
      background: var(--bg);
      display: grid;
      place-items: center;
      padding: 1rem;
    }

    .login-card {
      width: min(100%, 420px);
      border-radius: 16px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      box-shadow: 0 24px 48px rgba(2, 6, 13, 0.42);
      padding: 1.1rem;
      display: grid;
      gap: 0.9rem;
    }

    h1 {
      margin: 0;
      font-size: 1.36rem;
    }

    p {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.42;
    }

    label {
      display: grid;
      gap: 0.42rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    input {
      width: 100%;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: var(--input-bg);
      color: var(--text-main);
      padding: 0.6rem 0.68rem;
      font: inherit;
    }

    input:focus,
    button:focus-visible {
      outline: none;
      border-color: rgba(139, 174, 255, 0.9);
      box-shadow: 0 0 0 2px rgba(126, 167, 255, 0.22);
    }

    button {
      border: 0;
      border-radius: 10px;
      padding: 0.62rem 0.74rem;
      font: inherit;
      font-weight: 600;
      color: #0e1a2e;
      background: linear-gradient(135deg, #9ec2ff 0%, #7eabff 100%);
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #status {
      min-height: 1.35rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    #status[data-variant="error"] {
      color: var(--error);
    }
  </style>
</head>
<body>
  <main class="login-card">
    <header>
      <h1>Sign in to Orqis</h1>
      <p>Use a local actor ID to create a browser session for this runtime.</p>
    </header>
    <form id="login-form">
      <label for="actor-id">Actor ID
        <input id="actor-id" name="actorId" autocomplete="username" placeholder="owner" required />
      </label>
      <button id="login-button" type="submit">Sign in</button>
    </form>
    <div id="status" role="status"></div>
  </main>
  <script type="module">
    const loginForm = document.getElementById("login-form");
    const actorIdInput = document.getElementById("actor-id");
    const loginButton = document.getElementById("login-button");
    const status = document.getElementById("status");
    const sessionUrl = "${SESSION_PATH}";

    const setStatus = (message, isError = false) => {
      status.textContent = message;
      status.dataset.variant = isError ? "error" : "info";
    };

    const ensureSignedOut = async () => {
      const response = await fetch(sessionUrl);
      const payload = await response.json();

      if (response.ok && payload.authenticated === true) {
        window.location.assign("/");
      }
    };

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const actorId = actorIdInput.value.trim();

      if (actorId.length === 0) {
        setStatus("Actor ID is required.", true);
        return;
      }

      loginButton.disabled = true;
      setStatus("Signing in...");

      try {
        const response = await fetch(sessionUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            actorId,
          }),
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to create session.");
        }

        window.location.assign("/");
      } catch (error) {
        loginButton.disabled = false;
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    });

    void ensureSignedOut().catch((error) => {
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

function parseCreateSessionBody(
  body: unknown,
): { ok: true; value: CreateSessionBody } | { ok: false; error: string } {
  if (!isRecord(body)) {
    return {
      ok: false,
      error: "Session payload must be a JSON object.",
    };
  }

  const actorId = normalizeOptionalString(body.actorId);

  if (actorId === undefined) {
    return {
      ok: false,
      error: "actorId must be a non-empty string.",
    };
  }

  return {
    ok: true,
    value: {
      actorId,
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

function resolveRequestCookie(
  request: IncomingMessage,
  cookieName: string,
): string | undefined {
  const cookieHeader = request.headers.cookie;

  if (cookieHeader === undefined) {
    return undefined;
  }

  const mergedHeader = Array.isArray(cookieHeader)
    ? cookieHeader.join(";")
    : cookieHeader;

  for (const cookiePart of mergedHeader.split(";")) {
    const [rawName, ...rawValueParts] = cookiePart.split("=");

    if (rawName === undefined || rawValueParts.length === 0) {
      continue;
    }

    if (rawName.trim() !== cookieName) {
      continue;
    }

    const rawValue = rawValueParts.join("=").trim();

    if (rawValue.length === 0) {
      return undefined;
    }

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function resolveUrlHeaderProtocol(
  headerValue: string | readonly string[] | undefined,
): string | undefined {
  const candidateValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (candidateValue === undefined) {
    return undefined;
  }

  try {
    return new URL(candidateValue).protocol.toLowerCase();
  } catch {
    return undefined;
  }
}

function resolveForwardedProto(request: IncomingMessage): string | undefined {
  const forwardedHeader = request.headers.forwarded;
  const forwardedValues = Array.isArray(forwardedHeader)
    ? forwardedHeader
    : [forwardedHeader];

  for (const forwardedValue of forwardedValues) {
    if (typeof forwardedValue !== "string") {
      continue;
    }

    for (const entry of forwardedValue.split(",")) {
      for (const directive of entry.split(";")) {
        const separatorIndex = directive.indexOf("=");

        if (separatorIndex < 0) {
          continue;
        }

        const name = directive.slice(0, separatorIndex).trim().toLowerCase();

        if (name !== "proto") {
          continue;
        }

        const rawValue = directive
          .slice(separatorIndex + 1)
          .trim()
          .replace(/^"|"$/g, "")
          .toLowerCase();

        if (rawValue.length > 0) {
          return rawValue;
        }
      }
    }
  }

  const xForwardedProtoHeader = request.headers["x-forwarded-proto"];
  const xForwardedProtoValues = Array.isArray(xForwardedProtoHeader)
    ? xForwardedProtoHeader
    : [xForwardedProtoHeader];

  for (const value of xForwardedProtoValues) {
    if (typeof value !== "string") {
      continue;
    }

    for (const candidate of value.split(",")) {
      const normalizedCandidate = candidate.trim().toLowerCase();

      if (normalizedCandidate.length > 0) {
        return normalizedCandidate;
      }
    }
  }

  return undefined;
}

function requestUsesHttps(request: IncomingMessage): boolean {
  const originProtocol = resolveUrlHeaderProtocol(request.headers.origin);

  if (originProtocol !== undefined) {
    return originProtocol === "https:";
  }

  const refererProtocol = resolveUrlHeaderProtocol(request.headers.referer);

  if (refererProtocol !== undefined) {
    return refererProtocol === "https:";
  }

  const forwardedProto = resolveForwardedProto(request);

  if (forwardedProto !== undefined) {
    return forwardedProto === "https";
  }

  const socket = request.socket as IncomingMessage["socket"] & {
    readonly encrypted?: boolean;
  };

  return socket.encrypted === true;
}

function createSessionCookieHeader(sessionId: string, secure: boolean): string {
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  return cookieParts.join("; ");
}

function createSessionCookieClearHeader(secure: boolean): string {
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  return cookieParts.join("; ");
}

function isAuthSensitivePathname(pathname: string): boolean {
  return pathname === "/" || pathname === LOGIN_PATH || pathname.startsWith("/api/");
}

function resolveRuntimeSession(
  request: IncomingMessage,
  context: RuntimeRequestContext,
): RuntimeSession | undefined {
  const sessionId = resolveRequestCookie(request, SESSION_COOKIE_NAME);

  if (sessionId === undefined) {
    return undefined;
  }

  return context.sessionStore.getSession(sessionId);
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
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    ...headers,
  });
  response.end(body);
}

function writeRedirect(
  response: ServerResponse,
  location: string,
  statusCode = 302,
): void {
  response.writeHead(statusCode, {
    location,
  });
  response.end();
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

function writeAuthenticationRequired(response: ServerResponse): void {
  writeJson(response, 401, {
    error: AUTH_REQUIRED_ERROR_MESSAGE,
  });
}

async function handleSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RuntimeRequestContext,
): Promise<void> {
  const sessionId = resolveRequestCookie(request, SESSION_COOKIE_NAME);
  const session = resolveRuntimeSession(request, context);
  const useSecureCookie = requestUsesHttps(request);

  if (request.method === "GET") {
    writeJson(response, 200, {
      authenticated: session !== undefined,
      session:
        session === undefined
          ? null
          : {
              actorId: session.actorId,
              createdAt: session.createdAt,
              expiresAt: session.expiresAt,
            },
    });
    return;
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

    const parsedBody = parseCreateSessionBody(payload);

    if (!parsedBody.ok) {
      writeJson(response, 400, {
        error: parsedBody.error,
      });
      return;
    }

    const createdSession = context.sessionStore.createSession(parsedBody.value.actorId);

    writeJson(
      response,
      201,
      {
        authenticated: true,
        session: {
          actorId: createdSession.actorId,
          createdAt: createdSession.createdAt,
          expiresAt: createdSession.expiresAt,
        },
      },
      {
        "set-cookie": createSessionCookieHeader(
          createdSession.id,
          useSecureCookie,
        ),
      },
    );
    return;
  }

  if (request.method === "DELETE") {
    if (sessionId !== undefined) {
      context.sessionStore.deleteSession(sessionId);
    }

    writeJson(
      response,
      200,
      {
        authenticated: false,
      },
      {
        "set-cookie": createSessionCookieClearHeader(useSecureCookie),
      },
    );
    return;
  }

  response.setHeader("allow", "GET, POST, DELETE");
  writeJson(response, 405, {
    error: "Method Not Allowed",
    method: request.method ?? "UNKNOWN",
  });
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
  const session = resolveRuntimeSession(request, context);

  if (isAuthSensitivePathname(pathname)) {
    response.setHeader("cache-control", NO_STORE_CACHE_CONTROL_VALUE);
  }

  if (request.method === "GET" && pathname === "/health") {
    writeJson(response, 200, createHealthPayload(context.startedAt));
    return;
  }

  if (pathname === SESSION_PATH) {
    await handleSessionRoute(request, response, context);
    return;
  }

  if (request.method === "GET" && pathname === LOGIN_PATH) {
    if (session !== undefined) {
      writeRedirect(response, "/");
      return;
    }

    writeText(response, 200, getWebLoginHtml(), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && pathname === "/") {
    if (session === undefined) {
      writeRedirect(response, LOGIN_PATH);
      return;
    }

    writeText(response, 200, getWebAppHtml(), "text/html; charset=utf-8");
    return;
  }

  if (pathname.startsWith("/api/") && session === undefined) {
    writeAuthenticationRequired(response);
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
  const sessionStore = new InMemoryRuntimeSessionStore();

  try {
    const { address, stop: stopServer } = await listen(options.host, options.port, {
      startedAt,
      timelineStore,
      sessionStore,
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
