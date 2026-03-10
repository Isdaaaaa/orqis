import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SQLITE_MODULE_ID = "node:sqlite";
type SqliteModule = typeof import("node:sqlite");
type SqliteDatabaseSync = import("node:sqlite").DatabaseSync;
const { DatabaseSync } = require(SQLITE_MODULE_ID) as SqliteModule;

const ORQIS_CONFIG_DIR_ENV_VAR = "ORQIS_CONFIG_DIR";
export const ORQIS_WEB_RUNTIME_DB_PATH_ENV_VAR = "ORQIS_WEB_RUNTIME_DB_PATH";
const DEFAULT_ORQIS_CONFIG_DIR = ".orqis";
const DEFAULT_ORQIS_DB_FILE_NAME = "orqis.db";
const PROJECTS_TABLE_NAME = "projects";
const DB_INITIAL_MIGRATION_FILE = "0001_project_workspace_schema.sql";

const WORKSPACE_MESSAGE_ACTOR_TYPES = ["user", "agent", "system"] as const;

export type WorkspaceMessageActorType =
  (typeof WORKSPACE_MESSAGE_ACTOR_TYPES)[number];

export interface WorkspaceTimelineMessage {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly actorType: WorkspaceMessageActorType;
  readonly actorId: string | null;
  readonly content: string;
  readonly createdAt: string;
}

export interface AppendWorkspaceTimelineMessageInput {
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly actorType: WorkspaceMessageActorType;
  readonly actorId?: string;
  readonly content: string;
}

export interface WorkspaceTimelineStoreOptions {
  readonly databaseFilePath?: string;
  readonly configDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WorkspaceTimelineStore {
  readonly databaseFilePath: string;
  listWorkspaceMessages(workspaceId: string): WorkspaceTimelineMessage[];
  appendWorkspaceMessage(
    input: AppendWorkspaceTimelineMessageInput,
  ): WorkspaceTimelineMessage;
  close(): void;
}

class WorkspaceTimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WorkspaceTimelineValidationError extends WorkspaceTimelineError {}
export class WorkspaceTimelineConflictError extends WorkspaceTimelineError {}

interface WorkspaceProjectRow {
  readonly projectId: string;
}

interface WorkspaceIdRow {
  readonly id: string;
}

interface ProjectIdRow {
  readonly id: string;
}

interface WorkspaceMessageRow {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly actorType: WorkspaceMessageActorType;
  readonly actorId: string | null;
  readonly content: string;
  readonly createdAt: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);

  if (normalized === undefined) {
    throw new WorkspaceTimelineValidationError(`${label} must be a non-empty string.`);
  }

  return normalized;
}

function isWorkspaceMessageActorType(
  value: string,
): value is WorkspaceMessageActorType {
  return (
    WORKSPACE_MESSAGE_ACTOR_TYPES as readonly string[]
  ).includes(value);
}

function mapSqliteError(error: unknown): WorkspaceTimelineError {
  if (!(error instanceof Error)) {
    return new WorkspaceTimelineError(String(error));
  }

  if (
    error.message.includes("UNIQUE constraint failed: workspaces.project_id") ||
    error.message.includes("must reference") ||
    error.message.includes("FOREIGN KEY constraint failed")
  ) {
    return new WorkspaceTimelineConflictError(error.message);
  }

  if (
    error.message.includes("UNIQUE constraint failed") ||
    error.message.includes("CHECK constraint failed")
  ) {
    return new WorkspaceTimelineValidationError(error.message);
  }

  return new WorkspaceTimelineError(error.message);
}

function resolveDbMigrationFilePath(moduleUrl = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));

  const candidates = [
    resolve(moduleDir, `../../../packages/db/migrations/${DB_INITIAL_MIGRATION_FILE}`),
    resolve(moduleDir, `../../packages/db/migrations/${DB_INITIAL_MIGRATION_FILE}`),
    resolve(moduleDir, `../migrations/${DB_INITIAL_MIGRATION_FILE}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Cannot resolve DB migration SQL from ${moduleDir}. Expected one of: ${candidates.join(", ")}`,
  );
}

function hasSchemaTables(database: SqliteDatabaseSync): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get<{ name: string }>(PROJECTS_TABLE_NAME);

  return row !== undefined;
}

function applySchemaMigrations(database: SqliteDatabaseSync): void {
  if (hasSchemaTables(database)) {
    return;
  }

  database.exec(readFileSync(resolveDbMigrationFilePath(), "utf8"));
}

function resolveConfigDir(
  configDir: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const fromOption = normalizeOptionalString(configDir);

  if (fromOption !== undefined) {
    return fromOption;
  }

  const fromEnv = normalizeOptionalString(env[ORQIS_CONFIG_DIR_ENV_VAR]);

  if (fromEnv !== undefined) {
    return fromEnv;
  }

  return join(homedir(), DEFAULT_ORQIS_CONFIG_DIR);
}

export function resolveWorkspaceTimelineDatabaseFilePath(
  options: WorkspaceTimelineStoreOptions = {},
): string {
  const env = options.env ?? process.env;

  const fromOption = normalizeOptionalString(options.databaseFilePath);

  if (fromOption !== undefined) {
    return resolve(fromOption);
  }

  const fromEnv = normalizeOptionalString(env[ORQIS_WEB_RUNTIME_DB_PATH_ENV_VAR]);

  if (fromEnv !== undefined) {
    return resolve(fromEnv);
  }

  return resolve(resolveConfigDir(options.configDir, env), DEFAULT_ORQIS_DB_FILE_NAME);
}

