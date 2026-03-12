import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import {
  createApprovalGuardedTransitionService,
  ApprovalGuardedTransitionBlockedError,
  ApprovalGuardedTransitionConflictError,
  ApprovalGuardedTransitionNotFoundError,
  ApprovalGuardedTransitionValidationError,
  canTransitionRunLifecycle,
  createProjectManagerPlannerService,
  createTaskClaimService,
  getAllowedRunLifecycleTransitions,
  PROJECT_MANAGER_PLANNER_ROLE_KEY,
  ProjectManagerPlannerValidationError,
  TASK_CLAIM_OWNER_TYPES,
  type RunLifecycleStatus,
  type TaskClaimConflictCode,
  type TaskClaimOwnerType,
  type TaskClaimRecord,
  type TaskClaimRepository,
  type TaskClaimServiceTaskState,
  TaskClaimConflictError,
  TaskClaimNotFoundError,
  TaskClaimValidationError,
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

export interface WorkspaceTaskAssignmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly roleKey: string;
  readonly roleDisplayName: string;
  readonly modelKey: string | null;
  readonly roleResponsibility: string;
  readonly assignedByActorType: WorkspaceMessageActorType;
  readonly assignedByActorId: string | null;
  readonly assignedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const WORKSPACE_TASK_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "revision_requested",
  "resubmitted",
] as const;
export type WorkspaceTaskApprovalStatus =
  (typeof WORKSPACE_TASK_APPROVAL_STATUSES)[number];

export const TASK_APPROVAL_DECISION_STATUSES = [
  "approved",
  "rejected",
  "revision_requested",
] as const;
export type TaskApprovalDecisionStatus =
  (typeof TASK_APPROVAL_DECISION_STATUSES)[number];

export interface WorkspaceTaskApprovalRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly status: WorkspaceTaskApprovalStatus;
  readonly requestedByActorType: WorkspaceMessageActorType;
  readonly requestedByActorId: string | null;
  readonly decisionByActorType: WorkspaceMessageActorType | null;
  readonly decisionByActorId: string | null;
  readonly decisionSummary: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly revisionRequestedAt: string | null;
  readonly resubmittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceTaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly ownerRole: string | null;
  readonly ownerDisplayName: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: TaskClaimServiceTaskState;
  readonly lockOwnerType: TaskClaimOwnerType | null;
  readonly lockOwnerId: string | null;
  readonly lockAcquiredAt: string | null;
  readonly checkoutRunId: string | null;
  readonly executionRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly assignment: WorkspaceTaskAssignmentRecord | null;
}

export interface ProjectManagerPlannedTaskRecord extends WorkspaceTaskRecord {
  readonly ownerDisplayName: string;
  readonly assignment: WorkspaceTaskAssignmentRecord;
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
  listWorkspaceTasks(workspaceId: string): WorkspaceTaskRecord[];
  claimTaskExecution(input: ClaimTaskExecutionInput): Promise<WorkspaceTaskRecord>;
  releaseTaskExecution(input: ReleaseTaskExecutionInput): Promise<WorkspaceTaskRecord>;
  submitTaskOutput(input: SubmitTaskOutputInput): Promise<SubmitTaskOutputResult>;
  decideTaskApproval(
    input: DecideTaskApprovalInput,
  ): Promise<DecideTaskApprovalResult>;
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
export class WorkspaceTimelineNotFoundError extends WorkspaceTimelineError {}
export class WorkspaceTimelineDependencyError extends WorkspaceTimelineError {
  readonly code = SQLITE_NATIVE_BINDING_UNAVAILABLE_ERROR_CODE;
}

export class WorkspaceTaskClaimConflictError extends WorkspaceTimelineConflictError {
  readonly code: TaskClaimConflictCode;
  readonly taskId: string;
  readonly currentExecutionRunId: string | null;
  readonly currentCheckoutRunId: string | null;
  readonly currentOwnerType: TaskClaimOwnerType | null;
  readonly currentOwnerId: string | null;

  constructor(error: TaskClaimConflictError) {
    super(error.message);
    this.name = new.target.name;
    this.code = error.code;
    this.taskId = error.taskId;
    this.currentExecutionRunId = error.currentExecutionRunId;
    this.currentCheckoutRunId = error.currentCheckoutRunId;
    this.currentOwnerType = error.currentOwnerType;
    this.currentOwnerId = error.currentOwnerId;
  }
}

export class WorkspaceTaskAssignmentConflictError extends WorkspaceTimelineConflictError {
  readonly code = "task_assigned_to_another_role";
  readonly taskId: string;
  readonly assignedRoleKey: string | null;
  readonly attemptedRoleKey: string;

  constructor(taskId: string, assignedRoleKey: string | null, attemptedRoleKey: string) {
    super(
      assignedRoleKey === null
        ? `Task "${taskId}" does not have a specialist role assignment to claim.`
        : `Task "${taskId}" is assigned to role "${assignedRoleKey}", so agent "${attemptedRoleKey}" cannot claim it.`,
    );
    this.name = new.target.name;
    this.taskId = taskId;
    this.assignedRoleKey = assignedRoleKey;
    this.attemptedRoleKey = attemptedRoleKey;
  }
}

export interface ClaimTaskExecutionInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
  readonly claimedAt?: string;
}

export interface ReleaseTaskExecutionInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
}

export interface SubmitTaskOutputInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
  readonly output: string;
}

export interface SubmitTaskOutputResult {
  readonly task: WorkspaceTaskRecord;
  readonly approval: WorkspaceTaskApprovalRecord;
  readonly outputMessage: WorkspaceTimelineMessage;
  readonly projectManagerMessage: WorkspaceTimelineMessage;
}

export interface DecideTaskApprovalInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly decision: TaskApprovalDecisionStatus;
  readonly decisionSummary?: string;
  readonly decidedByActorId: string;
}

