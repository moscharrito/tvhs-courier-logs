import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.mjs'],
        // Each test file boots its own server process on its own DB and port,
        // so files can run in parallel; tests inside a file run in order.
        fileParallelism: true,
        sequence: { concurrent: false },
        testTimeout: 20000,
        hookTimeout: 30000,
    },
});
