import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_STATUSES,
  DB_MIGRATION_FILES,
  ORQIS_AUDIT_SQL_FUNCTION_NAMES,
  RUN_STATUSES,
  TASK_STATES,
  createOrqisAuditSqlContextController,
  registerOrqisAuditSqlFunctions,
  resolveDbMigrationsDir,
} from "../src/index.ts";

type SqlJsQueryResult = {
  columns: string[];
  values: unknown[][];
};

type SqliteDatabase = {
  close: () => void;
  create_function: (name: string, fn: () => unknown) => unknown;
  exec: (sql: string) => SqlJsQueryResult[];
  run: (sql: string, params?: unknown[]) => unknown;
};

type PersistedAuditEvent = {
  actorType: string;
  actorId: string | null;
  runId: string | null;
  taskId: string | null;
  approvalId: string | null;
  entityType: string;
  entityId: string;
  action: string;
};

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | undefined;

function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }

  return sqlJsPromise;
}

function loadMigrationSql(): string {
  const migrationsDir = resolveDbMigrationsDir();

  return DB_MIGRATION_FILES.map((fileName) =>
    readFileSync(join(migrationsDir, fileName), "utf8"),
  ).join("\n");
}

async function createDatabase(): Promise<{
  auditContext: ReturnType<typeof createOrqisAuditSqlContextController>;
  db: SqliteDatabase;
}> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const auditContext = createOrqisAuditSqlContextController();
  const typedDb = db as unknown as SqliteDatabase;
  registerOrqisAuditSqlFunctions(typedDb, () => auditContext.getCurrentContext());
  db.run(loadMigrationSql());
  return {
    auditContext,
    db: typedDb,
  };
}

async function withDatabase(
  run: (
    db: SqliteDatabase,
    auditContext: ReturnType<typeof createOrqisAuditSqlContextController>,
  ) => void | Promise<void>,
): Promise<void> {
  const { db, auditContext } = await createDatabase();

  try {
    await run(db, auditContext);
  } finally {
    db.close();
  }
}

function extractTableSql(migrationSql: string, tableName: string): string {
  const tableRegex = new RegExp(
    "CREATE TABLE `" + tableName + "` \\([\\s\\S]*?\\n\\);",
  );
  const match = migrationSql.match(tableRegex);

  if (!match) {
    throw new Error(`Missing table definition for ${tableName}`);
  }

  return match[0];
}

function queryRows(db: SqliteDatabase, sql: string): Record<string, unknown>[] {
  const [result] = db.exec(sql);

  if (!result) {
    return [];
  }

  return result.values.map((values) =>
    Object.fromEntries(
      result.columns.map((column, index) => [column, values[index]]),
    ),
  );
}

function readAuditEvents(db: SqliteDatabase): PersistedAuditEvent[] {
  return queryRows(
    db,
    [
      "SELECT",
      "  actor_type AS actorType,",
      "  actor_id AS actorId,",
      "  run_id AS runId,",
      "  task_id AS taskId,",
      "  approval_id AS approvalId,",
      "  entity_type AS entityType,",
      "  entity_id AS entityId,",
      "  action",
      "FROM audit_events",
      "ORDER BY rowid ASC",
    ].join("\n"),
  ) as PersistedAuditEvent[];
}

