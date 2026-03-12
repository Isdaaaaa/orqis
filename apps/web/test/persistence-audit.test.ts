import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkspaceTimelineDatabaseHandle } from "../src/persistence.ts";
import { WORKSPACE_CI_INTEGRATION_TIMEOUT_MS } from "./integration-timeouts.ts";

interface AuditEventRow {
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly approvalId: string | null;
}

function readAuditEvents(
  database: ReturnType<typeof createWorkspaceTimelineDatabaseHandle>["database"],
): AuditEventRow[] {
  return database
    .prepare(
      [
        "SELECT",
        "  action,",
        "  actor_type AS actorType,",
        "  actor_id AS actorId,",
        "  run_id AS runId,",
        "  task_id AS taskId,",
        "  approval_id AS approvalId",
        "FROM audit_events",
        "ORDER BY rowid ASC",
      ].join("\n"),
    )
    .all() as AuditEventRow[];
}

describe("@orqis/web workspace persistence audit integration", () => {
  it(
    "registers audit SQL functions on real better-sqlite3 connections so run, task, and approval writes succeed",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-audit-"));
      const databaseFilePath = join(tempDir, "audit.db");
      const databaseHandle = createWorkspaceTimelineDatabaseHandle(databaseFilePath);

      try {
        const { auditContext, database } = databaseHandle;

        database
          .prepare("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
          .run("project_1", "project-1", "Project 1");
        database
          .prepare("INSERT INTO workspaces (id, project_id, name) VALUES (?, ?, ?)")
          .run("workspace_1", "project_1", "Workspace 1");

        auditContext.runWithContext(
          {
            actorType: "user",
            actorId: "owner",
          },
          () => {
            database
              .prepare(
                "INSERT INTO runs (id, project_id, workspace_id, status) VALUES (?, ?, ?, ?)",
              )
              .run("run_1", "project_1", "workspace_1", "planned");
          },
        );

        auditContext.runWithContext(
          {
            actorType: "agent",
            actorId: "pm",
          },
          () => {
            database
              .prepare("UPDATE runs SET status = ? WHERE id = ?")
              .run("running", "run_1");
          },
        );

        auditContext.runWithContext(
          {
            actorType: "agent",
            actorId: "backend_agent",
            correlationRunId: "run_1",
          },
          () => {
            database
              .prepare(
                "INSERT INTO tasks (id, project_id, workspace_id, title) VALUES (?, ?, ?, ?)",
              )
              .run("task_1", "project_1", "workspace_1", "Ship review fix");
          },
        );

        auditContext.runWithContext(
          {
            actorType: "agent",
            actorId: "backend_agent",
            correlationRunId: "run_1",
          },
          () => {
            database
              .prepare("UPDATE tasks SET state = ? WHERE id = ?")
              .run("in_progress", "task_1");
          },
        );

        auditContext.runWithContext(
          {
            actorType: "user",
            actorId: "owner",
            correlationRunId: "run_1",
          },
          () => {
            database
              .prepare(
                [
                  "INSERT INTO approvals",
                  "  (id, project_id, workspace_id, task_id, requested_by_actor_type, requested_by_actor_id)",
                  "VALUES",
                  "  (?, ?, ?, ?, ?, ?)",
                ].join("\n"),
              )
              .run(
                "approval_1",
                "project_1",
                "workspace_1",
                "task_1",
                "user",
                "owner",
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
            database
              .prepare(
                [
                  "UPDATE approvals",
                  "SET status = ?, decision_by_actor_type = ?, decision_by_actor_id = ?, decided_at = CURRENT_TIMESTAMP",
                  "WHERE id = ?",
                ].join("\n"),
              )
              .run("approved", "user", "owner", "approval_1");
          },
        );

        expect(readAuditEvents(database)).toEqual([
          {
            action: "run.created",
            actorType: "user",
            actorId: "owner",
            runId: "run_1",
            taskId: null,
            approvalId: null,
          },
          {
            action: "run.updated",
            actorType: "agent",
            actorId: "pm",
            runId: "run_1",
            taskId: null,
            approvalId: null,
          },
          {
            action: "task.created",
            actorType: "agent",
            actorId: "backend_agent",
            runId: "run_1",
            taskId: "task_1",
            approvalId: null,
          },
          {
            action: "task.updated",
            actorType: "agent",
            actorId: "backend_agent",
            runId: "run_1",
            taskId: "task_1",
            approvalId: null,
          },
          {
            action: "approval.created",
            actorType: "user",
            actorId: "owner",
            runId: "run_1",
            taskId: "task_1",
            approvalId: "approval_1",
          },
          {
            action: "approval.updated",
            actorType: "user",
            actorId: "owner",
            runId: "run_1",
            taskId: "task_1",
            approvalId: "approval_1",
          },
        ]);
      } finally {
        databaseHandle.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    WORKSPACE_CI_INTEGRATION_TIMEOUT_MS,
  );
});
