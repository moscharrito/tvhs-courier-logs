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
    },
});
