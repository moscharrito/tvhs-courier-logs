/* A shell in the Browser pane, as a clickable entry in the servers list.
 *
 * Added at the owner's explicit request, after the exposure below was
 * raised and accepted. `preview_start` with the name "terminal".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS SERVES AN INTERACTIVE SHELL OVER HTTP. Read that before changing
 * anything below, because three flags are the only thing between a
 * convenience and a remote shell on a machine that holds:
 *
 *   server/.env             real local credentials and SESSION_SECRET
 *   server/courier_logs.db  real email addresses and bcrypt hashes
 *   the git checkout        92 commits that have never been pushed
 *
 * -i 127.0.0.1   Loopback ONLY. ttyd binds every interface by default, and
 *                this laptop changed network twice in one afternoon. Bound
 *                to 0.0.0.0 on a network nobody here controls, this is an
 *                unauthenticated shell for everybody on it. Do not
 *                "temporarily" widen this to reach it from a phone.
 *
 * -c user:pass   Basic auth, read from a gitignored file, and this process
 *                REFUSES TO START without one. Loopback alone is not quite
 *                enough: a hostile page in a browser on this same machine
 *                can reach 127.0.0.1, and DNS rebinding exists.
 *
 * -W             Writable. Without it ttyd is a read-only view of a shell
 *                nobody can type into, and with it anybody who reaches the
 *                page runs anything as this user. It is here deliberately.
 * ───────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIAL_FILE = path.join(here, 'ttyd-credential');
const PORT = 7681;

/* Generated once into a gitignored file rather than written into
   launch.json, which is committed alongside the other servers. There is no
   no-credential path: a missing file makes one instead of starting open. */
function credential() {
    if (fs.existsSync(CREDENTIAL_FILE)) {
        const existing = fs.readFileSync(CREDENTIAL_FILE, 'utf8').trim();
        if (existing.includes(':')) return existing;
    }
    const made = `izy:${randomBytes(18).toString('base64url')}`;
    fs.writeFileSync(CREDENTIAL_FILE, made + '\n', { mode: 0o600 });
    console.log('Generated a new credential in .claude/ttyd-credential');
    return made;
}

/* winget puts a shim in Links and the binary under Packages. Try the shim,
   then PATH, and say something useful rather than failing with ENOENT. */
function ttydPath() {
    const shim = path.join(
        process.env['LOCALAPPDATA'] ?? '',
        'Microsoft', 'WinGet', 'Links', 'ttyd.exe',
    );
    return fs.existsSync(shim) ? shim : 'ttyd';
}

const cred = credential();
const [user, pass] = cred.split(':');
if (!user || !pass) {
    console.error('.claude/ttyd-credential is malformed. Expected user:password. Refusing to start without auth.');
    process.exit(1);
}

console.log(`Terminal on http://127.0.0.1:${PORT}`);
console.log(`  username: ${user}`);
console.log(`  password: ${pass}`);
console.log('  loopback only; credential in .claude/ttyd-credential, which is gitignored');

const child = spawn(
    ttydPath(),
    [
        '--port', String(PORT),
        '--interface', '127.0.0.1',
        '--credential', cred,
        '--writable',
        'powershell.exe', '-NoLogo',
    ],
    { stdio: 'inherit', cwd: path.resolve(here, '..') },
);

child.on('error', (err) => {
    if (err.code === 'ENOENT') {
        console.error('ttyd is not installed. Install it with: winget install --id tsl0922.ttyd --exact');
        process.exit(1);
    }
    throw err;
});
child.on('exit', (code) => process.exit(code ?? 0));
