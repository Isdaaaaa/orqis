CREATE TABLE `provider_configs` (
  `provider_key` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `base_url` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX `provider_configs_created_at_idx` ON `provider_configs` (`created_at`);

CREATE TABLE `model_configs` (
  `model_key` text PRIMARY KEY NOT NULL,
  `provider_key` text NOT NULL,
  `display_name` text NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`provider_key`) REFERENCES `provider_configs` (`provider_key`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `model_configs_provider_key_created_at_idx`
  ON `model_configs` (`provider_key`, `created_at`);

CREATE TABLE `agent_profiles` (
  `role_key` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `model_key` text NOT NULL,
  `responsibility` text NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`model_key`) REFERENCES `model_configs` (`model_key`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `agent_profiles_model_key_created_at_idx`
  ON `agent_profiles` (`model_key`, `created_at`);
