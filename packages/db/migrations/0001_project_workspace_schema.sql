PRAGMA foreign_keys = ON;

CREATE TABLE `projects` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);
CREATE INDEX `projects_created_at_idx` ON `projects` (`created_at`);

CREATE TABLE `workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `name` text NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `workspaces_project_id_unique` ON `workspaces` (`project_id`);
CREATE UNIQUE INDEX `workspaces_project_id_id_unique` ON `workspaces` (`project_id`, `id`);
CREATE INDEX `workspaces_created_at_idx` ON `workspaces` (`created_at`);

CREATE TABLE `runs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'planned' CHECK (`status` in ('planned', 'running', 'waiting_approval', 'done', 'failed')),
  `summary` text,
  `started_at` text,
  `ended_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `runs_workspace_created_at_idx` ON `runs` (`workspace_id`, `created_at`);
CREATE INDEX `runs_status_created_at_idx` ON `runs` (`status`, `created_at`);

CREATE TABLE `messages` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `run_id` text,
  `parent_message_id` text,
  `actor_type` text NOT NULL CHECK (`actor_type` in ('user', 'agent', 'system')),
  `actor_id` text,
  `content` text NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`parent_message_id`) REFERENCES `messages` (`id`) ON UPDATE no action ON DELETE set null
);

CREATE INDEX `messages_workspace_created_at_idx` ON `messages` (`workspace_id`, `created_at`);
CREATE INDEX `messages_run_created_at_idx` ON `messages` (`run_id`, `created_at`);

CREATE TABLE `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `run_id` text,
  `parent_task_id` text,
  `title` text NOT NULL,
  `description` text,
  `state` text NOT NULL DEFAULT 'todo' CHECK (`state` in ('todo', 'in_progress', 'waiting_approval', 'done', 'failed', 'blocked')),
  `owner_role` text,
  `lock_owner_type` text CHECK (`lock_owner_type` is null OR `lock_owner_type` in ('run', 'agent', 'user')),
  `lock_owner_id` text,
  `lock_acquired_at` text,
  `checkout_run_id` text,
  `execution_run_id` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` text,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`parent_task_id`) REFERENCES `tasks` (`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`checkout_run_id`) REFERENCES `runs` (`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`execution_run_id`) REFERENCES `runs` (`id`) ON UPDATE no action ON DELETE set null
);

CREATE INDEX `tasks_workspace_state_updated_at_idx` ON `tasks` (`workspace_id`, `state`, `updated_at`);
CREATE INDEX `tasks_parent_task_id_idx` ON `tasks` (`parent_task_id`);
CREATE INDEX `tasks_run_updated_at_idx` ON `tasks` (`run_id`, `updated_at`);
CREATE INDEX `tasks_checkout_run_id_idx` ON `tasks` (`checkout_run_id`);
CREATE INDEX `tasks_execution_run_id_idx` ON `tasks` (`execution_run_id`);

CREATE TABLE `approvals` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `task_id` text NOT NULL,
  `run_id` text,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` in ('pending', 'approved', 'rejected', 'revision_requested', 'resubmitted')),
  `requested_by_actor_type` text NOT NULL CHECK (`requested_by_actor_type` in ('user', 'agent', 'system')),
  `requested_by_actor_id` text,
  `decision_by_actor_type` text CHECK (`decision_by_actor_type` is null OR `decision_by_actor_type` in ('user', 'agent', 'system')),
  `decision_by_actor_id` text,
  `decision_summary` text,
  `requested_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `decided_at` text,
  `revision_requested_at` text,
  `resubmitted_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON UPDATE no action ON DELETE set null
);

CREATE INDEX `approvals_task_created_at_idx` ON `approvals` (`task_id`, `created_at`);
CREATE INDEX `approvals_status_created_at_idx` ON `approvals` (`status`, `created_at`);
CREATE INDEX `approvals_run_created_at_idx` ON `approvals` (`run_id`, `created_at`);

