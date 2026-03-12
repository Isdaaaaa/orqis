import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import {
  createProjectManagerPlannerService,
  PROJECT_MANAGER_PLANNER_ROLE_KEY,
  ProjectManagerPlannerValidationError,
} from "@orqis/core";

type SqliteDatabaseSync = InstanceType<typeof BetterSqlite3>;

const ORQIS_CONFIG_DIR_ENV_VAR = "ORQIS_CONFIG_DIR";
export const ORQIS_WEB_RUNTIME_DB_PATH_ENV_VAR = "ORQIS_WEB_RUNTIME_DB_PATH";
const DEFAULT_ORQIS_CONFIG_DIR = ".orqis";
const DEFAULT_ORQIS_DB_FILE_NAME = "orqis.db";
const PROJECTS_TABLE_NAME = "projects";
const ORQIS_SCHEMA_MIGRATIONS_TABLE_NAME = "orqis_schema_migrations";
const SQLITE_NATIVE_BINDING_UNAVAILABLE_ERROR_CODE =
  "ERR_ORQIS_SQLITE_BINDINGS_UNAVAILABLE";
const SQLITE_NATIVE_BINDING_RECOVERY_COMMANDS = [
  "pnpm install",
  "pnpm run orqis:web:sqlite:bootstrap",
  "pnpm run orqis:web:sqlite:doctor",
] as const;
const SQLITE_NATIVE_BINDING_ERROR_PATTERNS = [
  "Could not locate the bindings file",
  "No native build was found for",
  "node-v",
] as const;
const DB_MIGRATION_FILE_PATTERN = /^\d+_.+\.sql$/;
const LEGACY_DB_MIGRATION_SENTINELS = [
  {
    fileName: "0001_project_workspace_schema.sql",
    sentinelTableName: PROJECTS_TABLE_NAME,
  },
  {
    fileName: "0002_agent_configuration.sql",
    sentinelTableName: "provider_configs",
  },
] as const;

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

export interface ProjectWorkspaceSummary {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectDescription: string | null;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
}

export interface AgentProviderConfiguration {
  readonly providerKey: string;
  readonly displayName: string;
  readonly baseUrl: string | null;
}

export interface AgentModelConfiguration {
  readonly modelKey: string;
  readonly providerKey: string;
  readonly displayName: string;
}

export interface AgentRoleConfiguration {
  readonly roleKey: string;
  readonly displayName: string;
  readonly modelKey: string;
  readonly responsibility: string;
}

export interface AgentConfiguration {
  readonly providers: readonly AgentProviderConfiguration[];
  readonly models: readonly AgentModelConfiguration[];
  readonly agentRoles: readonly AgentRoleConfiguration[];
}

export interface SaveAgentProviderConfigurationInput {
  readonly providerKey: string;
  readonly displayName: string;
  readonly baseUrl?: string | null;
}

export interface SaveAgentModelConfigurationInput {
  readonly modelKey: string;
  readonly providerKey: string;
  readonly displayName: string;
}

export interface SaveAgentRoleConfigurationInput {
  readonly roleKey: string;
  readonly displayName: string;
  readonly modelKey: string;
  readonly responsibility: string;
}

export interface SaveAgentConfigurationInput {
  readonly providers: readonly SaveAgentProviderConfigurationInput[];
  readonly models: readonly SaveAgentModelConfigurationInput[];
  readonly agentRoles: readonly SaveAgentRoleConfigurationInput[];
}

export interface CreateProjectManagerPlanInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly requestedByActorId: string;
}

export interface ProjectManagerPlannedTaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly ownerRole: string;
  readonly ownerDisplayName: string;
  readonly title: string;
  readonly description: string;
  readonly state: "todo";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectManagerPlanRecord {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly goal: string;
  readonly summary: string;
  readonly projectManagerRoleKey: string;
  readonly projectManagerDisplayName: string;
  readonly createdAt: string;
  readonly goalMessage: WorkspaceTimelineMessage;
  readonly planMessage: WorkspaceTimelineMessage;
  readonly tasks: readonly ProjectManagerPlannedTaskRecord[];
}

