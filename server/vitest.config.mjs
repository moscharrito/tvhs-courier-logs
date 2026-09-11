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
        // Each fork boots a server, a libsql client and (for the export tests)
        // ExcelJS, so forks are heavy. Unbounded parallelism oversubscribes a
        // 4-core dev machine and makes the export tests time out; cap the pool
        // so runs are predictable.
        poolOptions: { forks: { maxForks: 3, minForks: 1 } },
        sequence: { concurrent: false },
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
