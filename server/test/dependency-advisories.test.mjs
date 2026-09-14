/* Advisories we have looked at and not fixed, and why that is still true.
 *
 * Ticket 5.9. `npm run audit` fails the build on high and above. One moderate
 * sits below that line on purpose, and "we decided it does not apply" is worth
 * nothing a year later unless something checks the reason is still the reason.
 * That is what this file is: the assessment, written as assertions, so it
 * fails when the premise moves rather than when somebody remembers to look.
 *
 *   GHSA-w5hq-g745-h8pq  uuid < 11.1.1
 *   "Missing buffer bounds check in v3/v5/v6 when buf is provided"
 *
 * exceljs pins uuid ^8.3.2 and no exceljs release moves off it: `npm audit fix
 * --force` proposes exceljs@3.4.0, which is a downgrade of the library that
 * parses pharmacy .xlsx uploads, not a fix. A root `overrides` entry is the
 * other lever, and npm 11.7 on this machine silently ignores it in a
 * workspaces tree: the lockfile comes back with no overrides recorded and
 * uuid still at 8.3.2, so it would be a change that looks like a fix in the
 * manifest and is not one on disk.
 *
 * What makes it moot is narrower than either: the vulnerable functions are
 * v3, v5 and v6, and only when a caller passes a `buf` argument. exceljs uses
 * v4, in one file, with no arguments, to mint conditional-formatting ids. The
 * vulnerable code is present and unreachable.
 *
 * Both halves of that are checked below, because both can change under us: a
 * future exceljs could start calling v5, and we could start using uuid
 * ourselves. Either would make this an advisory that applies, and the answer
 * then is to move exceljs off uuid or to move off exceljs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_DIR } from './helpers/server.mjs';

const ROOT = path.resolve(SERVER_DIR, '..');

function jsFilesUnder(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFilesUnder(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** Every `identifier(` call in a file, as a set of identifiers. */
function callsIn(source) {
    return new Set([...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
}

describe('GHSA-w5hq-g745-h8pq: uuid, through exceljs', () => {
    const exceljsLib = path.join(ROOT, 'node_modules', 'exceljs', 'lib');

    it('is still reached only through exceljs, and not by anything we wrote', () => {
        /* If we ever take a direct dependency on uuid, the version we get is
           ours to choose and this whole assessment stops applying. */
        const ours = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) ours.push(full);
            }
        };
        walk(path.join(SERVER_DIR, 'src'));
        walk(path.join(ROOT, 'web', 'src'));

        const importers = ours.filter((f) => /require\(['"]uuid['"]\)|from ['"]uuid['"]/.test(fs.readFileSync(f, 'utf8')));
        expect(importers).toEqual([]);
    });

    it('is used by exceljs in exactly one file', () => {
        const users = jsFilesUnder(exceljsLib)
            .filter((f) => /require\(['"]uuid['"]\)/.test(fs.readFileSync(f, 'utf8')))
            .map((f) => path.relative(exceljsLib, f).replace(/\\/g, '/'));
        expect(users).toEqual(['xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js']);
    });

    it('uses v4 only, which is not one of the affected functions', () => {
        const file = path.join(exceljsLib, 'xlsx', 'xform', 'sheet', 'cf-ext', 'cf-rule-ext-xform.js');
        const source = fs.readFileSync(file, 'utf8');

        // Destructured as v4 and nothing else.
        const destructure = source.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]uuid['"]\)/);
        expect(destructure).not.toBeNull();
        expect(destructure[1].replace(/\s/g, '')).toBe('v4:uuidv4');

        // And none of the affected functions is called under any name.
        const called = callsIn(source);
        for (const affected of ['v3', 'v5', 'v6']) expect(called.has(affected)).toBe(false);
    });

    it('never passes the buf argument the advisory is about', () => {
        /* The bounds check that is missing is only reachable when a caller
           supplies a buffer to write into. Every call here is bare. */
        const file = path.join(exceljsLib, 'xlsx', 'xform', 'sheet', 'cf-ext', 'cf-rule-ext-xform.js');
        const source = fs.readFileSync(file, 'utf8');
        const calls = [...source.matchAll(/uuidv4\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((args) => args === '')).toBe(true);
    });
});

describe('the audit gate', () => {
    it('fails the build on high and above, which is the line this sits under', () => {
        const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(root.scripts.audit).toBe('npm audit --omit=dev --audit-level=high');
    });

    it('has no overrides, because npm 11.7 ignores them here and a fix that is not applied is worse than none', () => {
        /* Left as a deliberate absence rather than a comment nobody reads: an
           overrides block in this manifest would read as a fix that is in
           place. It is not, on this npm, in this tree. */
        const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(root.overrides).toBeUndefined();
    });
});