export interface WorkspaceTimelineStoreOptions {
  readonly databaseFilePath?: string;
  readonly configDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WorkspaceTimelineStore {
  readonly databaseFilePath: string;
  listProjects(): ProjectWorkspaceSummary[];
  createProject(input: CreateProjectInput): ProjectWorkspaceSummary;
  createProjectManagerPlan(input: CreateProjectManagerPlanInput): ProjectManagerPlanRecord;
  listWorkspaceMessages(workspaceId: string): WorkspaceTimelineMessage[];
  getAgentConfiguration(): AgentConfiguration;
  saveAgentConfiguration(input: SaveAgentConfigurationInput): AgentConfiguration;
  appendWorkspaceMessage(
    input: AppendWorkspaceTimelineMessageInput,
  ): WorkspaceTimelineMessage;
  close(): void;
}

const ORQIS_AUDIT_SQL_FUNCTION_NAMES = {
  actorType: "orqis_audit_actor_type",
  actorId: "orqis_audit_actor_id",
  correlationRunId: "orqis_audit_correlation_run_id",
} as const;

interface WorkspaceAuditSqlContext {
  readonly actorType?: WorkspaceMessageActorType | null;
  readonly actorId?: string | null;
  readonly correlationRunId?: string | null;
}

export interface WorkspaceAuditSqlContextController {
  clearContext(): void;
  getCurrentContext(): Readonly<Required<WorkspaceAuditSqlContext>> | null;
  runWithContext<T>(context: WorkspaceAuditSqlContext, run: () => T): T;
}

export interface WorkspaceTimelineDatabaseHandle {
  readonly database: SqliteDatabaseSync;
  readonly auditContext: WorkspaceAuditSqlContextController;
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
export class WorkspaceTimelineDependencyError extends WorkspaceTimelineError {
  readonly code = SQLITE_NATIVE_BINDING_UNAVAILABLE_ERROR_CODE;
}

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

interface ProjectWorkspaceRow {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectDescription: string | null;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

interface AgentProviderConfigurationRow {
  readonly providerKey: string;
  readonly displayName: string;
  readonly baseUrl: string | null;
}

interface AgentModelConfigurationRow {
  readonly modelKey: string;
  readonly providerKey: string;
  readonly displayName: string;
}

interface AgentRoleConfigurationRow {
  readonly roleKey: string;
  readonly displayName: string;
  readonly modelKey: string;
  readonly responsibility: string;
}

interface AgentConfigurationCountRow {
  readonly providerCount: number;
  readonly modelCount: number;
  readonly agentRoleCount: number;
}

interface SchemaMigrationRow {
  readonly fileName: string;
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

function normalizeOptionalUrl(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return null;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(normalized);
  } catch {
    throw new WorkspaceTimelineValidationError(`${label} must be a valid URL.`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new WorkspaceTimelineValidationError(
      `${label} must use http or https.`,
    );
  }

  return parsedUrl.toString();
}

function normalizeAuditOptionalString(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new WorkspaceTimelineValidationError(
      `${label} must be a non-empty string when provided.`,
    );
  }

