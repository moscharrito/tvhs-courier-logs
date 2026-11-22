/// <reference types="vitest/config" />
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);

/* ── THE SHEET READER'S OWN FILES, SERVED FROM OUR ORIGIN ─────────────
 *
 * The Sort page reads a telephone number off a waybill in the browser,
 * so no photograph of a patient's sheet has to be uploaded anywhere.
 * tesseract.js fetches its worker, its WebAssembly core and its language
 * model from a public CDN by default, and this app's content security
 * policy allows no CDN at all (server/src/core/http/security.ts). Under
 * that policy the default paths fail as a silent hang, not an error.
 *
 * COPIED AT BUILD TIME RATHER THAN COMMITTED. These are six megabytes of
 * binaries; a public repository does not need them in its history, and
 * resolving them through `require.resolve` means the version that ships
 * is the version in the lockfile rather than whatever was dropped in a
 * folder once.
 *
 * THE INTEGER MODEL, NOT THE LARGE ONE. 2.9MB against 11MB, over a
 * warehouse's wifi, to read ten digits off a printed line. The large one
 * earns its size on prose and scanned books.
 */
function readerAssets(): Plugin {
    const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
    const lang = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    const js = path.dirname(require.resolve('tesseract.js/package.json'));

    const files: Array<[string, string]> = [
        [path.join(js, 'dist', 'worker.min.js'), 'worker.min.js'],
        [path.join(lang, '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
    ];
    /* All three LSTM cores: which one loads is decided on the handset by
       what its processor supports -- relaxed SIMD, SIMD, or neither -- and a
       fleet of personal Android phones of unknown vintage is exactly the
       case where guessing one is wrong.
     *
     * IT IS `.wasm.js` THAT GETS LOADED, NOT `.js`, and shipping the wrong
     * one of those is how this went out broken. Each variant has three
     * files beside each other -- `.js`, `.wasm.js` and `.wasm` -- and the
     * first copy took the two with the obvious names. The worker asks for
     * `tesseract-core-simd-lstm.wasm.js` (see tesseract.js's own
     * worker-script/browser/getCore.js), which is the Emscripten glue that
     * then fetches the `.wasm` from beside itself. The plain `.js` is never
     * requested.
     *
     * The failure was a page that said "the reader could not start" with
     * nothing in it to say which file was missing, because a 404 on the
     * glue is indistinguishable from the worker never having started. */
    for (const v of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
        /* ONLY the glue. It is an Emscripten SINGLE_FILE build with the
           WebAssembly base64 inside it and it never fetches a `.wasm`, so
           copying the `.wasm` beside it shipped eight and a half megabytes
           that nothing asks for. Checked rather than assumed: the file
           contains no reference to its own `.wasm` name. */
        files.push([path.join(core, `${v}.wasm.js`), `${v}.wasm.js`]);
    }

    return {
        name: 'izy-reader-assets',
        apply: 'build',
        generateBundle() {
            for (const [from, name] of files) {
                this.emitFile({
                    type: 'asset',
                    fileName: `vendor/tesseract/${name}`,
                    source: fs.readFileSync(from),
                });
            }
        },
    };
}

// Dev: `npm run dev -w web` serves the shell on :5173 and proxies the API and
// the legacy TVHS assets to the server on :3000 (`npm run dev -w server`).
// Build: output goes to web/dist, which the server serves at / in production.
export default defineConfig({
    plugins: [react(), readerAssets()],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:3000',
            '/legacy': 'http://localhost:3000',
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}'],
        css: false,
        /* ── WHY THIS SUITE NEEDS THE SAME TREATMENT AS THE SERVER'S ───────
         *
         * On 22 November 2026 four consecutive gate runs went red and not
         * one of them failed on an assertion. Every failure was
         * `TestTimeoutError: Test timed out in 5000ms`, on a DIFFERENT test
         * each time -- ListImport, then Roster, then Reports -- and every
         * one of them passed on its own immediately afterwards. Reports
         * took 9.7 seconds for fifteen tests alone, in the same minute it
         * had "timed out" inside a run that took 370.
         *
         * That is not a slow test. It is a five-second budget on a machine
         * with two physical cores where, by Vitest's own accounting, half
         * the wall clock goes on standing up a jsdom environment per file.
         * When something else is competing -- the server suite finishing, a
         * virus scanner, a build -- a test that normally takes 80ms is
         * descheduled past five seconds and the suite calls it broken.
         *
         * THE COST OF A RED GATE NOBODY BELIEVES is the thing being fixed
         * here, not the minutes. A suite that cries wolf is one somebody
         * eventually pushes past, and it nearly happened: a timeout landed
         * in Reports.test.tsx on a day Reports.tsx had genuinely been
         * edited, and telling those apart took a separate run.
         *
         * 30 seconds matches server/vitest.config.mjs deliberately. It is
         * not a claim that any test takes thirty seconds -- it is how far a
         * loaded machine can stretch one that takes eighty milliseconds.
         * Only a test that genuinely hangs pays the difference. */
        testTimeout: 30_000,
        hookTimeout: 30_000,
        /* Same cap and the same reason as the server's. Fifty-four files,
         * each given its own isolated worker, on two physical cores: the
         * run where Stop.test.tsx never started at all was a worker that
         * could not be spawned, not a test that failed. */
        maxWorkers: 3,
    },
});
