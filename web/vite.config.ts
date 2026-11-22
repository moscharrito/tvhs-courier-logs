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
       what its processor supports, and a fleet of personal Android phones
       of unknown vintage is exactly the case where guessing one is wrong. */
    for (const v of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
        files.push([path.join(core, `${v}.js`), `${v}.js`]);
        files.push([path.join(core, `${v}.wasm`), `${v}.wasm`]);
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