  return normalized;
}

function normalizeAuditActorType(
  actorType: WorkspaceMessageActorType | null | undefined,
): WorkspaceMessageActorType | null {
  if (actorType === null || actorType === undefined) {
    return null;
  }

  if (!isWorkspaceMessageActorType(actorType)) {
    throw new WorkspaceTimelineValidationError(
      `audit actorType must be one of: ${WORKSPACE_MESSAGE_ACTOR_TYPES.join(", ")}.`,
    );
  }

  return actorType;
}

function normalizeAuditContext(
  context: WorkspaceAuditSqlContext,
): Required<WorkspaceAuditSqlContext> {
  const actorType = normalizeAuditActorType(context.actorType);
  const actorId = normalizeAuditOptionalString(context.actorId, "audit actorId");
  const correlationRunId = normalizeAuditOptionalString(
    context.correlationRunId,
    "audit correlationRunId",
  );

  if (actorId !== null && actorType === null) {
    throw new WorkspaceTimelineValidationError(
      "audit actorType must be provided when audit actorId is set.",
    );
  }

  return {
    actorType,
    actorId,
    correlationRunId,
  };
}

function createWorkspaceAuditSqlContextController(): WorkspaceAuditSqlContextController {
  let currentContext: Required<WorkspaceAuditSqlContext> | null = null;

  return {
    clearContext(): void {
      currentContext = null;
    },
    getCurrentContext(): Required<WorkspaceAuditSqlContext> | null {
      return currentContext;
    },
    runWithContext<T>(context: WorkspaceAuditSqlContext, run: () => T): T {
      const previousContext = currentContext;
      currentContext = normalizeAuditContext(context);

      try {
        return run();
      } finally {
        currentContext = previousContext;
      }
    },
  };
}

function registerWorkspaceAuditSqlFunctions(
  database: SqliteDatabaseSync,
  getCurrentContext: () => WorkspaceAuditSqlContext | null | undefined,
): void {
  database.function(ORQIS_AUDIT_SQL_FUNCTION_NAMES.actorType, () => {
    return getCurrentContext()?.actorType ?? null;
  });
  database.function(ORQIS_AUDIT_SQL_FUNCTION_NAMES.actorId, () => {
    return getCurrentContext()?.actorId ?? null;
  });
  database.function(ORQIS_AUDIT_SQL_FUNCTION_NAMES.correlationRunId, () => {
    return getCurrentContext()?.correlationRunId ?? null;
  });
}

function isWorkspaceMessageActorType(
  value: string,
): value is WorkspaceMessageActorType {
  return (
    WORKSPACE_MESSAGE_ACTOR_TYPES as readonly string[]
  ).includes(value);
}

function mapSqliteError(error: unknown): WorkspaceTimelineError {
  if (error instanceof WorkspaceTimelineError) {
    return error;
  }

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

function isSqliteNativeBindingUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return SQLITE_NATIVE_BINDING_ERROR_PATTERNS.some((pattern) =>
    error.message.includes(pattern),
  );
}

function createSqliteNativeBindingUnavailableError(
  error: unknown,
): WorkspaceTimelineDependencyError {
  const originalMessage =
    error instanceof Error ? error.message : String(error);
  const recoverySteps = SQLITE_NATIVE_BINDING_RECOVERY_COMMANDS.map(
    (command, index) => `  ${index + 1}. ${command}`,
  ).join("\n");

  return new WorkspaceTimelineDependencyError(
    [
      "better-sqlite3 native bindings are unavailable, so the workspace timeline runtime cannot start.",
      "Recovery:",
      recoverySteps,
      `Original error: ${originalMessage}`,
    ].join("\n"),
  );
}

type SqliteRuntimeProbe = () => void;

function runDefaultSqliteRuntimeProbe(): void {
  const database = new BetterSqlite3(":memory:");

  try {
    database.pragma("foreign_keys = ON");
    database.prepare("SELECT 1 AS ok").get();
  } finally {
    database.close();
  }
}

export function validateWorkspaceTimelinePersistenceRuntime(
  probe: SqliteRuntimeProbe = runDefaultSqliteRuntimeProbe,
): void {
  try {
    probe();
  } catch (error) {
    if (isSqliteNativeBindingUnavailableError(error)) {
      throw createSqliteNativeBindingUnavailableError(error);
    }

    throw error;
  }
}

function resolveDbMigrationsDirPath(moduleUrl = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));

