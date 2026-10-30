ALTER TABLE `duels` ADD COLUMN `opponent_escrow` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `duels` ADD COLUMN `opponent_escrow_at` integer;
