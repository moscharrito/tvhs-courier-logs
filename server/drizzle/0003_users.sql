-- Users become the platform directory (ticket 0.7). SQLite cannot alter a
-- CHECK constraint, so the table is rebuilt in place: same columns and ids,
-- plus email and status, and role widened to admin | staff | driver.
-- Hand-written from the drizzle-kit output: the generated INSERT selected the
-- new columns from the old table, and the constraints are written unqualified
-- so the rename leaves clean DDL. Legacy style (inline UNIQUE, DATETIME) kept.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE __new_users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT UNIQUE NOT NULL,
	password TEXT NOT NULL,
	pin TEXT,
	name TEXT NOT NULL,
	email TEXT,
	role TEXT NOT NULL CHECK(role IN ('admin','staff','driver')),
	status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
	route TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
INSERT INTO __new_users (id, username, password, pin, name, email, role, status, route, created_at)
	SELECT id, username, password, pin, name, NULL, role, 'active', route, created_at FROM users;
--> statement-breakpoint
DROP TABLE users;--> statement-breakpoint
ALTER TABLE __new_users RENAME TO users;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE memberships ADD settings text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE memberships
	SET settings = json_object('route', (SELECT route FROM users u WHERE u.id = memberships.user_id))
	WHERE project_id = (SELECT id FROM projects WHERE code = 'tvhs')
	  AND role = 'courier'
	  AND (SELECT route FROM users u WHERE u.id = memberships.user_id) IS NOT NULL;