  const candidates = [
    resolve(moduleDir, "../../../packages/db/migrations"),
    resolve(moduleDir, "../../packages/db/migrations"),
    resolve(moduleDir, "../migrations"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Cannot resolve DB migrations directory from ${moduleDir}. Expected one of: ${candidates.join(", ")}`,
  );
}

function listDbMigrationFiles(moduleUrl = import.meta.url): string[] {
  return readdirSync(resolveDbMigrationsDirPath(moduleUrl))
    .filter((fileName) => DB_MIGRATION_FILE_PATTERN.test(fileName))
    .sort();
}

function readDbMigrationSql(fileName: string, moduleUrl = import.meta.url): string {
  return readFileSync(join(resolveDbMigrationsDirPath(moduleUrl), fileName), "utf8");
}

function hasTable(database: SqliteDatabaseSync, tableName: string): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName) as { name: string } | undefined;

  return row !== undefined;
}

function hasSchemaTables(database: SqliteDatabaseSync): boolean {
  return hasTable(database, PROJECTS_TABLE_NAME);
}

function ensureSchemaMigrationsTable(database: SqliteDatabaseSync): void {
  database.exec(
    [
      `CREATE TABLE IF NOT EXISTS \`${ORQIS_SCHEMA_MIGRATIONS_TABLE_NAME}\` (`,
      "  `file_name` text PRIMARY KEY NOT NULL,",
      "  `executed_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP",
      ");",
    ].join("\n"),
  );
}

function listAppliedSchemaMigrationFiles(database: SqliteDatabaseSync): Set<string> {
  const rows = database
    .prepare(
      [
        "SELECT",
        "  file_name AS fileName",
        `FROM ${ORQIS_SCHEMA_MIGRATIONS_TABLE_NAME}`,
        "ORDER BY file_name ASC",
      ].join("\n"),
    )
    .all() as SchemaMigrationRow[];

  return new Set(rows.map((row) => row.fileName));
}

function markSchemaMigrationApplied(
  database: SqliteDatabaseSync,
  fileName: string,
): void {
  database
    .prepare(
      `INSERT INTO ${ORQIS_SCHEMA_MIGRATIONS_TABLE_NAME} (file_name) VALUES (?)`,
    )
    .run(fileName);
}

function seedLegacySchemaMigrations(
  database: SqliteDatabaseSync,
  availableMigrationFiles: readonly string[],
): void {
  if (!hasSchemaTables(database)) {
    return;
  }

  const appliedMigrations = listAppliedSchemaMigrationFiles(database);

  for (const sentinel of LEGACY_DB_MIGRATION_SENTINELS) {
    if (
      !availableMigrationFiles.includes(sentinel.fileName) ||
      appliedMigrations.has(sentinel.fileName) ||
      !hasTable(database, sentinel.sentinelTableName)
    ) {
      continue;
    }

    markSchemaMigrationApplied(database, sentinel.fileName);
  }
}

function applySchemaMigrations(database: SqliteDatabaseSync): void {
  const availableMigrationFiles = listDbMigrationFiles();
  const hadSchemaMigrationsTable = hasTable(
    database,
    ORQIS_SCHEMA_MIGRATIONS_TABLE_NAME,
  );

  ensureSchemaMigrationsTable(database);

  if (!hadSchemaMigrationsTable) {
    seedLegacySchemaMigrations(database, availableMigrationFiles);
  }

  const appliedMigrations = listAppliedSchemaMigrationFiles(database);

  for (const fileName of availableMigrationFiles) {
    if (appliedMigrations.has(fileName)) {
      continue;
    }

    database.exec(readDbMigrationSql(fileName));
    markSchemaMigrationApplied(database, fileName);
  }
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

function createWorkspaceNameForProject(projectName: string): string {
  return `${projectName} workspace`;
}

function createProjectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "project";
}

function createDefaultAgentConfiguration(): SaveAgentConfigurationInput {
  return {
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
        responsibility:
          "Plans work, decomposes requests, assigns tasks, and manages approvals.",
      },
      {
        roleKey: "frontend_agent",
        displayName: "Frontend Agent",
        modelKey: "gpt-5",
        responsibility:
          "Owns UI structure, styling, interaction details, and browser-facing fixes.",
      },
      {
        roleKey: "backend_agent",
        displayName: "Backend Agent",
        modelKey: "gpt-5",
        responsibility:
          "Owns runtime behavior, orchestration services, persistence, and API contracts.",
      },
      {
        roleKey: "reviewer",
        displayName: "Reviewer",
        modelKey: "gpt-5",
        responsibility:
          "Owns validation, defect finding, regression review, and release-readiness checks.",
      },
    ],
  };
}

export function createWorkspaceTimelineDatabaseHandle(
  databaseFilePath: string,
): WorkspaceTimelineDatabaseHandle {
  validateWorkspaceTimelinePersistenceRuntime();

  let database: SqliteDatabaseSync | undefined;

  try {
    mkdirSync(dirname(databaseFilePath), { recursive: true });
    database = new BetterSqlite3(databaseFilePath);
    const auditContext = createWorkspaceAuditSqlContextController();
    database.pragma("foreign_keys = ON");
    applySchemaMigrations(database);
    registerWorkspaceAuditSqlFunctions(database, () =>
      auditContext.getCurrentContext(),
    );
    return {
      database,
      auditContext,
      close(): void {
        database?.close();
      },
    };
  } catch (error) {
    database?.close();

    if (isSqliteNativeBindingUnavailableError(error)) {
      throw createSqliteNativeBindingUnavailableError(error);
    }

    throw error;
  }
}

