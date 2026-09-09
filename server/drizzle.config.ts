/* drizzle-kit configuration. Used for `drizzle-kit generate` only; the app
   applies migrations itself (src/db/migrate.ts) so no database credentials
   are needed here. */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'turso',
    schema: './src/db/schema/index.ts',
    out: './drizzle',
    strict: true,
    verbose: true,
});
