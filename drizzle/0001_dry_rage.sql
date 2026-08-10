CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`provider` text DEFAULT 'airtable' NOT NULL,
	`api_key` text,
	`base_id` text,
	`table_name` text,
	`speakers_table_name` text,
	`enabled` integer DEFAULT false NOT NULL,
	`last_push_at` integer,
	`last_pull_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_event_provider_idx` ON `integrations` (`event_id`,`provider`);--> statement-breakpoint
ALTER TABLE `participants` ADD `airtable_record_id` text;--> statement-breakpoint
ALTER TABLE `participants` ADD `airtable_synced_at` integer;--> statement-breakpoint
ALTER TABLE `submissions` ADD `airtable_record_id` text;--> statement-breakpoint
ALTER TABLE `submissions` ADD `airtable_synced_at` integer;