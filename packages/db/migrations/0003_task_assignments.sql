CREATE TABLE `task_assignments` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `task_id` text NOT NULL,
  `run_id` text,
  `role_key` text NOT NULL,
  `role_display_name` text NOT NULL,
  `model_key` text,
  `role_responsibility` text NOT NULL,
  `assigned_by_actor_type` text NOT NULL,
  `assigned_by_actor_id` text,
  `assigned_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `runs` (`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `workspaces` (`project_id`, `id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `workspace_id`, `task_id`) REFERENCES `tasks` (`project_id`, `workspace_id`, `id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`assigned_by_actor_type` in ('user', 'agent', 'system'))
);

CREATE UNIQUE INDEX `task_assignments_task_id_unique`
  ON `task_assignments` (`task_id`);
CREATE INDEX `task_assignments_workspace_role_assigned_at_idx`
  ON `task_assignments` (`workspace_id`, `role_key`, `assigned_at`);
CREATE INDEX `task_assignments_run_assigned_at_idx`
  ON `task_assignments` (`run_id`, `assigned_at`);

CREATE TRIGGER `task_assignments_same_workspace_refs_insert`
BEFORE INSERT ON `task_assignments`
BEGIN
  SELECT RAISE(ABORT, 'task_assignments.task_id must reference a task in the same project/workspace')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `tasks`
    WHERE `id` = NEW.`task_id`
      AND `project_id` = NEW.`project_id`
      AND `workspace_id` = NEW.`workspace_id`
  );

  SELECT RAISE(ABORT, 'task_assignments.run_id must reference a run in the same project/workspace')
  WHERE NEW.`run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );
END;

CREATE TRIGGER `task_assignments_same_workspace_refs_update`
BEFORE UPDATE ON `task_assignments`
BEGIN
  SELECT RAISE(ABORT, 'task_assignments.task_id must reference a task in the same project/workspace')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `tasks`
    WHERE `id` = NEW.`task_id`
      AND `project_id` = NEW.`project_id`
      AND `workspace_id` = NEW.`workspace_id`
  );

  SELECT RAISE(ABORT, 'task_assignments.run_id must reference a run in the same project/workspace')
  WHERE NEW.`run_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `runs`
      WHERE `id` = NEW.`run_id`
        AND `project_id` = NEW.`project_id`
        AND `workspace_id` = NEW.`workspace_id`
    );
END;

INSERT INTO `task_assignments` (
  `id`,
  `project_id`,
  `workspace_id`,
  `task_id`,
  `run_id`,
  `role_key`,
  `role_display_name`,
  `model_key`,
  `role_responsibility`,
  `assigned_by_actor_type`,
  `assigned_by_actor_id`,
  `assigned_at`,
  `created_at`,
  `updated_at`
)
SELECT
  lower(hex(randomblob(16))),
  `tasks`.`project_id`,
  `tasks`.`workspace_id`,
  `tasks`.`id`,
  COALESCE(`tasks`.`checkout_run_id`, `tasks`.`run_id`),
  `tasks`.`owner_role`,
  COALESCE(`agent_profiles`.`display_name`, `tasks`.`owner_role`),
  `agent_profiles`.`model_key`,
  COALESCE(
    `agent_profiles`.`responsibility`,
    'Legacy task assignment imported without a matching saved role configuration.'
  ),
  'system',
  'migration_0003_backfill',
  COALESCE(`tasks`.`created_at`, CURRENT_TIMESTAMP),
  COALESCE(`tasks`.`created_at`, CURRENT_TIMESTAMP),
  COALESCE(`tasks`.`updated_at`, `tasks`.`created_at`, CURRENT_TIMESTAMP)
FROM `tasks`
LEFT JOIN `agent_profiles`
  ON `agent_profiles`.`role_key` = `tasks`.`owner_role`
WHERE `tasks`.`owner_role` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `task_assignments`
    WHERE `task_assignments`.`task_id` = `tasks`.`id`
  );

CREATE TRIGGER `task_assignments_audit_insert`
AFTER INSERT ON `task_assignments`
BEGIN
  INSERT INTO `audit_events` (
    `id`,
    `project_id`,
    `workspace_id`,
    `run_id`,
    `task_id`,
    `actor_type`,
    `actor_id`,
    `entity_type`,
    `entity_id`,
    `action`
  )
  VALUES (
    lower(hex(randomblob(16))),
    NEW.`project_id`,
    NEW.`workspace_id`,
    COALESCE(
      NEW.`run_id`,
      orqis_audit_correlation_run_id()
    ),
    NEW.`task_id`,
    COALESCE(orqis_audit_actor_type(), NEW.`assigned_by_actor_type`, 'system'),
    COALESCE(orqis_audit_actor_id(), NEW.`assigned_by_actor_id`),
    'task_assignment',
    NEW.`id`,
    'task_assignment.created'
  );
END;

CREATE TRIGGER `task_assignments_audit_update`
AFTER UPDATE ON `task_assignments`
BEGIN
  INSERT INTO `audit_events` (
    `id`,
    `project_id`,
    `workspace_id`,
    `run_id`,
    `task_id`,
    `actor_type`,
    `actor_id`,
    `entity_type`,
    `entity_id`,
    `action`
  )
  VALUES (
    lower(hex(randomblob(16))),
    NEW.`project_id`,
    NEW.`workspace_id`,
    COALESCE(
      NEW.`run_id`,
      orqis_audit_correlation_run_id()
    ),
    NEW.`task_id`,
    COALESCE(orqis_audit_actor_type(), NEW.`assigned_by_actor_type`, 'system'),
    COALESCE(orqis_audit_actor_id(), NEW.`assigned_by_actor_id`),
    'task_assignment',
    NEW.`id`,
    'task_assignment.updated'
  );
END;
