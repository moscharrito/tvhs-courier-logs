/* Run migrations by hand against the configured database.
 *
 *   npm run db:migrate -w server        (uses server/.env outside production)
 *
 * Exits non-zero on any failure. Use this against Turso before a deploy when
 * you want to see the migration run separately from the app boot. */

import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, describeConfig } from '../config';
import { createDatabase } from './client';
import { runMigrations } from './migrate';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
}

async function main(): Promise<void> {
    const config = loadConfig();
    console.log('Config:', JSON.stringify(describeConfig(config)));
    const database = createDatabase(config);
    try {
        const result = await runMigrations(database, (m) => console.log(m));
        console.log(`Done. ${result.appliedCount} migration(s) recorded.`);
    } finally {
        database.client.close();
    }
}

main().catch((err: unknown) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
