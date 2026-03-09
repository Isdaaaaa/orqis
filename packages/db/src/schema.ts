import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const ACTOR_TYPES = ["user", "agent", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const RUN_STATUSES = [
  "planned",
  "running",
  "waiting_approval",
  "done",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_STATES = [
  "todo",
  "in_progress",
  "waiting_approval",
  "done",
  "failed",
  "blocked",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_LOCK_OWNER_TYPES = ["run", "agent", "user"] as const;
export type TaskLockOwnerType = (typeof TASK_LOCK_OWNER_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "revision_requested",
  "resubmitted",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("projects_slug_unique").on(table.slug),
    index("projects_created_at_idx").on(table.createdAt),
  ],
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("workspaces_project_id_unique").on(table.projectId),
    index("workspaces_created_at_idx").on(table.createdAt),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("planned"),
    summary: text("summary"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "runs_status_check",
      sql`${table.status} in ('planned', 'running', 'waiting_approval', 'done', 'failed')`,
    ),
    index("runs_workspace_created_at_idx").on(table.workspaceId, table.createdAt),
    index("runs_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    parentMessageId: text("parent_message_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "messages_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'system')`,
    ),
    foreignKey({
      columns: [table.parentMessageId],
      foreignColumns: [table.id],
      name: "messages_parent_message_id_messages_id_fk",
    }).onDelete("set null"),
    index("messages_workspace_created_at_idx").on(table.workspaceId, table.createdAt),
    index("messages_run_created_at_idx").on(table.runId, table.createdAt),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    parentTaskId: text("parent_task_id"),
    title: text("title").notNull(),
    description: text("description"),
    state: text("state").notNull().default("todo"),
    ownerRole: text("owner_role"),
    lockOwnerType: text("lock_owner_type"),
    lockOwnerId: text("lock_owner_id"),
    lockAcquiredAt: text("lock_acquired_at"),
    checkoutRunId: text("checkout_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    executionRunId: text("execution_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    check(
      "tasks_state_check",
      sql`${table.state} in ('todo', 'in_progress', 'waiting_approval', 'done', 'failed', 'blocked')`,
    ),
    check(
      "tasks_lock_owner_type_check",
      sql`${table.lockOwnerType} is null or ${table.lockOwnerType} in ('run', 'agent', 'user')`,
    ),
    foreignKey({
      columns: [table.parentTaskId],
      foreignColumns: [table.id],
      name: "tasks_parent_task_id_tasks_id_fk",
    }).onDelete("set null"),
    index("tasks_workspace_state_updated_at_idx").on(
      table.workspaceId,
      table.state,
      table.updatedAt,
    ),
    index("tasks_parent_task_id_idx").on(table.parentTaskId),
    index("tasks_run_updated_at_idx").on(table.runId, table.updatedAt),
    index("tasks_checkout_run_id_idx").on(table.checkoutRunId),
    index("tasks_execution_run_id_idx").on(table.executionRunId),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    requestedByActorType: text("requested_by_actor_type").notNull(),
    requestedByActorId: text("requested_by_actor_id"),
    decisionByActorType: text("decision_by_actor_type"),
    decisionByActorId: text("decision_by_actor_id"),
    decisionSummary: text("decision_summary"),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text("decided_at"),
    revisionRequestedAt: text("revision_requested_at"),
    resubmittedAt: text("resubmitted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "approvals_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'revision_requested', 'resubmitted')`,
    ),
    check(
      "approvals_requested_by_actor_type_check",
      sql`${table.requestedByActorType} in ('user', 'agent', 'system')`,
    ),
    check(
      "approvals_decision_by_actor_type_check",
      sql`${table.decisionByActorType} is null or ${table.decisionByActorType} in ('user', 'agent', 'system')`,
    ),
    index("approvals_task_created_at_idx").on(table.taskId, table.createdAt),
    index("approvals_status_created_at_idx").on(table.status, table.createdAt),
    index("approvals_run_created_at_idx").on(table.runId, table.createdAt),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    approvalId: text("approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    detailsJson: text("details_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "audit_events_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'system')`,
    ),
    index("audit_events_workspace_created_at_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("audit_events_entity_created_at_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index("audit_events_run_created_at_idx").on(table.runId, table.createdAt),
    index("audit_events_actor_created_at_idx").on(
      table.actorType,
      table.actorId,
      table.createdAt,
    ),
  ],
);

export type Project = typeof projects.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
