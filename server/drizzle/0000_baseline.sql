-- Baseline: the three TVHS tables exactly as the legacy server.js created them.
-- Hand-edited from the drizzle-kit output so that:
--   * IF NOT EXISTS lets databases created by the legacy server adopt this
--     baseline without change (the pre-baseline step in src/db/migrate.ts adds
--     pin / leg_from / leg_to to databases older than those columns);
--   * inline UNIQUE(...) constraints match the legacy autoindexes instead of
--     creating duplicate named unique indexes.
-- The snapshot in meta/ describes the same tables, so later diffs are clean.
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT UNIQUE NOT NULL,
	password TEXT NOT NULL,
	pin TEXT,
	name TEXT NOT NULL,
	role TEXT NOT NULL CHECK(role IN ('driver','admin')),
	route TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL,
	date TEXT NOT NULL,
	leg_index INTEGER NOT NULL,
	leg_from TEXT DEFAULT '',
	leg_to TEXT DEFAULT '',
	start_time TEXT DEFAULT '',
	end_time TEXT DEFAULT '',
	sterile INTEGER DEFAULT 0,
	soiled INTEGER DEFAULT 0,
	miles REAL DEFAULT 0,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(username, date, leg_index),
	FOREIGN KEY(username) REFERENCES users(username)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS checkins (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL,
	date TEXT NOT NULL,
	checkin_at DATETIME NOT NULL,
	UNIQUE(username, date),
	FOREIGN KEY(username) REFERENCES users(username)
);
