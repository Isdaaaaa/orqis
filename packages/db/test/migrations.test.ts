import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_STATUSES,
  DB_MIGRATION_FILES,
  RUN_STATUSES,
  TASK_STATES,
  resolveDbMigrationsDir,
} from "../src/index.ts";

type SqlJsQueryResult = {
  columns: string[];
  values: unknown[][];
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => SqlJsQueryResult[];
  run: (sql: string, params?: unknown[]) => unknown;
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

async function createDatabase(): Promise<SqliteDatabase> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run(loadMigrationSql());
  return db as unknown as SqliteDatabase;
}

async function withDatabase(run: (db: SqliteDatabase) => void | Promise<void>): Promise<void> {
  const db = await createDatabase();

  try {
    await run(db);
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
