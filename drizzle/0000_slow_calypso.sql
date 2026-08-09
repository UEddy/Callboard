CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `evaluation_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_idx` ON `assignments` (`plan_id`,`participant_id`,`submission_id`,`round`);--> statement-breakpoint
CREATE INDEX `assignment_evaluator_idx` ON `assignments` (`participant_id`,`status`);--> statement-breakpoint
CREATE INDEX `assignment_submission_idx` ON `assignments` (`submission_id`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_token_unique` ON `auth_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`participant_id` text,
	`submission_id` text,
	`template_key` text NOT NULL,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`ics_uid` text,
	`ics_sequence` integer DEFAULT 0,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `email_log_event_idx` ON `email_log` (`event_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_log_participant_idx` ON `email_log` (`participant_id`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body_html` text NOT NULL,
	`trigger` text DEFAULT 'custom' NOT NULL,
	`attach_ics` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_tmpl_idx` ON `email_templates` (`event_id`,`key`);--> statement-breakpoint
CREATE TABLE `embeds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT 'agenda' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`public_token` text NOT NULL,
	`style` text,
	`filters` text,
	`fields` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeds_public_token_unique` ON `embeds` (`public_token`);--> statement-breakpoint
CREATE INDEX `embeds_event_idx` ON `embeds` (`event_id`);--> statement-breakpoint
CREATE TABLE `evaluation_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`criteria` text,
	`scale_min` integer DEFAULT 1 NOT NULL,
	`scale_max` integer DEFAULT 5 NOT NULL,
	`rounds` integer DEFAULT 1 NOT NULL,
	`anonymize` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `eval_plans_event_idx` ON `evaluation_plans` (`event_id`);--> statement-breakpoint
CREATE TABLE `evaluator_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reason` text DEFAULT 'same_company' NOT NULL,
	`auto_detected` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_conflict_idx` ON `evaluator_conflicts` (`participant_id`,`submission_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`starts_at` integer,
	`ends_at` integer,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`logo_url` text,
	`background_url` text,
	`submission_limit_per_user` integer DEFAULT 3,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`validation` text,
	`help_text` text,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_def_event_key_idx` ON `field_definitions` (`event_id`,`key`);--> statement-breakpoint
CREATE TABLE `form_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`step` text DEFAULT 'submission' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`conditional_rule` text,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `form_fields_form_idx` ON `form_fields` (`form_id`,`step`,`sort_order`);--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`public_slug` text NOT NULL,
	`kind` text DEFAULT 'sessions' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`collect_participants` integer DEFAULT true NOT NULL,
	`welcome_html` text,
	`terms_html` text,
	`success_html` text,
	`close_at` integer,
	`reminder_at` integer,
	`submission_limit` integer,
	`allow_multiple_drafts` integer DEFAULT false NOT NULL,
	`admin_notify_new` text,
	`admin_notify_update` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forms_public_slug_unique` ON `forms` (`public_slug`);--> statement-breakpoint
CREATE INDEX `forms_event_idx` ON `forms` (`event_id`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`email` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`salutation` text,
	`honorific` text,
	`company` text,
	`job_title` text,
	`phone` text,
	`bio` text,
	`headshot_url` text,
	`links` text,
	`is_evaluator` integer DEFAULT false NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_event_email_idx` ON `participants` (`event_id`,`email`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personas_event_idx` ON `personas` (`event_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rooms_event_idx` ON `rooms` (`event_id`);--> statement-breakpoint
CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`when_field_key` text NOT NULL,
	`when_op` text DEFAULT 'eq' NOT NULL,
	`when_value` text NOT NULL,
	`assign_track_id` text,
	`assign_plan_id` text,
	`assign_tag_ids` text,
	`notify_emails` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assign_track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `routing_rules_form_idx` ON `routing_rules` (`form_id`);--> statement-breakpoint
CREATE TABLE `scores` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`criterion_key` text NOT NULL,
	`value` integer NOT NULL,
	`comment` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_idx` ON `scores` (`assignment_id`,`criterion_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `submission_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`role` text DEFAULT 'Speaker' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sub_part_idx` ON `submission_participants` (`submission_id`,`participant_id`);--> statement-breakpoint
CREATE INDEX `sub_part_participant_idx` ON `submission_participants` (`participant_id`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_id` text,
	`ref` text NOT NULL,
	`ref_seq` integer NOT NULL,
	`kind` text DEFAULT 'sessions' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`track_id` text,
	`format` text,
	`level` text,
	`answers` text,
	`tag_ids` text,
	`room_id` text,
	`starts_at` integer,
	`ends_at` integer,
	`is_draft_schedule` integer DEFAULT true NOT NULL,
	`submitted_at` integer,
	`decided_at` integer,
	`notified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_event_ref_idx` ON `submissions` (`event_id`,`ref`);--> statement-breakpoint
CREATE INDEX `submissions_status_idx` ON `submissions` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `submissions_track_idx` ON `submissions` (`event_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `submissions_schedule_idx` ON `submissions` (`event_id`,`room_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#94a3b8' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tags_event_idx` ON `tags` (`event_id`);--> statement-breakpoint
CREATE TABLE `task_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`submission_id` text,
	`status` text DEFAULT 'not_started' NOT NULL,
	`file_url` text,
	`notes` text,
	`completed_at` integer,
	`last_nudged_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_assign_idx` ON `task_assignments` (`task_id`,`participant_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX `task_assign_status_idx` ON `task_assignments` (`status`);--> statement-breakpoint
CREATE INDEX `task_assign_participant_idx` ON `task_assignments` (`participant_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'custom' NOT NULL,
	`applies_to` text DEFAULT 'all_accepted_speakers' NOT NULL,
	`due_at` integer,
	`required` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_event_idx` ON `tasks` (`event_id`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tracks_event_idx` ON `tracks` (`event_id`);