export interface DecideTaskApprovalResult {
  readonly task: WorkspaceTaskRecord;
  readonly approval: WorkspaceTaskApprovalRecord;
  readonly decisionMessage: WorkspaceTimelineMessage;
  readonly projectManagerMessage: WorkspaceTimelineMessage;
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

interface WorkspaceTaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly ownerRole: string | null;
  readonly ownerDisplayName: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: TaskClaimServiceTaskState;
  readonly lockOwnerType: TaskClaimOwnerType | null;
  readonly lockOwnerId: string | null;
  readonly lockAcquiredAt: string | null;
  readonly checkoutRunId: string | null;
  readonly executionRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly assignmentId: string | null;
  readonly assignmentRunId: string | null;
  readonly assignmentRoleKey: string | null;
  readonly assignmentRoleDisplayName: string | null;
  readonly assignmentModelKey: string | null;
  readonly assignmentRoleResponsibility: string | null;
  readonly assignedByActorType: WorkspaceMessageActorType | null;
  readonly assignedByActorId: string | null;
  readonly assignedAt: string | null;
  readonly assignmentCreatedAt: string | null;
  readonly assignmentUpdatedAt: string | null;
}

interface WorkspaceTaskApprovalRow {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly status: WorkspaceTaskApprovalStatus;
  readonly requestedByActorType: WorkspaceMessageActorType;
  readonly requestedByActorId: string | null;
  readonly decisionByActorType: WorkspaceMessageActorType | null;
  readonly decisionByActorId: string | null;
  readonly decisionSummary: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly revisionRequestedAt: string | null;
  readonly resubmittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorkspaceRunStatusRow {
  readonly id: string;
  readonly status: RunLifecycleStatus;
}

interface SchemaMigrationRow {
  readonly fileName: string;
}

type TaskClaimSnapshot = Parameters<
  TaskClaimRepository["compareAndSwapTaskClaim"]
>[1];

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

function isTaskClaimOwnerType(value: string): value is TaskClaimOwnerType {
  return (TASK_CLAIM_OWNER_TYPES as readonly string[]).includes(value);
}

function isTaskApprovalDecisionStatus(
  value: string,
): value is TaskApprovalDecisionStatus {
  return (TASK_APPROVAL_DECISION_STATUSES as readonly string[]).includes(value);
}

function assertTaskExecutionOwnerIdentity(input: {
  readonly runId: string;
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
}): void {
  if (input.ownerType === "run" && input.ownerId !== input.runId) {
    throw new WorkspaceTimelineValidationError(
      "ownerId must equal runId when ownerType is run.",
    );
  }
}

function mapWorkspaceTaskRow(row: WorkspaceTaskRow): WorkspaceTaskRecord {
  const assignment =
    row.assignmentId === null ||
    row.assignmentRoleKey === null ||
    row.assignmentRoleDisplayName === null ||
    row.assignmentRoleResponsibility === null ||
    row.assignedByActorType === null ||
    row.assignedAt === null ||
    row.assignmentCreatedAt === null ||
    row.assignmentUpdatedAt === null
      ? null
      : {
          id: row.assignmentId,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
          taskId: row.id,
          runId: row.assignmentRunId,
          roleKey: row.assignmentRoleKey,
          roleDisplayName: row.assignmentRoleDisplayName,
          modelKey: row.assignmentModelKey,
          roleResponsibility: row.assignmentRoleResponsibility,
          assignedByActorType: row.assignedByActorType,
          assignedByActorId: row.assignedByActorId,
          assignedAt: row.assignedAt,
          createdAt: row.assignmentCreatedAt,
          updatedAt: row.assignmentUpdatedAt,
        };

  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    runId: row.runId,
    ownerRole: row.ownerRole,
    ownerDisplayName: row.ownerDisplayName ?? assignment?.roleDisplayName ?? row.ownerRole,
    title: row.title,
    description: row.description,
    state: row.state,
    lockOwnerType: row.lockOwnerType,
    lockOwnerId: row.lockOwnerId,
    lockAcquiredAt: row.lockAcquiredAt,
    checkoutRunId: row.checkoutRunId,
    executionRunId: row.executionRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    assignment,
  };
}

function mapWorkspaceTaskApprovalRow(
  row: WorkspaceTaskApprovalRow,
): WorkspaceTaskApprovalRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    taskId: row.taskId,
    runId: row.runId,
    status: row.status,
    requestedByActorType: row.requestedByActorType,
    requestedByActorId: row.requestedByActorId,
    decisionByActorType: row.decisionByActorType,
    decisionByActorId: row.decisionByActorId,
    decisionSummary: row.decisionSummary,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    revisionRequestedAt: row.revisionRequestedAt,
    resubmittedAt: row.resubmittedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function resolveWorkflowActor(input: {
  readonly ownerType: TaskClaimOwnerType;
  readonly ownerId: string;
  readonly runId: string;
}): { actorType: WorkspaceMessageActorType; actorId: string } {
  if (input.ownerType === "agent") {
    return {
      actorType: "agent",
      actorId: input.ownerId,
    };
  }

  if (input.ownerType === "user") {
    return {
      actorType: "user",
      actorId: input.ownerId,
    };
  }

  return {
    actorType: "system",
    actorId: input.runId,
  };
}

function createTaskOutputMessageContent(
  task: WorkspaceTaskRecord,
  output: string,
): string {
  return [`Task output submitted for "${task.title}".`, "", output].join("\n");
}

function createTaskApprovalWaitingMessageContent(task: WorkspaceTaskRecord): string {
  return `Project Manager is waiting for approval on "${task.title}".`;
}

