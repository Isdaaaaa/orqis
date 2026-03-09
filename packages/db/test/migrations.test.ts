import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_STATUSES,
  DB_MIGRATION_FILES,
  RUN_STATUSES,
  TASK_STATES,
  resolveDbMigrationsDir,
} from "../src/index.ts";

function loadMigrationSql(): string {
  const migrationsDir = resolveDbMigrationsDir();

  return DB_MIGRATION_FILES.map((fileName) =>
    readFileSync(join(migrationsDir, fileName), "utf8"),
  ).join("\n");
}

function extractTableSql(migrationSql: string, tableName: string): string {
  const tableRegex = new RegExp(
    `CREATE TABLE \\\`${tableName}\\\` \\([\\s\\S]*?\\n\\);`,
  );
  const match = migrationSql.match(tableRegex);

  if (!match) {
    throw new Error(`Missing table definition for ${tableName}`);
  }

  return match[0];
}

describe("@orqis/db migration SQL", () => {
  const migrationSql = loadMigrationSql();

  it("declares required project/workspace workflow tables", () => {
    const requiredTables = [
      "projects",
      "workspaces",
      "messages",
      "tasks",
      "approvals",
      "runs",
      "audit_events",
    ];

    for (const tableName of requiredTables) {
      expect(migrationSql).toContain(`CREATE TABLE \`${tableName}\``);
    }
  });

  it("defines run lifecycle states and timeline indexes", () => {
    const runsTableSql = extractTableSql(migrationSql, "runs");

    for (const status of RUN_STATUSES) {
      expect(runsTableSql).toContain(`'${status}'`);
    }

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
      "FOREIGN KEY (`parent_task_id`) REFERENCES `tasks` (`id`)",
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

    for (const status of APPROVAL_STATUSES) {
      expect(approvalsTableSql).toContain(`'${status}'`);
    }

    expect(migrationSql).toContain("CREATE INDEX `approvals_task_created_at_idx`");
    expect(migrationSql).toContain(
      "CREATE INDEX `approvals_status_created_at_idx`",
    );
    expect(migrationSql).toContain("CREATE INDEX `approvals_run_created_at_idx`");
  });

  it("makes audit events append-only with indexed timeline correlation fields", () => {
    const auditEventsTableSql = extractTableSql(migrationSql, "audit_events");

    expect(auditEventsTableSql).toContain("`actor_type` text NOT NULL");
    expect(auditEventsTableSql).toContain("`actor_id` text");
    expect(auditEventsTableSql).toContain("`entity_type` text NOT NULL");
    expect(auditEventsTableSql).toContain("`entity_id` text NOT NULL");
    expect(auditEventsTableSql).toContain("`run_id` text");

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
});
