import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.mjs'],
        globalSetup: ['./test/helpers/global-setup.mjs'],
        // Each test file requires server.js in-process against its own DB and
        // port. Forks give every file a separate process, so module-level state
        // (PIN throttle, libsql client) cannot leak between files. Tests inside
        // a file run in order.
        pool: 'forks',
        fileParallelism: true,
        sequence: { concurrent: false },
        testTimeout: 20000,
        hookTimeout: 30000,
    },
});