CREATE TRIGGER `messages_same_workspace_run_id_insert`
BEFORE INSERT ON `messages`
WHEN NEW.`run_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `runs`
    WHERE `id` = NEW.`run_id`
      AND `project_id` = NEW.`project_id`
      AND `workspace_id` = NEW.`workspace_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'messages.run_id must reference a run in the same project/workspace');
END;

CREATE TRIGGER `messages_same_workspace_run_id_update`
BEFORE UPDATE ON `messages`
WHEN NEW.`run_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `runs`
    WHERE `id` = NEW.`run_id`
      AND `project_id` = NEW.`project_id`
      AND `workspace_id` = NEW.`workspace_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'messages.run_id must reference a run in the same project/workspace');
END;

CREATE TRIGGER `tasks_same_workspace_run_refs_insert`
BEFORE INSERT ON `tasks`
BEGIN
  SELECT RAISE(ABORT, 'tasks.run_id must reference a run in the same project/workspace')
  WHERE NEW.`run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );

  SELECT RAISE(ABORT, 'tasks.checkout_run_id must reference a run in the same project/workspace')
  WHERE NEW.`checkout_run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`checkout_run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );

  SELECT RAISE(ABORT, 'tasks.execution_run_id must reference a run in the same project/workspace')
  WHERE NEW.`execution_run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`execution_run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );
END;

CREATE TRIGGER `tasks_same_workspace_run_refs_update`
BEFORE UPDATE ON `tasks`
BEGIN
  SELECT RAISE(ABORT, 'tasks.run_id must reference a run in the same project/workspace')
  WHERE NEW.`run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );

  SELECT RAISE(ABORT, 'tasks.checkout_run_id must reference a run in the same project/workspace')
  WHERE NEW.`checkout_run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`checkout_run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );

  SELECT RAISE(ABORT, 'tasks.execution_run_id must reference a run in the same project/workspace')
  WHERE NEW.`execution_run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`execution_run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );
END;

CREATE TRIGGER `approvals_same_workspace_refs_insert`
BEFORE INSERT ON `approvals`
BEGIN
  SELECT RAISE(ABORT, 'approvals.task_id must reference a task in the same project/workspace')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `tasks`
    WHERE `id` = NEW.`task_id`
      AND `project_id` = NEW.`project_id`
      AND `workspace_id` = NEW.`workspace_id`
  );

  SELECT RAISE(ABORT, 'approvals.run_id must reference a run in the same project/workspace')
  WHERE NEW.`run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );
END;

CREATE TRIGGER `approvals_same_workspace_refs_update`
BEFORE UPDATE ON `approvals`
BEGIN
  SELECT RAISE(ABORT, 'approvals.task_id must reference a task in the same project/workspace')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `tasks`
    WHERE `id` = NEW.`task_id`
      AND `project_id` = NEW.`project_id`
      AND `workspace_id` = NEW.`workspace_id`
  );

  SELECT RAISE(ABORT, 'approvals.run_id must reference a run in the same project/workspace')
  WHERE NEW.`run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );
END;

CREATE TABLE `audit_events` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `run_id` text,
  `task_id` text,
  `approval_id` text,
  `actor_type` text NOT NULL CHECK (`actor_type` in ('user', 'agent', 'system')),
  `actor_id` text,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `action` text NOT NULL,
  `details_json` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `audit_events_workspace_created_at_idx` ON `audit_events` (`workspace_id`, `created_at`);
CREATE INDEX `audit_events_entity_created_at_idx` ON `audit_events` (`entity_type`, `entity_id`, `created_at`);
CREATE INDEX `audit_events_run_created_at_idx` ON `audit_events` (`run_id`, `created_at`);
CREATE INDEX `audit_events_actor_created_at_idx` ON `audit_events` (`actor_type`, `actor_id`, `created_at`);

CREATE TRIGGER `audit_events_no_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER `audit_events_no_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
