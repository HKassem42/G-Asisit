DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE wallet (
  id INTEGER PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  mmr INTEGER NOT NULL DEFAULT 1000
);
--> statement-breakpoint
CREATE TABLE wallet_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  current_price REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE duels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opponent TEXT NOT NULL,
  wager INTEGER NOT NULL,
  duration_label TEXT NOT NULL DEFAULT '30 min',
  status TEXT NOT NULL DEFAULT 'open',
  winner TEXT,
  your_score REAL,
  opp_score REAL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  signal TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 50,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE mining_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_date TEXT NOT NULL,
  hashrate REAL NOT NULL DEFAULT 0,
  kas_earned REAL NOT NULL DEFAULT 0,
  usd_value REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week INTEGER NOT NULL,
  label TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
