CREATE TABLE IF NOT EXISTS `player_profile` (
  `id` integer PRIMARY KEY NOT NULL,
  `handle` text DEFAULT '' NOT NULL,
  `home_market` text DEFAULT '' NOT NULL,
  `onboarded_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
