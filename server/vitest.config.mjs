import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        /* The suite is integration-style: every file under test/ boots a
           server and talks to it over HTTP, which is the right shape for
           almost everything here. The second pattern is for the few modules
           worth exercising on their own -- core/notify/http-mail.ts is one,
           because stubbing an external mail provider through a booted server
           is more scaffolding than the thing being tested.
        
           NOTE the glob is not written in this comment: a path containing a
           star followed by a slash closes the comment early, which is what
           it did the first time and cost a confusing esbuild parse error. */
        include: ['test/**/*.test.mjs', 'src/**/*.test.ts'],
        globalSetup: ['./test/helpers/global-setup.mjs'],
        /* EVERY RUN IS UTC, INCLUDING ON A LAPTOP IN TEXAS.
         *
         * A date-time string with no Z is parsed in the host's timezone. The
         * simulator built its after-hours deliveries that way, and on CI every
         * 20:15 became 15:15 in San Antonio, so a simulated day contained no
         * after-hours work at all. Two days of red CI that no local run could
         * reproduce, and the local runs were not right either: this machine is
         * an hour off the project's zone, and the test it fooled was passing
         * on a random spread rather than on the clock.
         *
         * UTC rather than a deliberately strange zone, because the point is
         * that a green run here means a green run there. The whole suite was
         * checked under UTC before this was pinned; nothing else depended on
         * the host clock. */
        env: { TZ: 'UTC' },
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