class SqliteWorkspaceTimelineStore implements WorkspaceTimelineStore {
  private readonly databaseHandle: WorkspaceTimelineDatabaseHandle;
  private readonly database: SqliteDatabaseSync;
  private closed = false;

  constructor(readonly databaseFilePath: string) {
    this.databaseHandle = createWorkspaceTimelineDatabaseHandle(databaseFilePath);
    this.database = this.databaseHandle.database;
    this.ensureAgentConfigurationSeeded();
  }

  getAgentConfiguration(): AgentConfiguration {
    const providers = this.database
      .prepare(
        [
          "SELECT",
          "  provider_key AS providerKey,",
          "  display_name AS displayName,",
          "  base_url AS baseUrl",
          "FROM provider_configs",
          "ORDER BY rowid ASC",
        ].join("\n"),
      )
      .all() as AgentProviderConfigurationRow[];

    const models = this.database
      .prepare(
        [
          "SELECT",
          "  model_key AS modelKey,",
          "  provider_key AS providerKey,",
          "  display_name AS displayName",
          "FROM model_configs",
          "ORDER BY rowid ASC",
        ].join("\n"),
      )
      .all() as AgentModelConfigurationRow[];

    const agentRoles = this.database
      .prepare(
        [
          "SELECT",
          "  role_key AS roleKey,",
          "  display_name AS displayName,",
          "  model_key AS modelKey,",
          "  responsibility",
          "FROM agent_profiles",
          "ORDER BY rowid ASC",
        ].join("\n"),
      )
      .all() as AgentRoleConfigurationRow[];

    return {
      providers: providers.map((provider) => ({
        providerKey: provider.providerKey,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
      })),
      models: models.map((model) => ({
        modelKey: model.modelKey,
        providerKey: model.providerKey,
        displayName: model.displayName,
      })),
      agentRoles: agentRoles.map((agentRole) => ({
        roleKey: agentRole.roleKey,
        displayName: agentRole.displayName,
        modelKey: agentRole.modelKey,
        responsibility: agentRole.responsibility,
      })),
    };
  }

  saveAgentConfiguration(
    input: SaveAgentConfigurationInput,
  ): AgentConfiguration {
    const providers = this.normalizeProviderConfigurations(input.providers);
    const models = this.normalizeModelConfigurations(input.models, providers);
    const agentRoles = this.normalizeAgentRoleConfigurations(
      input.agentRoles,
      models,
    );

    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      this.database.prepare("DELETE FROM agent_profiles").run();
      this.database.prepare("DELETE FROM model_configs").run();
      this.database.prepare("DELETE FROM provider_configs").run();

      for (const provider of providers) {
        this.database
          .prepare(
            [
              "INSERT INTO provider_configs",
              "  (provider_key, display_name, base_url)",
              "VALUES",
              "  (?, ?, ?)",
            ].join("\n"),
          )
          .run(provider.providerKey, provider.displayName, provider.baseUrl);
      }

      for (const model of models) {
        this.database
          .prepare(
            [
              "INSERT INTO model_configs",
              "  (model_key, provider_key, display_name)",
              "VALUES",
              "  (?, ?, ?)",
            ].join("\n"),
          )
          .run(model.modelKey, model.providerKey, model.displayName);
      }

      for (const agentRole of agentRoles) {
        this.database
          .prepare(
            [
              "INSERT INTO agent_profiles",
              "  (role_key, display_name, model_key, responsibility)",
              "VALUES",
              "  (?, ?, ?, ?)",
            ].join("\n"),
          )
          .run(
            agentRole.roleKey,
            agentRole.displayName,
            agentRole.modelKey,
            agentRole.responsibility,
          );
      }

      this.database.exec("COMMIT");
      transactionStarted = false;

      return this.getAgentConfiguration();
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK");
      }

