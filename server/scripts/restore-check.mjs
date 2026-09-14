/* Is this database sound, and how far back does it go?
 *
 *   npm run restore:check -w server
 *   ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=<restored> TURSO_AUTH_TOKEN=... \
 *     npm run restore:check -w server
 *
 * Ticket 4.4. Step three of the restore procedure in docs/runbook.md used to
 * read "check the obvious counts", which is fine advice for the person who
 * wrote the schema and no help at all to anybody else at two in the morning.
 * This is that step.
 *
 * It reads and never writes. A restore that quietly repaired itself would hide
 * the reason it was needed.
 *
 * Exits non-zero when the database is not sound, so it can gate the step in a
 * procedure rather than being something somebody reads and nods at.
 */

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { loadConfig, describeConfig } from '../src/config.ts';
import { createDatabase } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.ts';
import { verifyDatabase, formatVerify } from '../src/db/verify.ts';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const config = loadConfig();
const expectedMigrations = fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).length;

console.log('Checking:', JSON.stringify(describeConfig(config)));
console.log(`This build ships ${expectedMigrations} migrations.`);
console.log('');

const database = createDatabase(config);
try {
    const result = await verifyDatabase(database.client, { expectedMigrations });
    console.log(formatVerify(result));
    console.log('');
    if (!result.ok) {
        console.log('Do not point the application at this database until the problems above are dealt with.');
        console.log('A missing migration is the ordinary case: run `npm run db:migrate -w server` against');
        console.log('this same database and check again.');
    }
    process.exit(result.ok ? 0 : 1);
} finally {
    database.client.close();
}
