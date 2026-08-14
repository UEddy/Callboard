PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`criterion_key` text NOT NULL,
	`value` integer,
	`comment` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_scores`("id", "assignment_id", "criterion_key", "value", "comment", "created_at") SELECT "id", "assignment_id", "criterion_key", "value", "comment", "created_at" FROM `scores`;--> statement-breakpoint
DROP TABLE `scores`;--> statement-breakpoint
ALTER TABLE `__new_scores` RENAME TO `scores`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `score_idx` ON `scores` (`assignment_id`,`criterion_key`);