      throw mapSqliteError(error);
    }
  }

  listProjects(): ProjectWorkspaceSummary[] {
    const rows = this.database
      .prepare(
        [
          "SELECT",
          "  projects.id AS projectId,",
          "  projects.slug AS projectSlug,",
          "  projects.name AS projectName,",
          "  projects.description AS projectDescription,",
          "  workspaces.id AS workspaceId,",
          "  workspaces.name AS workspaceName",
          "FROM projects",
          "JOIN workspaces ON workspaces.project_id = projects.id",
          "ORDER BY projects.created_at ASC, projects.rowid ASC",
        ].join("\n"),
      )
      .all() as ProjectWorkspaceRow[];

    return rows.map((row) => ({
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      projectName: row.projectName,
      projectDescription: row.projectDescription,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
    }));
  }

  createProject(input: CreateProjectInput): ProjectWorkspaceSummary {
    const projectName = normalizeRequiredString(input.name, "name");
    const projectDescription = normalizeOptionalString(input.description) ?? null;

    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      const projectSlug = this.resolveUniqueProjectSlug(createProjectSlug(projectName));
      const projectId = randomUUID();
      const workspaceId = `workspace-${projectId}`;
      const workspaceName = createWorkspaceNameForProject(projectName);

      this.database
        .prepare("INSERT INTO projects (id, slug, name, description) VALUES (?, ?, ?, ?)")
        .run(projectId, projectSlug, projectName, projectDescription);

      this.database
        .prepare("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)")
        .run(workspaceId, projectId, workspaceName);

      this.database.exec("COMMIT");
      transactionStarted = false;

      return {
        projectId,
        projectSlug,
        projectName,
        projectDescription,
        workspaceId,
        workspaceName,
      };
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK");
      }

      throw mapSqliteError(error);
    }
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
      .all(normalizedWorkspaceId) as WorkspaceMessageRow[];

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

  createProjectManagerPlan(
    input: CreateProjectManagerPlanInput,
  ): ProjectManagerPlanRecord {
    const workspaceId = normalizeRequiredString(input.workspaceId, "workspaceId");
    const projectId = normalizeRequiredString(input.projectId, "projectId");
    const goal = normalizeRequiredString(input.goal, "goal");
    const requestedByActorId = normalizeRequiredString(
      input.requestedByActorId,
      "requestedByActorId",
    );

    const planner = createProjectManagerPlannerService();
    let plan;

    try {
      plan = planner.planGoal({
        goal,
        roles: this.getAgentConfiguration().agentRoles,
      });
    } catch (error) {
      if (error instanceof ProjectManagerPlannerValidationError) {
        throw new WorkspaceTimelineValidationError(error.message);
      }

      throw error;
    }

    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    const goalMessageId = randomUUID();
    const planMessageId = randomUUID();
    const plannedTasks = [] as ProjectManagerPlannedTaskRecord[];
    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      this.requireProjectWorkspaceMatch(workspaceId, projectId);

      this.databaseHandle.auditContext.runWithContext(
        {
          actorType: "agent",
          actorId: plan.projectManagerRoleKey,
          correlationRunId: runId,
        },
        () => {
          this.database
            .prepare(
              [
                "INSERT INTO runs",
                "  (id, project_id, workspace_id, status, summary, created_at, updated_at)",
                "VALUES",
                "  (?, ?, ?, ?, ?, ?, ?)",
              ].join("\n"),
            )
            .run(
              runId,
              projectId,
              workspaceId,
              "planned",
              plan.summary,
              createdAt,
              createdAt,
            );

          for (const task of plan.tasks) {
            const taskId = randomUUID();

            this.database
              .prepare(
                [
                  "INSERT INTO tasks",
                  "  (id, project_id, workspace_id, run_id, title, description, state, owner_role, created_at, updated_at)",
                  "VALUES",
                  "  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ].join("\n"),
              )
              .run(
                taskId,
                projectId,
                workspaceId,
                runId,
                task.title,
                task.description,
                task.state,
                task.ownerRole,
                createdAt,
                createdAt,
              );

            plannedTasks.push({
              id: taskId,
              projectId,
              workspaceId,
              runId,
              ownerRole: task.ownerRole,
              ownerDisplayName: task.ownerDisplayName,
              title: task.title,
              description: task.description,
              state: task.state,
              createdAt,
              updatedAt: createdAt,
            });
          }
        },
      );

      this.database
        .prepare(
          [
            "INSERT INTO messages",
            "  (id, project_id, workspace_id, run_id, actor_type, actor_id, content, created_at)",
            "VALUES",
            "  (?, ?, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
        )
        .run(
          goalMessageId,
          projectId,
          workspaceId,
          runId,
          "user",
          requestedByActorId,
          goal,
          createdAt,
        );

      this.database
        .prepare(
          [
            "INSERT INTO messages",
            "  (id, project_id, workspace_id, run_id, actor_type, actor_id, content, created_at)",
            "VALUES",
            "  (?, ?, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
        )
        .run(
          planMessageId,
          projectId,
          workspaceId,
          runId,
          "agent",
          plan.projectManagerRoleKey,
          plan.message,
          createdAt,
        );

      this.database.exec("COMMIT");
      transactionStarted = false;

      return {
        projectId,
        workspaceId,
        runId,
        goal,
        summary: plan.summary,
        projectManagerRoleKey: plan.projectManagerRoleKey,
        projectManagerDisplayName: plan.projectManagerDisplayName,
        createdAt,
        goalMessage: {
          id: goalMessageId,
          projectId,
          workspaceId,
          actorType: "user",
          actorId: requestedByActorId,
          content: goal,
          createdAt,
        },
        planMessage: {
          id: planMessageId,
          projectId,
          workspaceId,
          actorType: "agent",
          actorId: plan.projectManagerRoleKey,
          content: plan.message,
          createdAt,
        },
        tasks: plannedTasks,
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
    this.databaseHandle.close();
  }

  private ensureWorkspace(
    workspaceId: string,
    projectId: string | undefined,
  ): string {
    const existingWorkspace = this.database
      .prepare("SELECT project_id AS projectId FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceProjectRow | undefined;

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
      .get(resolvedProjectId) as WorkspaceIdRow | undefined;

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
      .get(resolvedProjectId) as ProjectIdRow | undefined;

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

  private requireProjectWorkspaceMatch(
    workspaceId: string,
    projectId: string,
  ): void {
    const existingWorkspace = this.database
      .prepare("SELECT project_id AS projectId FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceProjectRow | undefined;

    if (existingWorkspace === undefined) {
      throw new WorkspaceTimelineConflictError(
        `workspace ${workspaceId} does not exist.`,
      );
    }

    if (existingWorkspace.projectId !== projectId) {
      throw new WorkspaceTimelineConflictError(
        `workspace ${workspaceId} belongs to project ${existingWorkspace.projectId}; cannot plan for project ${projectId}.`,
      );
    }
  }

  private resolveUniqueProjectSlug(baseSlug: string): string {
    let slug = baseSlug;
    let suffix = 2;

    while (this.projectSlugExists(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    return slug;
  }

  private projectSlugExists(slug: string): boolean {
    const existingProject = this.database
      .prepare("SELECT id FROM projects WHERE slug = ? LIMIT 1")
      .get(slug) as ProjectIdRow | undefined;

    return existingProject !== undefined;
  }

  private ensureAgentConfigurationSeeded(): void {
    const counts = this.database
      .prepare(
        [
          "SELECT",
          "  (SELECT COUNT(*) FROM provider_configs) AS providerCount,",
          "  (SELECT COUNT(*) FROM model_configs) AS modelCount,",
          "  (SELECT COUNT(*) FROM agent_profiles) AS agentRoleCount",
        ].join("\n"),
      )
      .get() as AgentConfigurationCountRow;

    if (
      counts.providerCount >= 1 &&
      counts.modelCount >= 1 &&
      counts.agentRoleCount >= 2
    ) {
      return;
    }

    this.saveAgentConfiguration(createDefaultAgentConfiguration());
  }

  private normalizeProviderConfigurations(
    providers: readonly SaveAgentProviderConfigurationInput[],
  ): AgentProviderConfiguration[] {
    if (providers.length === 0) {
      throw new WorkspaceTimelineValidationError(
        "At least one provider configuration is required.",
      );
    }

    const seenProviderKeys = new Set<string>();

    return providers.map((provider, index) => {
      const providerKey = normalizeRequiredString(
        provider.providerKey,
        `providers[${index}].providerKey`,
      ).toLowerCase();
      const displayName = normalizeRequiredString(
        provider.displayName,
        `providers[${index}].displayName`,
      );

      if (seenProviderKeys.has(providerKey)) {
        throw new WorkspaceTimelineValidationError(
          `providers[${index}].providerKey must be unique.`,
        );
      }

      seenProviderKeys.add(providerKey);

      return {
        providerKey,
        displayName,
        baseUrl: normalizeOptionalUrl(
          provider.baseUrl,
          `providers[${index}].baseUrl`,
        ),
      };
    });
  }

  private normalizeModelConfigurations(
    models: readonly SaveAgentModelConfigurationInput[],
    providers: readonly AgentProviderConfiguration[],
  ): AgentModelConfiguration[] {
    if (models.length === 0) {
      throw new WorkspaceTimelineValidationError(
        "At least one model configuration is required.",
      );
    }

    const providerKeys = new Set(providers.map((provider) => provider.providerKey));
    const seenModelKeys = new Set<string>();

    return models.map((model, index) => {
      const modelKey = normalizeRequiredString(
        model.modelKey,
        `models[${index}].modelKey`,
      );
      const providerKey = normalizeRequiredString(
        model.providerKey,
        `models[${index}].providerKey`,
      ).toLowerCase();
      const displayName = normalizeRequiredString(
        model.displayName,
        `models[${index}].displayName`,
      );

      if (!providerKeys.has(providerKey)) {
        throw new WorkspaceTimelineValidationError(
          `models[${index}].providerKey must reference an existing provider.`,
        );
      }

      if (seenModelKeys.has(modelKey)) {
        throw new WorkspaceTimelineValidationError(
          `models[${index}].modelKey must be unique.`,
        );
      }

      seenModelKeys.add(modelKey);

      return {
        modelKey,
        providerKey,
        displayName,
      };
    });
  }

  private normalizeAgentRoleConfigurations(
    agentRoles: readonly SaveAgentRoleConfigurationInput[],
    models: readonly AgentModelConfiguration[],
  ): AgentRoleConfiguration[] {
    if (agentRoles.length < 2) {
      throw new WorkspaceTimelineValidationError(
        "At least two agent role configurations are required.",
      );
    }

    const modelKeys = new Set(models.map((model) => model.modelKey));
    const seenRoleKeys = new Set<string>();

    const normalizedRoles = agentRoles.map((agentRole, index) => {
      const roleKey = normalizeRequiredString(
        agentRole.roleKey,
        `agentRoles[${index}].roleKey`,
      ).toLowerCase();
      const displayName = normalizeRequiredString(
        agentRole.displayName,
        `agentRoles[${index}].displayName`,
      );
      const modelKey = normalizeRequiredString(
        agentRole.modelKey,
        `agentRoles[${index}].modelKey`,
      );
      const responsibility = normalizeRequiredString(
        agentRole.responsibility,
        `agentRoles[${index}].responsibility`,
      );

      if (!modelKeys.has(modelKey)) {
        throw new WorkspaceTimelineValidationError(
          `agentRoles[${index}].modelKey must reference an existing model.`,
        );
      }

      if (seenRoleKeys.has(roleKey)) {
        throw new WorkspaceTimelineValidationError(
          `agentRoles[${index}].roleKey must be unique.`,
        );
      }

      seenRoleKeys.add(roleKey);

      return {
        roleKey,
        displayName,
        modelKey,
        responsibility,
      };
    });

    if (
      !normalizedRoles.some(
        (agentRole) => agentRole.roleKey === PROJECT_MANAGER_PLANNER_ROLE_KEY,
      )
    ) {
      throw new WorkspaceTimelineValidationError(
        `agentRoles must include the reserved "${PROJECT_MANAGER_PLANNER_ROLE_KEY}" role key for planner compatibility.`,
      );
    }

    return normalizedRoles;
  }
}

export function createWorkspaceTimelineStore(
  options: WorkspaceTimelineStoreOptions = {},
): WorkspaceTimelineStore {
  const databaseFilePath = resolveWorkspaceTimelineDatabaseFilePath(options);
  return new SqliteWorkspaceTimelineStore(databaseFilePath);
}