function createTaskApprovalDecisionMessageContent(input: {
  readonly task: WorkspaceTaskRecord;
  readonly decision: TaskApprovalDecisionStatus;
  readonly decisionSummary: string | null;
  readonly actorId: string;
}): string {
  const decisionLabel =
    input.decision === "revision_requested"
      ? "requested revisions for"
      : input.decision === "rejected"
        ? "rejected"
        : "approved";

  return input.decisionSummary === null
    ? `User "${input.actorId}" ${decisionLabel} "${input.task.title}".`
    : `User "${input.actorId}" ${decisionLabel} "${input.task.title}": ${input.decisionSummary}`;
}

function createProjectManagerDecisionMessageContent(input: {
  readonly task: WorkspaceTaskRecord;
  readonly decision: TaskApprovalDecisionStatus;
}): string {
  if (input.decision === "approved") {
    return `Project Manager received approval for "${input.task.title}" and can continue the workflow.`;
  }

  if (input.decision === "revision_requested") {
    return `Project Manager received a revision request for "${input.task.title}" and returned it to the assigned specialist.`;
  }

  return `Project Manager received a rejection for "${input.task.title}" and should replan or replace the task.`;
}

function createRunTransitionConflictMessage(input: {
  readonly runId: string;
  readonly from: RunLifecycleStatus;
  readonly to: RunLifecycleStatus;
}): string {
  const allowedTargets = getAllowedRunLifecycleTransitions(input.from);
  const allowedList =
    allowedTargets.length > 0
      ? allowedTargets.join(", ")
      : "(terminal state with no outgoing transitions)";

  return `Run "${input.runId}" cannot transition from status "${input.from}" to "${input.to}". Allowed targets from "${input.from}": ${allowedList}.`;
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

  listWorkspaceTasks(workspaceId: string): WorkspaceTaskRecord[] {
    const normalizedWorkspaceId = normalizeRequiredString(
      workspaceId,
      "workspaceId",
    );

    return this.queryWorkspaceTasks(normalizedWorkspaceId);
  }

  async claimTaskExecution(
    input: ClaimTaskExecutionInput,
  ): Promise<WorkspaceTaskRecord> {
    const workspaceId = normalizeRequiredString(input.workspaceId, "workspaceId");
    const taskId = normalizeRequiredString(input.taskId, "taskId");
    const runId = normalizeRequiredString(input.runId, "runId");
    const ownerType = normalizeRequiredString(input.ownerType, "ownerType");
    const ownerId = normalizeRequiredString(input.ownerId, "ownerId");
    const claimedAt =
      input.claimedAt === undefined
        ? undefined
        : normalizeRequiredString(input.claimedAt, "claimedAt");

    if (!isTaskClaimOwnerType(ownerType)) {
      throw new WorkspaceTimelineValidationError(
        `ownerType must be one of: ${TASK_CLAIM_OWNER_TYPES.join(", ")}.`,
      );
    }

    assertTaskExecutionOwnerIdentity({
      runId,
      ownerType,
      ownerId,
    });

    const task = this.requireWorkspaceTask(taskId, workspaceId);
    this.assertAgentClaimMatchesAssignment(task, ownerType, ownerId);
    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      await this.createTaskClaimServiceForAuditContext({
        actorType:
          ownerType === "user" ? "user" : ownerType === "agent" ? "agent" : "system",
        actorId: ownerType === "run" ? runId : ownerId,
        correlationRunId: runId,
      }).claimTaskExecution({
        taskId,
        runId,
        ownerType,
        ownerId,
        claimedAt,
      });

      this.markRunRunningAfterClaim(runId);
      const claimedTask = this.requireWorkspaceTask(taskId, workspaceId);

      this.database.exec("COMMIT");
      transactionStarted = false;

      return claimedTask;
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK");
      }

      if (error instanceof TaskClaimValidationError) {
        throw new WorkspaceTimelineValidationError(error.message);
      }

      if (error instanceof TaskClaimNotFoundError) {
        throw new WorkspaceTimelineNotFoundError(error.message);
      }

      if (error instanceof TaskClaimConflictError) {
        throw new WorkspaceTaskClaimConflictError(error);
      }

      throw mapSqliteError(error);
    }
  }

  async releaseTaskExecution(
    input: ReleaseTaskExecutionInput,
  ): Promise<WorkspaceTaskRecord> {
    const workspaceId = normalizeRequiredString(input.workspaceId, "workspaceId");
    const taskId = normalizeRequiredString(input.taskId, "taskId");
    const runId = normalizeRequiredString(input.runId, "runId");
    const ownerType = normalizeRequiredString(input.ownerType, "ownerType");
    const ownerId = normalizeRequiredString(input.ownerId, "ownerId");

    if (!isTaskClaimOwnerType(ownerType)) {
      throw new WorkspaceTimelineValidationError(
        `ownerType must be one of: ${TASK_CLAIM_OWNER_TYPES.join(", ")}.`,
      );
    }

    assertTaskExecutionOwnerIdentity({
      runId,
      ownerType,
      ownerId,
    });

    this.requireWorkspaceTask(taskId, workspaceId);

    try {
      await this.createTaskClaimServiceForAuditContext({
        actorType:
          ownerType === "user" ? "user" : ownerType === "agent" ? "agent" : "system",
        actorId: ownerType === "run" ? runId : ownerId,
        correlationRunId: runId,
      }).releaseTaskExecution({
        taskId,
        runId,
        ownerType,
        ownerId,
      });

      return this.requireWorkspaceTask(taskId, workspaceId);
    } catch (error) {
      if (error instanceof TaskClaimValidationError) {
        throw new WorkspaceTimelineValidationError(error.message);
      }

      if (error instanceof TaskClaimNotFoundError) {
        throw new WorkspaceTimelineNotFoundError(error.message);
      }

      if (error instanceof TaskClaimConflictError) {
        throw new WorkspaceTaskClaimConflictError(error);
      }

      throw mapSqliteError(error);
    }
  }

  async submitTaskOutput(
    input: SubmitTaskOutputInput,
  ): Promise<SubmitTaskOutputResult> {
    const workspaceId = normalizeRequiredString(input.workspaceId, "workspaceId");
    const taskId = normalizeRequiredString(input.taskId, "taskId");
    const runId = normalizeRequiredString(input.runId, "runId");
    const ownerType = normalizeRequiredString(input.ownerType, "ownerType");
    const ownerId = normalizeRequiredString(input.ownerId, "ownerId");
    const output = normalizeRequiredString(input.output, "output");

    if (!isTaskClaimOwnerType(ownerType)) {
      throw new WorkspaceTimelineValidationError(
        `ownerType must be one of: ${TASK_CLAIM_OWNER_TYPES.join(", ")}.`,
      );
    }

    assertTaskExecutionOwnerIdentity({
      runId,
      ownerType,
      ownerId,
    });
    const workflowActor = resolveWorkflowActor({
      ownerType,
      ownerId,
      runId,
    });

    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      let task = this.requireWorkspaceTask(taskId, workspaceId);
      this.assertAgentClaimMatchesAssignment(task, ownerType, ownerId);

      // Allow shell-only submit flows by claiming claimable tasks on demand.
      if (task.state === "todo" || task.state === "in_progress") {
        await this.createTaskClaimServiceForAuditContext({
          actorType: workflowActor.actorType,
          actorId: workflowActor.actorId,
          correlationRunId: runId,
        }).claimTaskExecution({
          taskId,
          runId,
          ownerType,
          ownerId,
        });

        this.markRunRunningAfterClaim(runId);
        task = this.requireWorkspaceTask(taskId, workspaceId);
      }

      this.assertTaskOutputSubmissionAllowed(task, {
        runId,
        ownerType,
        ownerId,
      });

      const existingApproval = this.getTaskApprovalRecord(taskId);

      if (
        existingApproval !== undefined &&
        existingApproval.status !== "revision_requested"
      ) {
        throw new WorkspaceTimelineConflictError(
          `Task "${taskId}" cannot accept a new output submission while approval "${existingApproval.id}" is "${existingApproval.status}".`,
        );
      }

      const createdAt = new Date().toISOString();

      const outputMessage = this.databaseHandle.auditContext.runWithContext(
        {
          actorType: workflowActor.actorType,
          actorId: workflowActor.actorId,
          correlationRunId: runId,
        },
        () => {
          if (existingApproval === undefined) {
            const approvalId = randomUUID();

            this.database
              .prepare(
                [
                  "INSERT INTO approvals",
                  "  (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type, requested_by_actor_id, requested_at, created_at, updated_at)",
                  "VALUES",
                  "  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ].join("\n"),
              )
              .run(
                approvalId,
                task.projectId,
                task.workspaceId,
                task.id,
                task.runId ?? runId,
                "pending",
                workflowActor.actorType,
                workflowActor.actorId,
                createdAt,
                createdAt,
                createdAt,
              );
          } else {
            this.database
              .prepare(
                [
                  "UPDATE approvals",
                  "SET",
                  "  status = ?,",
                  "  decision_by_actor_type = NULL,",
                  "  decision_by_actor_id = NULL,",
                  "  decision_summary = NULL,",
                  "  decided_at = NULL,",
                  "  resubmitted_at = ?,",
                  "  updated_at = ?",
                  "WHERE id = ?",
                ].join("\n"),
              )
              .run("resubmitted", createdAt, createdAt, existingApproval.id);
          }

          this.updateTaskForApprovalSubmission(task.id, runId, createdAt);
          this.markRunWaitingApproval(task.runId ?? runId, createdAt);

          return this.insertTimelineMessage({
            projectId: task.projectId,
            workspaceId: task.workspaceId,
            runId: task.runId ?? runId,
            actorType: workflowActor.actorType,
            actorId: workflowActor.actorId,
            content: createTaskOutputMessageContent(task, output),
            createdAt,
          });
        },
      );
      const projectManagerMessage = this.insertTimelineMessage({
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        runId: task.runId ?? runId,
        actorType: "agent",
        actorId: PROJECT_MANAGER_PLANNER_ROLE_KEY,
        content: createTaskApprovalWaitingMessageContent(task),
        createdAt,
      });
      const refreshedTask = this.requireWorkspaceTask(taskId, workspaceId);
      const approval = this.requireTaskApprovalRecord(taskId);

      this.database.exec("COMMIT");
      transactionStarted = false;

      return {
        task: refreshedTask,
        approval,
        outputMessage,
        projectManagerMessage,
      };
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK");
      }

      if (error instanceof TaskClaimValidationError) {
        throw new WorkspaceTimelineValidationError(error.message);
      }

      if (error instanceof TaskClaimNotFoundError) {
        throw new WorkspaceTimelineNotFoundError(error.message);
      }

      if (error instanceof TaskClaimConflictError) {
        throw new WorkspaceTaskClaimConflictError(error);
      }

      throw mapSqliteError(error);
    }
  }

  async decideTaskApproval(
    input: DecideTaskApprovalInput,
  ): Promise<DecideTaskApprovalResult> {
    const workspaceId = normalizeRequiredString(input.workspaceId, "workspaceId");
    const taskId = normalizeRequiredString(input.taskId, "taskId");
    const decidedByActorId = normalizeRequiredString(
      input.decidedByActorId,
      "decidedByActorId",
    );
    const decisionValue = normalizeRequiredString(input.decision, "decision");
    const decisionSummary = normalizeOptionalString(input.decisionSummary) ?? null;

    if (!isTaskApprovalDecisionStatus(decisionValue)) {
      throw new WorkspaceTimelineValidationError(
        `decision must be one of: ${TASK_APPROVAL_DECISION_STATUSES.join(", ")}.`,
      );
    }

    const decision = decisionValue;

    if (
      (decision === "rejected" || decision === "revision_requested") &&
      decisionSummary === null
    ) {
      throw new WorkspaceTimelineValidationError(
        `decisionSummary must be a non-empty string when decision is "${decision}".`,
      );
    }

    let transactionStarted = false;

    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      const task = this.requireWorkspaceTask(taskId, workspaceId);

      if (task.state !== "waiting_approval") {
        throw new WorkspaceTimelineConflictError(
          `Task "${taskId}" cannot be decided from state "${task.state}".`,
        );
      }

      const approval = this.requireTaskApprovalRecord(taskId);

      if (
        approval.status !== "pending" &&
        approval.status !== "resubmitted"
      ) {
        throw new WorkspaceTimelineConflictError(
          `Task "${taskId}" does not have an unresolved approval to decide.`,
        );
      }

      const createdAt = new Date().toISOString();
      const correlationRunId =
        approval.runId ?? task.runId ?? task.checkoutRunId ?? null;
      const auditContext = {
        actorType: "user" as const,
        actorId: decidedByActorId,
        correlationRunId,
      };

      this.databaseHandle.auditContext.runWithContext(auditContext, () => {
        this.database
          .prepare(
            [
              "UPDATE approvals",
              "SET",
              "  status = ?,",
              "  decision_by_actor_type = ?,",
              "  decision_by_actor_id = ?,",
              "  decision_summary = ?,",
              "  decided_at = ?,",
              "  revision_requested_at = ?,",
              "  updated_at = ?",
              "WHERE id = ?",
            ].join("\n"),
          )
          .run(
            decision,
            "user",
            decidedByActorId,
            decisionSummary,
            createdAt,
            decision === "revision_requested"
              ? createdAt
              : approval.revisionRequestedAt,
            createdAt,
            approval.id,
          );
      });

      const transitionService =
        this.createApprovalGuardedTransitionServiceForAuditContext(auditContext);
      const targetTaskState =
        decision === "approved"
          ? "done"
          : decision === "revision_requested"
            ? "in_progress"
            : "blocked";

      await transitionService.transitionTask({
        taskId,
        from: "waiting_approval",
        to: targetTaskState,
      });

      const runStatus = correlationRunId === null
        ? undefined
        : this.getRunStatusRecord(correlationRunId);

      if (runStatus?.status === "waiting_approval") {
        const targetRunStatus = this.resolveRunStatusAfterApprovalDecision(
          runStatus.id,
        );

        try {
          await transitionService.transitionRun({
            runId: runStatus.id,
            from: "waiting_approval",
            to: targetRunStatus,
          });
        } catch (error) {
          if (!(error instanceof ApprovalGuardedTransitionBlockedError)) {
            throw error;
          }
        }
      }

      const decisionMessage = this.insertTimelineMessage({
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        runId: correlationRunId,
        actorType: "user",
        actorId: decidedByActorId,
        content: createTaskApprovalDecisionMessageContent({
          task,
          decision,
          decisionSummary,
          actorId: decidedByActorId,
        }),
        createdAt,
      });
      const projectManagerMessage = this.insertTimelineMessage({
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        runId: correlationRunId,
        actorType: "agent",
        actorId: PROJECT_MANAGER_PLANNER_ROLE_KEY,
        content: createProjectManagerDecisionMessageContent({
          task,
          decision,
        }),
        createdAt,
      });
      const refreshedTask = this.requireWorkspaceTask(taskId, workspaceId);
      const refreshedApproval = this.requireTaskApprovalRecord(taskId);

      this.database.exec("COMMIT");
      transactionStarted = false;

      return {
        task: refreshedTask,
        approval: refreshedApproval,
        decisionMessage,
        projectManagerMessage,
      };
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK");
      }

      if (
        error instanceof ApprovalGuardedTransitionValidationError ||
        error instanceof ApprovalGuardedTransitionBlockedError
      ) {
        throw new WorkspaceTimelineValidationError(error.message);
      }

      if (error instanceof ApprovalGuardedTransitionNotFoundError) {
        throw new WorkspaceTimelineNotFoundError(error.message);
      }

      if (error instanceof ApprovalGuardedTransitionConflictError) {
        throw new WorkspaceTimelineConflictError(error.message);
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

    const agentConfiguration = this.getAgentConfiguration();
    const planner = createProjectManagerPlannerService();
    let plan;

    try {
      plan = planner.planGoal({
        goal,
        roles: agentConfiguration.agentRoles,
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
    const agentRolesByKey = new Map(
      agentConfiguration.agentRoles.map((agentRole) => [agentRole.roleKey, agentRole]),
    );
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
            const assignmentId = randomUUID();
            const assignedRole = agentRolesByKey.get(task.ownerRole);

            if (assignedRole === undefined) {
              throw new WorkspaceTimelineConflictError(
                `task owner role "${task.ownerRole}" does not match a saved specialist role mapping.`,
              );
            }

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

            this.database
              .prepare(
                [
                  "INSERT INTO task_assignments",
                  "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, model_key, role_responsibility, assigned_by_actor_type, assigned_by_actor_id, assigned_at, created_at, updated_at)",
                  "VALUES",
                  "  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ].join("\n"),
              )
              .run(
                assignmentId,
                projectId,
                workspaceId,
                taskId,
                runId,
                assignedRole.roleKey,
                assignedRole.displayName,
                assignedRole.modelKey,
                assignedRole.responsibility,
                "agent",
                plan.projectManagerRoleKey,
                createdAt,
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
              lockOwnerType: null,
              lockOwnerId: null,
              lockAcquiredAt: null,
              checkoutRunId: null,
              executionRunId: null,
              createdAt,
              updatedAt: createdAt,
              completedAt: null,
              assignment: {
                id: assignmentId,
                projectId,
                workspaceId,
                taskId,
                runId,
                roleKey: assignedRole.roleKey,
                roleDisplayName: assignedRole.displayName,
                modelKey: assignedRole.modelKey,
                roleResponsibility: assignedRole.responsibility,
                assignedByActorType: "agent",
                assignedByActorId: plan.projectManagerRoleKey,
                assignedAt: createdAt,
                createdAt,
                updatedAt: createdAt,
              },
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

  private queryWorkspaceTasks(
    workspaceId: string,
    taskId?: string,
  ): WorkspaceTaskRecord[] {
    const rows = this.database
      .prepare(
        [
          "SELECT",
          "  tasks.id,",
          "  tasks.project_id AS projectId,",
          "  tasks.workspace_id AS workspaceId,",
          "  tasks.run_id AS runId,",
          "  tasks.owner_role AS ownerRole,",
          "  task_assignments.role_display_name AS ownerDisplayName,",
          "  tasks.title,",
          "  tasks.description,",
          "  tasks.state,",
          "  tasks.lock_owner_type AS lockOwnerType,",
          "  tasks.lock_owner_id AS lockOwnerId,",
          "  tasks.lock_acquired_at AS lockAcquiredAt,",
          "  tasks.checkout_run_id AS checkoutRunId,",
          "  tasks.execution_run_id AS executionRunId,",
          "  tasks.created_at AS createdAt,",
          "  tasks.updated_at AS updatedAt,",
          "  tasks.completed_at AS completedAt,",
          "  task_assignments.id AS assignmentId,",
          "  task_assignments.run_id AS assignmentRunId,",
          "  task_assignments.role_key AS assignmentRoleKey,",
          "  task_assignments.role_display_name AS assignmentRoleDisplayName,",
          "  task_assignments.model_key AS assignmentModelKey,",
          "  task_assignments.role_responsibility AS assignmentRoleResponsibility,",
          "  task_assignments.assigned_by_actor_type AS assignedByActorType,",
          "  task_assignments.assigned_by_actor_id AS assignedByActorId,",
          "  task_assignments.assigned_at AS assignedAt,",
          "  task_assignments.created_at AS assignmentCreatedAt,",
          "  task_assignments.updated_at AS assignmentUpdatedAt",
          "FROM tasks",
          "LEFT JOIN task_assignments ON task_assignments.task_id = tasks.id",
          "WHERE tasks.workspace_id = ?",
          taskId === undefined ? "" : "  AND tasks.id = ?",
          "ORDER BY tasks.created_at ASC, tasks.rowid ASC",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      )
      .all(
        ...(taskId === undefined ? [workspaceId] : [workspaceId, taskId]),
      ) as WorkspaceTaskRow[];

    return rows.map(mapWorkspaceTaskRow);
  }

  private requireWorkspaceTask(
    taskId: string,
    workspaceId: string,
  ): WorkspaceTaskRecord {
    const [task] = this.queryWorkspaceTasks(workspaceId, taskId);

    if (task !== undefined) {
      return task;
    }

    const existingTask = this.getTaskClaimRecord(taskId);

    if (existingTask === undefined) {
      throw new WorkspaceTimelineNotFoundError(`Task "${taskId}" was not found.`);
    }

    throw new WorkspaceTimelineConflictError(
      `Task "${taskId}" does not belong to workspace ${workspaceId}.`,
    );
  }

  private assertAgentClaimMatchesAssignment(
    task: WorkspaceTaskRecord,
    ownerType: TaskClaimOwnerType,
    ownerId: string,
  ): void {
    if (ownerType !== "agent") {
      return;
    }

    const assignedRoleKey = task.assignment?.roleKey ?? task.ownerRole;

    if (assignedRoleKey !== ownerId) {
      throw new WorkspaceTaskAssignmentConflictError(
        task.id,
        assignedRoleKey,
        ownerId,
      );
    }
  }

  private createTaskClaimServiceForAuditContext(
    auditContext: WorkspaceAuditSqlContext,
  ) {
    return createTaskClaimService({
      getTask: (taskId) => this.getTaskClaimRecord(taskId),
      compareAndSwapTaskClaim: (taskId, expected, next) =>
        this.databaseHandle.auditContext.runWithContext(auditContext, () =>
          this.compareAndSwapTaskClaim(taskId, expected, next),
        ),
    });
  }

  private getTaskClaimRecord(taskId: string): TaskClaimRecord | undefined {
    return this.database
      .prepare(
        [
          "SELECT",
          "  id,",
          "  state,",
          "  lock_owner_type AS lockOwnerType,",
          "  lock_owner_id AS lockOwnerId,",
          "  lock_acquired_at AS lockAcquiredAt,",
          "  checkout_run_id AS checkoutRunId,",
          "  execution_run_id AS executionRunId",
          "FROM tasks",
          "WHERE id = ?",
          "LIMIT 1",
        ].join("\n"),
      )
      .get(taskId) as TaskClaimRecord | undefined;
  }

  private getTaskApprovalRecord(
    taskId: string,
  ): WorkspaceTaskApprovalRecord | undefined {
    const rows = this.database
      .prepare(
        [
          "SELECT",
          "  id,",
          "  project_id AS projectId,",
          "  workspace_id AS workspaceId,",
          "  task_id AS taskId,",
          "  run_id AS runId,",
          "  status,",
          "  requested_by_actor_type AS requestedByActorType,",
          "  requested_by_actor_id AS requestedByActorId,",
          "  decision_by_actor_type AS decisionByActorType,",
          "  decision_by_actor_id AS decisionByActorId,",
          "  decision_summary AS decisionSummary,",
          "  requested_at AS requestedAt,",
          "  decided_at AS decidedAt,",
          "  revision_requested_at AS revisionRequestedAt,",
          "  resubmitted_at AS resubmittedAt,",
          "  created_at AS createdAt,",
          "  updated_at AS updatedAt",
          "FROM approvals",
          "WHERE task_id = ?",
          "ORDER BY created_at DESC, rowid DESC",
          "LIMIT 2",
        ].join("\n"),
      )
      .all(taskId) as WorkspaceTaskApprovalRow[];

    if (rows.length > 1) {
      throw new WorkspaceTimelineConflictError(
        `Task "${taskId}" has multiple approval records; only one active approval record is supported in this slice.`,
      );
    }

    const row = rows[0];
    return row === undefined ? undefined : mapWorkspaceTaskApprovalRow(row);
  }

  private requireTaskApprovalRecord(taskId: string): WorkspaceTaskApprovalRecord {
    const approval = this.getTaskApprovalRecord(taskId);

    if (approval === undefined) {
      throw new WorkspaceTimelineNotFoundError(
        `Task "${taskId}" does not have an approval record.`,
      );
    }

    return approval;
  }

  private getRunStatusRecord(runId: string): WorkspaceRunStatusRow | undefined {
    return this.database
      .prepare(
        [
          "SELECT",
          "  id,",
          "  status",
          "FROM runs",
          "WHERE id = ?",
          "LIMIT 1",
        ].join("\n"),
      )
      .get(runId) as WorkspaceRunStatusRow | undefined;
  }

  private requireRunStatusRecord(runId: string): WorkspaceRunStatusRow {
    const runStatus = this.getRunStatusRecord(runId);

    if (runStatus === undefined) {
      throw new WorkspaceTimelineNotFoundError(`Run "${runId}" was not found.`);
    }

    return runStatus;
  }

  private assertTaskOutputSubmissionAllowed(
    task: WorkspaceTaskRecord,
    input: {
      readonly runId: string;
      readonly ownerType: TaskClaimOwnerType;
      readonly ownerId: string;
    },
  ): void {
    if (task.state !== "in_progress") {
      throw new WorkspaceTimelineConflictError(
        `Task "${task.id}" cannot submit output from state "${task.state}".`,
      );
    }

    if (task.executionRunId !== input.runId) {
      throw new WorkspaceTimelineConflictError(
        `Task "${task.id}" is not actively executing under run "${input.runId}".`,
      );
    }

    if (
      task.lockOwnerType !== input.ownerType ||
      task.lockOwnerId !== input.ownerId
    ) {
      throw new WorkspaceTimelineConflictError(
        `Task "${task.id}" is currently owned by ${task.lockOwnerType ?? "unknown"} "${task.lockOwnerId ?? "unknown"}".`,
      );
    }
  }

  private updateTaskForApprovalSubmission(
    taskId: string,
    runId: string,
    updatedAt: string,
  ): void {
    const result = this.database
      .prepare(
        [
          "UPDATE tasks",
          "SET",
          "  state = ?,",
          "  execution_run_id = NULL,",
          "  updated_at = ?,",
          "  completed_at = NULL",
          "WHERE id = ?",
          "  AND state = ?",
          "  AND execution_run_id = ?",
        ].join("\n"),
      )
      .run("waiting_approval", updatedAt, taskId, "in_progress", runId);

    if (result.changes === 0) {
      throw new WorkspaceTimelineConflictError(
        `Task "${taskId}" changed before its output could be submitted.`,
      );
    }
  }

  private markRunRunningAfterClaim(runId: string): void {
    const current = this.requireRunStatusRecord(runId);

    if (current.status === "running") {
      return;
    }

    if (current.status !== "planned") {
      throw new WorkspaceTimelineConflictError(
        createRunTransitionConflictMessage({
          runId,
          from: current.status,
          to: "running",
        }),
      );
    }

    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare(
        [
          "UPDATE runs",
          "SET",
          "  status = ?,",
          "  started_at = COALESCE(started_at, ?),",
          "  ended_at = NULL,",
          "  updated_at = ?",
          "WHERE id = ?",
          "  AND status = ?",
        ].join("\n"),
      )
      .run("running", updatedAt, updatedAt, runId, "planned");

    if (result.changes === 0) {
      throw new WorkspaceTimelineConflictError(
        `Run "${runId}" changed before it could enter running.`,
      );
    }
  }

  private markRunWaitingApproval(runId: string, updatedAt: string): void {
    const current = this.requireRunStatusRecord(runId);

    if (current.status === "waiting_approval") {
      return;
    }

    if (!canTransitionRunLifecycle(current.status, "waiting_approval")) {
      throw new WorkspaceTimelineConflictError(
        createRunTransitionConflictMessage({
          runId,
          from: current.status,
          to: "waiting_approval",
        }),
      );
    }

    const result = this.database
      .prepare(
        [
          "UPDATE runs",
          "SET",
          "  status = ?,",
          "  started_at = COALESCE(started_at, ?),",
          "  ended_at = NULL,",
          "  updated_at = ?",
          "WHERE id = ?",
          "  AND status = ?",
        ].join("\n"),
      )
      .run("waiting_approval", updatedAt, updatedAt, runId, current.status);

    if (result.changes === 0) {
      throw new WorkspaceTimelineConflictError(
        `Run "${runId}" changed before it could enter waiting_approval.`,
      );
    }
  }

  private resolveRunStatusAfterApprovalDecision(
    runId: string,
  ): WorkspaceRunStatusRow["status"] {
    const row = this.database
      .prepare(
        [
          "SELECT",
          "  COALESCE(SUM(CASE WHEN state IN ('blocked', 'failed') THEN 1 ELSE 0 END), 0) AS blockedOrFailedCount,",
          "  COALESCE(SUM(CASE WHEN state <> 'done' THEN 1 ELSE 0 END), 0) AS notDoneCount",
          "FROM tasks",
          "WHERE run_id = ?",
        ].join("\n"),
      )
      .get(runId) as {
      blockedOrFailedCount: number;
      notDoneCount: number;
    };

    if (row.blockedOrFailedCount > 0) {
      return "failed";
    }

    if (row.notDoneCount === 0) {
      return "done";
    }

    return "running";
  }

  private insertTimelineMessage(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly actorType: WorkspaceMessageActorType;
    readonly actorId: string | null;
    readonly content: string;
    readonly createdAt: string;
  }): WorkspaceTimelineMessage {
    const id = randomUUID();

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
        id,
        input.projectId,
        input.workspaceId,
        input.runId,
        input.actorType,
        input.actorId,
        input.content,
        input.createdAt,
      );

    return {
      id,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      actorType: input.actorType,
      actorId: input.actorId,
      content: input.content,
      createdAt: input.createdAt,
    };
  }

  private createApprovalGuardedTransitionServiceForAuditContext(
    auditContext: WorkspaceAuditSqlContext,
  ) {
    return createApprovalGuardedTransitionService({
      getTask: (taskId) =>
        this.database
          .prepare(
            [
              "SELECT",
              "  id,",
              "  state",
              "FROM tasks",
              "WHERE id = ?",
              "LIMIT 1",
            ].join("\n"),
          )
          .get(taskId) as { id: string; state: WorkspaceTaskRecord["state"] } | undefined,
      getRun: (runId) =>
        this.database
          .prepare(
            [
              "SELECT",
              "  id,",
              "  status",
              "FROM runs",
              "WHERE id = ?",
              "LIMIT 1",
            ].join("\n"),
          )
          .get(runId) as { id: string; status: WorkspaceRunStatusRow["status"] } | undefined,
      listTaskApprovals: (taskId) =>
        this.database
          .prepare(
            [
              "SELECT",
              "  id,",
              "  status,",
              "  task_id AS taskId,",
              "  run_id AS runId",
              "FROM approvals",
              "WHERE task_id = ?",
            ].join("\n"),
          )
          .all(taskId) as Array<{
            id: string;
            status: WorkspaceTaskApprovalStatus;
            taskId: string | null;
            runId: string | null;
          }>,
      listRunApprovals: (runId) =>
        this.database
          .prepare(
            [
              "SELECT",
              "  id,",
              "  status,",
              "  task_id AS taskId,",
              "  run_id AS runId",
              "FROM approvals",
              "WHERE run_id = ?",
            ].join("\n"),
          )
          .all(runId) as Array<{
            id: string;
            status: WorkspaceTaskApprovalStatus;
            taskId: string | null;
            runId: string | null;
          }>,
      compareAndSwapTaskState: (taskId, expected, next) =>
        this.databaseHandle.auditContext.runWithContext(auditContext, () =>
          this.compareAndSwapApprovalGuardedTaskState(taskId, expected, next),
        ),
      compareAndSwapRunStatus: (runId, expected, next) =>
        this.databaseHandle.auditContext.runWithContext(auditContext, () =>
          this.compareAndSwapApprovalGuardedRunStatus(runId, expected, next),
        ),
    });
  }

  private compareAndSwapApprovalGuardedTaskState(
    taskId: string,
    expected: WorkspaceTaskRecord["state"],
    next: WorkspaceTaskRecord["state"],
  ): boolean {
    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare(
        [
          "UPDATE tasks",
          "SET",
          "  state = ?,",
          "  updated_at = ?,",
          "  completed_at = ?",
          "WHERE id = ?",
          "  AND state = ?",
        ].join("\n"),
      )
      .run(
        next,
        updatedAt,
        next === "done" ? updatedAt : null,
        taskId,
        expected,
      );

    return result.changes > 0;
  }

  private compareAndSwapApprovalGuardedRunStatus(
    runId: string,
    expected: WorkspaceRunStatusRow["status"],
    next: WorkspaceRunStatusRow["status"],
  ): boolean {
    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare(
        [
          "UPDATE runs",
          "SET",
          "  status = ?,",
          "  started_at = CASE",
          "    WHEN ? = 'running' THEN COALESCE(started_at, ?)",
          "    ELSE started_at",
          "  END,",
          "  ended_at = CASE",
          "    WHEN ? IN ('done', 'failed') THEN ?",
          "    ELSE NULL",
          "  END,",
          "  updated_at = ?",
          "WHERE id = ?",
          "  AND status = ?",
        ].join("\n"),
      )
      .run(next, next, updatedAt, next, updatedAt, updatedAt, runId, expected);

    return result.changes > 0;
  }

  private compareAndSwapTaskClaim(
    taskId: string,
    expected: TaskClaimSnapshot,
    next: TaskClaimSnapshot,
  ): boolean {
    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare(
        [
          "UPDATE tasks",
          "SET",
          "  state = ?,",
          "  lock_owner_type = ?,",
          "  lock_owner_id = ?,",
          "  lock_acquired_at = ?,",
          "  checkout_run_id = ?,",
          "  execution_run_id = ?,",
          "  updated_at = ?",
          "WHERE id = ?",
          "  AND state IS ?",
          "  AND lock_owner_type IS ?",
          "  AND lock_owner_id IS ?",
          "  AND lock_acquired_at IS ?",
          "  AND checkout_run_id IS ?",
          "  AND execution_run_id IS ?",
        ].join("\n"),
      )
      .run(
        next.state,
        next.lockOwnerType,
        next.lockOwnerId,
        next.lockAcquiredAt,
        next.checkoutRunId,
        next.executionRunId,
        updatedAt,
        taskId,
        expected.state,
        expected.lockOwnerType,
        expected.lockOwnerId,
        expected.lockAcquiredAt,
        expected.checkoutRunId,
        expected.executionRunId,
      );

    return result.changes > 0;
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
