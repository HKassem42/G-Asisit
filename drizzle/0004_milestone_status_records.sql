ALTER TABLE `milestones` ADD COLUMN `status` text DEFAULT 'deploy-step' NOT NULL;
--> statement-breakpoint
ALTER TABLE `milestones` ADD COLUMN `status_note` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'ready', `status_note` = 'Wallet, integer coins, and the full ledger run live in this app (Google sign-in itself ships with the mobile build).' WHERE `week` = 1;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'ready', `status_note` = 'Paper trading core live: weighted-average cost, positions, live P/L.' WHERE `week` = 2;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'app-scope', `status_note` = 'Create, then the bot rival accepts and matches escrow (recorded in the ledger), then live battle. Limit: bot accept, not a human deep-link — rivals here are bots and are labeled as bots; human invite / deep-link accept belongs to the shipped app.' WHERE `week` = 3;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'app-scope', `status_note` = 'The board refreshes itself every 15 seconds. Limit: polling, not Socket.io — Socket.io rooms belong to the shipped app.' WHERE `week` = 4;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'ready', `status_note` = 'Server-side auto-score and auto-end from your real record (blueprint §6: R·K·C·A·B), pot paid or refunded.' WHERE `week` = 5;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'app-scope', `status_note` = 'Under-3-trades auto-void, 5 duels/hour and 60 trades/hour caps, 24h rematch cooldown — all enforced server-side. Limit: the shared-device check belongs to the shipped app.' WHERE `week` = 6;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'deploy-step', `status_note` = 'TestFlight beta happens when you say deploy — not built, not faked.' WHERE `week` = 7;
--> statement-breakpoint
UPDATE `milestones` SET `status` = 'mixed', `status_note` = 'Live BTC/ETH/KAS prices via the CoinGecko public API are ready. Store submission is a deploy step, when you say deploy; Polygon.io still needs your own key.' WHERE `week` = 8;