describe("@orqis/db migration SQL", () => {
  const migrationSql = loadMigrationSql();

  it("declares required project/workspace workflow tables", () => {
    const requiredTables = [
      "projects",
      "workspaces",
      "provider_configs",
      "model_configs",
      "agent_profiles",
      "messages",
      "tasks",
      "task_assignments",
      "approvals",
      "runs",
      "audit_events",
    ];

    for (const tableName of requiredTables) {
      expect(migrationSql).toContain(`CREATE TABLE \`${tableName}\``);
    }
  });

  it("defines provider, model, and agent-profile configuration tables with relational links", async () => {
    const providerConfigsTableSql = extractTableSql(
      migrationSql,
      "provider_configs",
    );
    const modelConfigsTableSql = extractTableSql(migrationSql, "model_configs");
    const agentProfilesTableSql = extractTableSql(migrationSql, "agent_profiles");

    expect(providerConfigsTableSql).toContain("`provider_key` text PRIMARY KEY NOT NULL");
    expect(providerConfigsTableSql).toContain("`display_name` text NOT NULL");
    expect(providerConfigsTableSql).toContain("`base_url` text");
    expect(migrationSql).toContain("CREATE INDEX `provider_configs_created_at_idx`");

    expect(modelConfigsTableSql).toContain("`model_key` text PRIMARY KEY NOT NULL");
    expect(modelConfigsTableSql).toContain("`provider_key` text NOT NULL");
    expect(modelConfigsTableSql).toContain(
      "FOREIGN KEY (`provider_key`) REFERENCES `provider_configs` (`provider_key`)",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `model_configs_provider_key_created_at_idx`",
    );

    expect(agentProfilesTableSql).toContain("`role_key` text PRIMARY KEY NOT NULL");
    expect(agentProfilesTableSql).toContain("`display_name` text NOT NULL");
    expect(agentProfilesTableSql).toContain("`model_key` text NOT NULL");
    expect(agentProfilesTableSql).toContain("`responsibility` text NOT NULL");
    expect(agentProfilesTableSql).toContain(
      "FOREIGN KEY (`model_key`) REFERENCES `model_configs` (`model_key`)",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `agent_profiles_model_key_created_at_idx`",
    );

    await withDatabase((db) => {
      db.run(
        "INSERT INTO provider_configs (provider_key, display_name, base_url) VALUES (?, ?, ?)",
        ["openai", "OpenAI", "https://api.openai.com/v1"],
      );
      db.run(
        "INSERT INTO model_configs (model_key, provider_key, display_name) VALUES (?, ?, ?)",
        ["gpt-5", "openai", "GPT-5"],
      );
      db.run(
        "INSERT INTO agent_profiles (role_key, display_name, model_key, responsibility) VALUES (?, ?, ?, ?)",
        [
          "project_manager",
          "Project Manager",
          "gpt-5",
          "Plans work and manages approvals",
        ],
      );

      expect(() =>
        db.run(
          "INSERT INTO model_configs (model_key, provider_key, display_name) VALUES (?, ?, ?)",
          ["claude-sonnet-4", "missing", "Claude Sonnet 4"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(() =>
        db.run(
          "INSERT INTO agent_profiles (role_key, display_name, model_key, responsibility) VALUES (?, ?, ?, ?)",
          ["reviewer", "Reviewer", "missing-model", "Reviews changes"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it("uses connection-local SQL functions for audit actor and run correlation metadata", () => {
    expect(migrationSql).not.toContain("CREATE TABLE `audit_context`");
    expect(migrationSql).toContain(
      `${ORQIS_AUDIT_SQL_FUNCTION_NAMES.actorType}()`,
    );
    expect(migrationSql).toContain(
      `${ORQIS_AUDIT_SQL_FUNCTION_NAMES.actorId}()`,
    );
    expect(migrationSql).toContain(
      `${ORQIS_AUDIT_SQL_FUNCTION_NAMES.correlationRunId}()`,
    );
  });

  it("defines run lifecycle states and timeline indexes", () => {
    const runsTableSql = extractTableSql(migrationSql, "runs");

    for (const status of RUN_STATUSES) {
      expect(runsTableSql).toContain(`'${status}'`);
    }

    expect(runsTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`)",
    );
    expect(migrationSql).toContain("CREATE INDEX `runs_workspace_created_at_idx`");
    expect(migrationSql).toContain("CREATE INDEX `runs_status_created_at_idx`");
  });

  it("captures task state, lock ownership metadata, and parent-task lineage", () => {
    const tasksTableSql = extractTableSql(migrationSql, "tasks");

    expect(tasksTableSql).toContain("`state` text NOT NULL");
    expect(tasksTableSql).toContain("`parent_task_id` text");
    expect(tasksTableSql).toContain("`lock_owner_type` text");
    expect(tasksTableSql).toContain("`lock_owner_id` text");
    expect(tasksTableSql).toContain("`checkout_run_id` text");
    expect(tasksTableSql).toContain("`execution_run_id` text");
    expect(tasksTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`)",
    );
    expect(tasksTableSql).toContain(
      "FOREIGN KEY (`parent_task_id`) REFERENCES `tasks` (`id`)",
    );
    expect(tasksTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`, `parent_task_id`) REFERENCES `tasks` (`project_id`, `workspace_id`, `id`)",
    );
    expect(tasksTableSql).toContain(
      "FOREIGN KEY (`checkout_run_id`) REFERENCES `runs` (`id`)",
    );
    expect(tasksTableSql).toContain(
      "FOREIGN KEY (`execution_run_id`) REFERENCES `runs` (`id`)",
    );

    for (const state of TASK_STATES) {
      expect(tasksTableSql).toContain(`'${state}'`);
    }

    expect(migrationSql).toContain(
      "CREATE INDEX `tasks_workspace_state_updated_at_idx`",
    );
    expect(migrationSql).toContain("CREATE INDEX `tasks_parent_task_id_idx`");
    expect(migrationSql).toContain("CREATE INDEX `tasks_checkout_run_id_idx`");
    expect(migrationSql).toContain("CREATE INDEX `tasks_execution_run_id_idx`");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX `tasks_project_id_workspace_id_id_unique`",
    );
  });

  it("captures first-class task assignment records with role snapshots", () => {
    const taskAssignmentsTableSql = extractTableSql(
      migrationSql,
      "task_assignments",
    );

    expect(taskAssignmentsTableSql).toContain("`task_id` text NOT NULL");
    expect(taskAssignmentsTableSql).toContain("`run_id` text");
    expect(taskAssignmentsTableSql).toContain("`role_key` text NOT NULL");
    expect(taskAssignmentsTableSql).toContain(
      "`role_display_name` text NOT NULL",
    );
    expect(taskAssignmentsTableSql).toContain("`model_key` text");
    expect(taskAssignmentsTableSql).toContain(
      "`role_responsibility` text NOT NULL",
    );
    expect(taskAssignmentsTableSql).toContain(
      "`assigned_by_actor_type` text NOT NULL",
    );
    expect(taskAssignmentsTableSql).toContain("`assigned_at` text NOT NULL");
    expect(taskAssignmentsTableSql).toContain(
      "FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`)",
    );
    expect(taskAssignmentsTableSql).toContain(
      "FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`)",
    );
    expect(taskAssignmentsTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`, `task_id`) REFERENCES `tasks` (`project_id`, `workspace_id`, `id`)",
    );
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX `task_assignments_task_id_unique`",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `task_assignments_workspace_role_assigned_at_idx`",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `task_assignments_run_assigned_at_idx`",
    );
  });

  it("scopes parent lineage references to the same project/workspace", () => {
    const messagesTableSql = extractTableSql(migrationSql, "messages");

    expect(messagesTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`, `parent_message_id`) REFERENCES `messages` (`project_id`, `workspace_id`, `id`)",
    );
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX `messages_project_id_workspace_id_id_unique`",
    );
  });

  it("persists approval lifecycle states and decision metadata", () => {
    const approvalsTableSql = extractTableSql(migrationSql, "approvals");

    expect(approvalsTableSql).toContain("`status` text NOT NULL");
    expect(approvalsTableSql).toContain("`decision_by_actor_type` text");
    expect(approvalsTableSql).toContain("`decision_by_actor_id` text");
    expect(approvalsTableSql).toContain("`decision_summary` text");
    expect(approvalsTableSql).toContain("`decided_at` text");
    expect(approvalsTableSql).toContain("`revision_requested_at` text");
    expect(approvalsTableSql).toContain("`resubmitted_at` text");
    expect(approvalsTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`)",
    );

    for (const status of APPROVAL_STATUSES) {
      expect(approvalsTableSql).toContain(`'${status}'`);
    }

    expect(migrationSql).toContain("CREATE INDEX `approvals_task_created_at_idx`");
    expect(migrationSql).toContain(
      "CREATE INDEX `approvals_status_created_at_idx`",
    );
    expect(migrationSql).toContain("CREATE INDEX `approvals_run_created_at_idx`");
  });

  it("adds validation triggers for same-project/workspace linked run/task refs", () => {
    const expectedTriggers = [
      "messages_same_workspace_run_id_insert",
      "messages_same_workspace_run_id_update",
      "tasks_same_workspace_run_refs_insert",
      "tasks_same_workspace_run_refs_update",
      "task_assignments_same_workspace_refs_insert",
      "task_assignments_same_workspace_refs_update",
      "approvals_same_workspace_refs_insert",
      "approvals_same_workspace_refs_update",
      "runs_workspace_ownership_update_guard",
      "tasks_workspace_ownership_update_guard",
    ];

    for (const triggerName of expectedTriggers) {
      expect(migrationSql).toContain(`CREATE TRIGGER \`${triggerName}\``);
    }
  });

  it("makes audit events append-only and keeps project/workspace correlation", () => {
    const auditEventsTableSql = extractTableSql(migrationSql, "audit_events");

    expect(auditEventsTableSql).toContain("`actor_type` text NOT NULL");
    expect(auditEventsTableSql).toContain("`actor_id` text");
    expect(auditEventsTableSql).toContain("`entity_type` text NOT NULL");
    expect(auditEventsTableSql).toContain("`entity_id` text NOT NULL");
    expect(auditEventsTableSql).toContain("`run_id` text");
    expect(auditEventsTableSql).toContain("`task_id` text");
    expect(auditEventsTableSql).toContain("`approval_id` text");
    expect(auditEventsTableSql).toContain(
      "FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`)",
    );
    expect(auditEventsTableSql).not.toContain(
      "FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`)",
    );
    expect(auditEventsTableSql).not.toContain(
      "FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`)",
    );
    expect(auditEventsTableSql).not.toContain(
      "FOREIGN KEY (`approval_id`) REFERENCES `approvals` (`id`)",
    );

    expect(migrationSql).toContain(
      "CREATE INDEX `audit_events_workspace_created_at_idx`",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `audit_events_entity_created_at_idx`",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `audit_events_run_created_at_idx`",
    );
    expect(migrationSql).toContain(
      "CREATE INDEX `audit_events_actor_created_at_idx`",
    );

    expect(migrationSql).toContain("CREATE TRIGGER `audit_events_no_update`");
    expect(migrationSql).toContain("CREATE TRIGGER `audit_events_no_delete`");
    expect(migrationSql).toContain(
      "SELECT RAISE(ABORT, 'audit_events is append-only');",
    );
  });

  it("adds audit-emission triggers for run/task/approval inserts and updates", () => {
    const expectedTriggers = [
      "runs_audit_insert",
      "runs_audit_update",
      "tasks_audit_insert",
      "tasks_audit_update",
      "task_assignments_audit_insert",
      "task_assignments_audit_update",
      "approvals_audit_insert",
      "approvals_audit_update",
    ];

    for (const triggerName of expectedTriggers) {
      expect(migrationSql).toContain(`CREATE TRIGGER \`${triggerName}\``);
    }

    expect(migrationSql).toContain("'run.created'");
    expect(migrationSql).toContain("'run.updated'");
    expect(migrationSql).toContain("'task.created'");
    expect(migrationSql).toContain("'task.updated'");
    expect(migrationSql).toContain("'task_assignment.created'");
    expect(migrationSql).toContain("'task_assignment.updated'");
    expect(migrationSql).toContain("'approval.created'");
    expect(migrationSql).toContain("'approval.updated'");
  });

  it("emits audit events for run, task, and approval inserts and updates with actor and run correlation metadata", async () => {
    await withDatabase((db, auditContext) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);

      auditContext.runWithContext(
        {
          actorType: "system",
          actorId: "bootstrap",
          correlationRunId: null,
        },
        () => {
          db.run(
            "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
            ["run_1", "p1", "w1", "planned"],
          );
        },
      );

      auditContext.runWithContext(
        {
          actorType: "agent",
          actorId: "pm",
          correlationRunId: "run_1",
        },
        () => {
          db.run(
            "UPDATE runs SET status = ?, started_at = ?, updated_at = ? WHERE id = ?",
            [
              "running",
              "2026-03-11T09:00:00.000Z",
              "2026-03-11T09:00:00.000Z",
              "run_1",
            ],
          );
          db.run(
            "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
            ["task_1", "p1", "w1", "Audit me", "todo"],
          );
          db.run(
            [
              "INSERT INTO task_assignments",
              "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, model_key, role_responsibility, assigned_by_actor_type, assigned_by_actor_id)",
              "VALUES",
              "  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ].join("\n"),
            [
              "assignment_1",
              "p1",
              "w1",
              "task_1",
              "run_1",
              "backend_agent",
              "Backend Agent",
              "gpt-5",
              "Owns runtime changes",
              "agent",
              "pm",
            ],
          );
        },
      );

      auditContext.runWithContext(
        {
          actorType: "agent",
          actorId: "backend_agent",
          correlationRunId: "run_1",
        },
        () => {
          db.run(
            "UPDATE tasks SET state = ?, lock_owner_type = ?, lock_owner_id = ?, checkout_run_id = ?, execution_run_id = ?, updated_at = ? WHERE id = ?",
            [
              "in_progress",
              "agent",
              "backend_agent",
              "run_1",
              "run_1",
              "2026-03-11T09:05:00.000Z",
              "task_1",
            ],
          );
        },
      );

      auditContext.runWithContext(
        {
          actorType: "agent",
          actorId: "pm",
          correlationRunId: "run_1",
        },
        () => {
          db.run(
            "UPDATE task_assignments SET role_display_name = ?, updated_at = ? WHERE id = ?",
            [
              "Backend Specialist",
              "2026-03-11T09:06:00.000Z",
              "assignment_1",
            ],
          );
        },
      );

      auditContext.runWithContext(
        {
          actorType: "agent",
          actorId: "pm",
          correlationRunId: "run_1",
        },
        () => {
          db.run(
            "INSERT INTO approvals (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type, requested_by_actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              "approval_1",
              "p1",
              "w1",
              "task_1",
              "run_1",
              "pending",
              "agent",
              "pm",
            ],
          );
        },
      );

      auditContext.runWithContext(
        {
          actorType: "user",
          actorId: "owner",
          correlationRunId: "run_1",
        },
        () => {
          db.run(
            "UPDATE approvals SET status = ?, decision_by_actor_type = ?, decision_by_actor_id = ?, decided_at = ?, updated_at = ? WHERE id = ?",
            [
              "approved",
              "user",
              "owner",
              "2026-03-11T09:10:00.000Z",
              "2026-03-11T09:10:00.000Z",
              "approval_1",
            ],
          );
        },
      );

      expect(readAuditEvents(db)).toEqual([
        {
          actorType: "system",
          actorId: "bootstrap",
          runId: "run_1",
          taskId: null,
          approvalId: null,
          entityType: "run",
          entityId: "run_1",
          action: "run.created",
        },
        {
          actorType: "agent",
          actorId: "pm",
          runId: "run_1",
          taskId: null,
          approvalId: null,
          entityType: "run",
          entityId: "run_1",
          action: "run.updated",
        },
        {
          actorType: "agent",
          actorId: "pm",
          runId: "run_1",
          taskId: "task_1",
          approvalId: null,
          entityType: "task",
          entityId: "task_1",
          action: "task.created",
        },
        {
          actorType: "agent",
          actorId: "pm",
          runId: "run_1",
          taskId: "task_1",
          approvalId: null,
          entityType: "task_assignment",
          entityId: "assignment_1",
          action: "task_assignment.created",
        },
        {
          actorType: "agent",
          actorId: "backend_agent",
          runId: "run_1",
          taskId: "task_1",
          approvalId: null,
          entityType: "task",
          entityId: "task_1",
          action: "task.updated",
        },
        {
          actorType: "agent",
          actorId: "pm",
          runId: "run_1",
          taskId: "task_1",
          approvalId: null,
          entityType: "task_assignment",
          entityId: "assignment_1",
          action: "task_assignment.updated",
        },
        {
          actorType: "agent",
          actorId: "pm",
          runId: "run_1",
          taskId: "task_1",
          approvalId: "approval_1",
          entityType: "approval",
          entityId: "approval_1",
          action: "approval.created",
        },
        {
          actorType: "user",
          actorId: "owner",
          runId: "run_1",
          taskId: "task_1",
          approvalId: "approval_1",
          entityType: "approval",
          entityId: "approval_1",
          action: "approval.updated",
        },
      ]);
    });
  });

  it("does not leak audit context between unrelated mutations on the same connection", async () => {
    await withDatabase((db, auditContext) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);

      auditContext.runWithContext(
        {
          actorType: "agent",
          actorId: "alice",
          correlationRunId: "run_1",
        },
        () => {
          db.run(
            "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
            ["run_1", "p1", "w1", "planned"],
          );
        },
      );

      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["task_1", "p1", "w1", "Task without fresh context", "todo"],
      );

      expect(readAuditEvents(db)).toEqual([
        {
          actorType: "agent",
          actorId: "alice",
          runId: "run_1",
          taskId: null,
          approvalId: null,
          entityType: "run",
          entityId: "run_1",
          action: "run.created",
        },
        {
          actorType: "system",
          actorId: null,
          runId: null,
          taskId: "task_1",
          approvalId: null,
          entityType: "task",
          entityId: "task_1",
          action: "task.created",
        },
      ]);
    });
  });

  it("rejects cross-project workspace mismatches across workflow tables", async () => {
    await withDatabase((db) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p2",
        "project-2",
        "Project 2",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["t1", "p1", "w1", "Task 1", "todo"],
      );

      expect(() =>
        db.run(
          "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
          ["r_bad", "p2", "w1", "planned"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(() =>
        db.run(
          "INSERT INTO messages (id, project_id, workspace_id, actor_type, content) VALUES (?, ?, ?, ?, ?)",
          ["m_bad", "p2", "w1", "user", "message"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(() =>
        db.run(
          "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
          ["t_bad", "p2", "w1", "Task bad", "todo"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(() =>
        db.run(
          "INSERT INTO approvals (id, project_id, workspace_id, task_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?)",
          ["a_bad", "p2", "w1", "t1", "pending", "user"],
        ),
      ).toThrow(
        /approvals\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          [
            "INSERT INTO task_assignments",
            "  (id, project_id, workspace_id, task_id, role_key, role_display_name, role_responsibility, assigned_by_actor_type)",
            "VALUES",
            "  (?, ?, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
          [
            "ta_bad",
            "p2",
            "w1",
            "t1",
            "backend_agent",
            "Backend Agent",
            "Owns runtime changes",
            "agent",
          ],
        ),
      ).toThrow(
        /task_assignments\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "INSERT INTO audit_events (id, project_id, workspace_id, actor_type, entity_type, entity_id, action) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ["e_bad", "p2", "w1", "user", "task", "t1", "created"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it("rejects linked run/task refs that point outside the row project/workspace", async () => {
    await withDatabase((db) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p2",
        "project-2",
        "Project 2",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w2",
        "p2",
        "Workspace 2",
      ]);
      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r1", "p1", "w1", "planned"],
      );
      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r2", "p2", "w2", "planned"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t1", "p1", "w1", "r1", "Task 1", "todo"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t2", "p2", "w2", "r2", "Task 2", "todo"],
      );

      expect(() =>
        db.run(
          "INSERT INTO messages (id, project_id, workspace_id, run_id, actor_type, content) VALUES (?, ?, ?, ?, ?, ?)",
          ["m_cross_run", "p2", "w2", "r1", "user", "message"],
        ),
      ).toThrow(
        /messages\.run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
          ["t_cross_run", "p2", "w2", "r1", "Task cross run", "todo"],
        ),
      ).toThrow(
        /tasks\.run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "INSERT INTO tasks (id, project_id, workspace_id, title, state, checkout_run_id) VALUES (?, ?, ?, ?, ?, ?)",
          ["t_cross_checkout", "p2", "w2", "Task checkout", "todo", "r1"],
        ),
      ).toThrow(
        /tasks\.checkout_run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "INSERT INTO tasks (id, project_id, workspace_id, title, state, execution_run_id) VALUES (?, ?, ?, ?, ?, ?)",
          ["t_cross_execution", "p2", "w2", "Task execution", "todo", "r1"],
        ),
      ).toThrow(
        /tasks\.execution_run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "INSERT INTO approvals (id, project_id, workspace_id, task_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?)",
          ["a_cross_task", "p2", "w2", "t1", "pending", "user"],
        ),
      ).toThrow(
        /approvals\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "INSERT INTO approvals (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ["a_cross_run", "p2", "w2", "t2", "r1", "pending", "user"],
        ),
      ).toThrow(
        /approvals\.run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          [
            "INSERT INTO task_assignments",
            "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, role_responsibility, assigned_by_actor_type)",
            "VALUES",
            "  (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
          [
            "ta_cross_task",
            "p2",
            "w2",
            "t1",
            "r2",
            "backend_agent",
            "Backend Agent",
            "Owns runtime changes",
            "agent",
          ],
        ),
      ).toThrow(
        /task_assignments\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          [
            "INSERT INTO task_assignments",
            "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, role_responsibility, assigned_by_actor_type)",
            "VALUES",
            "  (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ].join("\n"),
          [
            "ta_cross_run",
            "p2",
            "w2",
            "t2",
            "r1",
            "backend_agent",
            "Backend Agent",
            "Owns runtime changes",
            "agent",
          ],
        ),
      ).toThrow(
        /task_assignments\.run_id must reference a run in the same project\/workspace/,
      );
    });
  });

  it("rejects linked run/task refs on updates when existing rows cross project/workspace boundaries", async () => {
    await withDatabase((db) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p2",
        "project-2",
        "Project 2",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w2",
        "p2",
        "Workspace 2",
      ]);
      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r1", "p1", "w1", "planned"],
      );
      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r2", "p2", "w2", "planned"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["t1", "p1", "w1", "Task 1", "todo"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["t2", "p2", "w2", "Task 2", "todo"],
      );
      db.run(
        "INSERT INTO messages (id, project_id, workspace_id, run_id, actor_type, content) VALUES (?, ?, ?, ?, ?, ?)",
        ["m_update_run", "p1", "w1", "r1", "user", "message"],
      );
      db.run(
        "INSERT INTO messages (id, project_id, workspace_id, run_id, actor_type, content) VALUES (?, ?, ?, ?, ?, ?)",
        ["m_update_owner", "p1", "w1", "r1", "user", "message"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t_update_run", "p1", "w1", "r1", "Task run", "todo"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, checkout_run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t_update_checkout", "p1", "w1", "r1", "Task checkout", "todo"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, execution_run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t_update_execution", "p1", "w1", "r1", "Task execution", "todo"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t_update_owner", "p1", "w1", "r1", "Task owner", "todo"],
      );
      db.run(
        "INSERT INTO approvals (id, project_id, workspace_id, task_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?)",
        ["a_update_task", "p1", "w1", "t1", "pending", "user"],
      );
      db.run(
        "INSERT INTO approvals (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["a_update_run", "p1", "w1", "t1", "r1", "pending", "user"],
      );
      db.run(
        "INSERT INTO approvals (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["a_update_owner", "p1", "w1", "t1", "r1", "pending", "user"],
      );
      db.run(
        [
          "INSERT INTO task_assignments",
          "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, role_responsibility, assigned_by_actor_type)",
          "VALUES",
          "  (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"),
        [
          "ta_update_task",
          "p1",
          "w1",
          "t1",
          "r1",
          "backend_agent",
          "Backend Agent",
          "Owns runtime changes",
          "agent",
        ],
      );
      db.run(
        [
          "INSERT INTO task_assignments",
          "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, role_responsibility, assigned_by_actor_type)",
          "VALUES",
          "  (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"),
        [
          "ta_update_run",
          "p1",
          "w1",
          "t_update_run",
          "r1",
          "backend_agent",
          "Backend Agent",
          "Owns runtime changes",
          "agent",
        ],
      );
      db.run(
        [
          "INSERT INTO task_assignments",
          "  (id, project_id, workspace_id, task_id, run_id, role_key, role_display_name, role_responsibility, assigned_by_actor_type)",
          "VALUES",
          "  (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join("\n"),
        [
          "ta_update_owner",
          "p1",
          "w1",
          "t_update_owner",
          "r1",
          "backend_agent",
          "Backend Agent",
          "Owns runtime changes",
          "agent",
        ],
      );

      expect(() =>
        db.run("UPDATE messages SET run_id = ? WHERE id = ?", ["r2", "m_update_run"]),
      ).toThrow(/messages\.run_id must reference a run in the same project\/workspace/);

      expect(() =>
        db.run(
          "UPDATE messages SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "m_update_owner"],
        ),
      ).toThrow(/messages\.run_id must reference a run in the same project\/workspace/);

      expect(() =>
        db.run("UPDATE tasks SET run_id = ? WHERE id = ?", ["r2", "t_update_run"]),
      ).toThrow(/tasks\.run_id must reference a run in the same project\/workspace/);

      expect(() =>
        db.run("UPDATE tasks SET checkout_run_id = ? WHERE id = ?", [
          "r2",
          "t_update_checkout",
        ]),
      ).toThrow(
        /tasks\.checkout_run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run("UPDATE tasks SET execution_run_id = ? WHERE id = ?", [
          "r2",
          "t_update_execution",
        ]),
      ).toThrow(
        /tasks\.execution_run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "UPDATE tasks SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "t_update_owner"],
        ),
      ).toThrow(/tasks\.run_id must reference a run in the same project\/workspace/);

      expect(() =>
        db.run("UPDATE approvals SET task_id = ? WHERE id = ?", [
          "t2",
          "a_update_task",
        ]),
      ).toThrow(
        /approvals\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run("UPDATE approvals SET run_id = ? WHERE id = ?", ["r2", "a_update_run"]),
      ).toThrow(
        /approvals\.run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "UPDATE approvals SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "a_update_owner"],
        ),
      ).toThrow(
        /approvals\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run("UPDATE task_assignments SET task_id = ? WHERE id = ?", [
          "t2",
          "ta_update_task",
        ]),
      ).toThrow(
        /task_assignments\.task_id must reference a task in the same project\/workspace/,
      );

      expect(() =>
        db.run("UPDATE task_assignments SET run_id = ? WHERE id = ?", [
          "r2",
          "ta_update_run",
        ]),
      ).toThrow(
        /task_assignments\.run_id must reference a run in the same project\/workspace/,
      );

      expect(() =>
        db.run(
          "UPDATE task_assignments SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "ta_update_owner"],
        ),
      ).toThrow(
        /task_assignments\.task_id must reference a task in the same project\/workspace/,
      );
    });
  });

  it("rejects parent lineage refs that point outside the row project/workspace", async () => {
    await withDatabase((db) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p2",
        "project-2",
        "Project 2",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w2",
        "p2",
        "Workspace 2",
      ]);

      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["t_parent", "p1", "w1", "Task parent", "todo"],
      );
      db.run(
        "INSERT INTO messages (id, project_id, workspace_id, actor_type, content) VALUES (?, ?, ?, ?, ?)",
        ["m_parent", "p1", "w1", "user", "message"],
      );

      expect(() =>
        db.run(
          "INSERT INTO tasks (id, project_id, workspace_id, parent_task_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
          ["t_cross_parent", "p2", "w2", "t_parent", "Task cross parent", "todo"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(() =>
        db.run(
          "INSERT INTO messages (id, project_id, workspace_id, parent_message_id, actor_type, content) VALUES (?, ?, ?, ?, ?, ?)",
          ["m_cross_parent", "p2", "w2", "m_parent", "user", "cross message"],
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it("rejects ownership-key updates that would orphan linked run/task references", async () => {
    await withDatabase((db) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p2",
        "project-2",
        "Project 2",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w2",
        "p2",
        "Workspace 2",
      ]);

      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r_msg", "p1", "w1", "planned"],
      );
      db.run(
        "INSERT INTO messages (id, project_id, workspace_id, run_id, actor_type, content) VALUES (?, ?, ?, ?, ?, ?)",
        ["m1", "p1", "w1", "r_msg", "user", "message"],
      );
      expect(() =>
        db.run(
          "UPDATE runs SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "r_msg"],
        ),
      ).toThrow(
        /runs\.project_id\/workspace_id update would orphan linked messages/,
      );

      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r_task", "p1", "w1", "planned"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t_run", "p1", "w1", "r_task", "Task run", "todo"],
      );
      expect(() =>
        db.run(
          "UPDATE runs SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "r_task"],
        ),
      ).toThrow(/runs\.project_id\/workspace_id update would orphan linked tasks/);

      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r_approval", "p1", "w1", "planned"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["t_approval", "p1", "w1", "Task approval", "todo"],
      );
      db.run(
        "INSERT INTO approvals (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["a_run", "p1", "w1", "t_approval", "r_approval", "pending", "user"],
      );
      expect(() =>
        db.run(
          "UPDATE runs SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "r_approval"],
        ),
      ).toThrow(
        /runs\.project_id\/workspace_id update would orphan linked approvals/,
      );

      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, title, state) VALUES (?, ?, ?, ?, ?)",
        ["t_move", "p1", "w1", "Task move", "todo"],
      );
      db.run(
        "INSERT INTO approvals (id, project_id, workspace_id, task_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?)",
        ["a_move", "p1", "w1", "t_move", "pending", "system"],
      );
      expect(() =>
        db.run(
          "UPDATE tasks SET project_id = ?, workspace_id = ? WHERE id = ?",
          ["p2", "w2", "t_move"],
        ),
      ).toThrow(
        /tasks\.project_id\/workspace_id update would orphan linked approvals/,
      );
    });
  });

  it("keeps audit events append-only while allowing parent entity cleanup", async () => {
    await withDatabase((db) => {
      db.run("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [
        "p1",
        "project-1",
        "Project 1",
      ]);
      db.run("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)", [
        "w1",
        "p1",
        "Workspace 1",
      ]);
      db.run(
        "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
        ["r1", "p1", "w1", "planned"],
      );
      db.run(
        "INSERT INTO tasks (id, project_id, workspace_id, run_id, title, state) VALUES (?, ?, ?, ?, ?, ?)",
        ["t1", "p1", "w1", "r1", "Task 1", "todo"],
      );
      db.run(
        "INSERT INTO approvals (id, project_id, workspace_id, task_id, run_id, status, requested_by_actor_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["a1", "p1", "w1", "t1", "r1", "pending", "system"],
      );
      db.run(
        "INSERT INTO audit_events (id, project_id, workspace_id, run_id, task_id, approval_id, actor_type, entity_type, entity_id, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["e1", "p1", "w1", "r1", "t1", "a1", "system", "task", "t1", "created"],
      );

      expect(() => db.run("DELETE FROM runs WHERE id = ?", ["r1"])).not.toThrow();

      const result = db.exec(
        "SELECT run_id FROM audit_events WHERE id = 'e1'",
      );
      const runId = result[0]?.values[0]?.[0];
      expect(runId).toBe("r1");

      expect(() =>
        db.run("UPDATE audit_events SET action = ? WHERE id = ?", ["updated", "e1"]),
      ).toThrow(/audit_events is append-only/);

      expect(() => db.run("DELETE FROM audit_events WHERE id = ?", ["e1"])).toThrow(
        /audit_events is append-only/,
      );
    });
  });
});
