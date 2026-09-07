/* Vitest global setup. Runs once per `vitest` invocation in the main process.
   The teardown removes test/.tmp after every worker fork has exited, which is
   the only point at which Windows has released the SQLite file handles. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp');

export function setup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return () => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    };
}