function createProjectName(projectId: string): string {
  return `Project ${projectId}`;
}

function createWorkspaceName(workspaceId: string): string {
  return `Workspace ${workspaceId}`;
}

class SqliteWorkspaceTimelineStore implements WorkspaceTimelineStore {
  private readonly database: SqliteDatabaseSync;
  private closed = false;

  constructor(readonly databaseFilePath: string) {
    mkdirSync(dirname(databaseFilePath), { recursive: true });
    this.database = new DatabaseSync(databaseFilePath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    applySchemaMigrations(this.database);
  }

  listWorkspaceMessages(workspaceId: string): WorkspaceTimelineMessage[] {
    const normalizedWorkspaceId = normalizeRequiredString(
      workspaceId,
      "workspaceId",
    );

    const rows = this.database
      .prepare(
        [
          "SELECT",
          "  id,",
          "  project_id AS projectId,",
          "  workspace_id AS workspaceId,",
          "  actor_type AS actorType,",
          "  actor_id AS actorId,",
          "  content,",
          "  created_at AS createdAt",
          "FROM messages",
          "WHERE workspace_id = ?",
          "ORDER BY created_at ASC, rowid ASC",
        ].join("\n"),
      )
      .all<WorkspaceMessageRow>(normalizedWorkspaceId);

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      actorType: row.actorType,
      actorId: row.actorId,
      content: row.content,
      createdAt: row.createdAt,
    }));
  }

  appendWorkspaceMessage(
    input: AppendWorkspaceTimelineMessageInput,
  ): WorkspaceTimelineMessage {
    const workspaceId = normalizeRequiredString(input.workspaceId, "workspaceId");
    const actorType = normalizeRequiredString(input.actorType, "actorType");

    if (!isWorkspaceMessageActorType(actorType)) {
      throw new WorkspaceTimelineValidationError(
        `actorType must be one of: ${WORKSPACE_MESSAGE_ACTOR_TYPES.join(", ")}.`,
      );
    }

    const content = normalizeRequiredString(input.content, "content");
    const projectId = normalizeOptionalString(input.projectId);
    const actorId = normalizeOptionalString(input.actorId) ?? null;
    const messageId = randomUUID();
    const createdAt = new Date().toISOString();

    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      const resolvedProjectId = this.ensureWorkspace(workspaceId, projectId);

      this.database
        .prepare(
          [
            "INSERT INTO messages",
            "  (id, project_id, workspace_id, actor_type, actor_id, content, created_at)",
            "VALUES",
            "  (?, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
        )
        .run(
          messageId,
          resolvedProjectId,
          workspaceId,
          actorType,
          actorId,
          content,
          createdAt,
        );

      this.database.exec("COMMIT");
      transactionStarted = false;

      return {
        id: messageId,
        projectId: resolvedProjectId,
        workspaceId,
        actorType,
        actorId,
        content,
        createdAt,
      };
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK");
      }

      throw mapSqliteError(error);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.database.close();
  }

  private ensureWorkspace(
    workspaceId: string,
    projectId: string | undefined,
  ): string {
    const existingWorkspace = this.database
      .prepare("SELECT project_id AS projectId FROM workspaces WHERE id = ?")
      .get<WorkspaceProjectRow>(workspaceId);

    if (existingWorkspace !== undefined) {
      if (
        projectId !== undefined &&
        existingWorkspace.projectId !== projectId
      ) {
        throw new WorkspaceTimelineConflictError(
          `workspace ${workspaceId} belongs to project ${existingWorkspace.projectId}; cannot append with project ${projectId}.`,
        );
      }

      return existingWorkspace.projectId;
    }

    const resolvedProjectId = projectId ?? workspaceId;

    const existingWorkspaceForProject = this.database
      .prepare("SELECT id FROM workspaces WHERE project_id = ?")
      .get<WorkspaceIdRow>(resolvedProjectId);

    if (
      existingWorkspaceForProject !== undefined &&
      existingWorkspaceForProject.id !== workspaceId
    ) {
      throw new WorkspaceTimelineConflictError(
        `project ${resolvedProjectId} is already mapped to workspace ${existingWorkspaceForProject.id}.`,
      );
    }

    const existingProject = this.database
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get<ProjectIdRow>(resolvedProjectId);

    if (existingProject === undefined) {
      this.database
        .prepare("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
        .run(
          resolvedProjectId,
          resolvedProjectId,
          createProjectName(resolvedProjectId),
        );
    }

    this.database
      .prepare("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)")
      .run(workspaceId, resolvedProjectId, createWorkspaceName(workspaceId));

    return resolvedProjectId;
  }
}

export function createWorkspaceTimelineStore(
  options: WorkspaceTimelineStoreOptions = {},
): WorkspaceTimelineStore {
  const databaseFilePath = resolveWorkspaceTimelineDatabaseFilePath(options);
  return new SqliteWorkspaceTimelineStore(databaseFilePath);
}
