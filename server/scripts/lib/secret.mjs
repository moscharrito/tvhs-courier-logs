/* Ask for a password without putting it anywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THESE SCRIPTS ASK AT ALL.
 *
 * The scripts that write to production used to require SEED_ADMIN_PASS in
 * the environment. An exported admin password then stays live for every
 * later command in that shell -- including the clear:work the dry run
 * prints at the end, which is the single command you least want to fire at
 * the wrong server. Asking, using it once and storing nothing is better.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS FILE EXISTS BECAUSE OF.
 *
 * This was copied into three scripts, and all three shared one defect: the
 * promise resolved only from readline's answer callback. With no terminal on
 * stdin -- `npm run` through cmd.exe on Windows, a pipe, CI, a terminal pane
 * that does not forward one -- readline reaches end of input, fires `close`
 * and never answers. Nothing rejected and nothing resolved, so Node printed
 *
 *     Warning: Detected unsettled top-level await at ... dry-run.mjs:92
 *
 * and exited 13 under the prompt it had just drawn. The operator sees a
 * password prompt, then a crash, and nothing saying which of the two is the
 * problem.
 *
 * So: the absence of a terminal is detected BEFORE anything is drawn, and
 * answered with the two ways out rather than a prompt into the void. And
 * `close` resolves, so even an unforeseen route to end-of-input produces an
 * empty answer the caller can refuse, never a hang.
 */

import readline from 'node:readline';
import { Writable } from 'node:stream';

/** Is there a terminal to ask on? Both halves matter: the question has to be
 *  drawn somewhere and the answer has to be typed somewhere. */
export function canAsk() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ask for a secret with the echo off. Never stored, never printed.
 *
 * Resolves to '' when there is nothing to read, so every caller's existing
 * "no password given" branch covers end of input too.
 */
export function askSecret(prompt) {
    if (!canAsk()) return Promise.resolve('');

    return new Promise((resolve) => {
        let done = false;
        /* Once. `close` fires after `question` answers, and resolving twice
           is harmless but resolving with '' after a real answer is not. */
        const settle = (value) => {
            if (done) return;
            done = true;
            resolve(value);
        };

        let muted = false;
        const out = new Writable({
            write(chunk, _enc, cb) {
                if (!muted) process.stdout.write(chunk);
                cb();
            },
        });

        const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
        rl.on('close', () => {
            /* Ctrl-C, Ctrl-D, or input that ended. The newline is ours: the
               echo is off, so the terminal's cursor is still sitting at the
               end of the prompt and whatever prints next would land on it. */
            process.stdout.write('\n');
            settle('');
        });
        rl.question(prompt, (answer) => {
            process.stdout.write('\n');
            settle(answer);
            rl.close();
        });
        muted = true;
    });
}

/**
 * The password for a run, from the environment or from the operator.
 *
 * `label` names the command in the advice, so the message says the thing the
 * reader should actually type rather than a generic instruction.
 */
export async function adminPassword({ user, base, isLocal, label, askLocally = false }) {
    const fromEnv = process.env['SEED_ADMIN_PASS'];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

    /* Locally the default is to hand back nothing rather than stop a
       developer with a prompt: dry-run is run dozens of times a day against
       a machine whose admin password is in .env, and the login's own 401 is
       a clearer answer than a question. portal-upload opts in because it is
       a single deliberate act either way round. */
    if (isLocal && !askLocally) return '';
    if (isLocal) return canAsk() ? askSecret(`Password for ${user} on ${base}: `) : '';

    if (!canAsk()) {
        console.error('');
        console.error('  No terminal to ask for a password on.');
        console.error('');
        console.error('  This happens when the script is run through `npm run` on Windows,');
        console.error('  which puts a cmd.exe between your terminal and node. Two ways out:');
        console.error('');
        console.error(`    node server/scripts/${label} --base ${base} --i-mean-production ...`);
        console.error('');
        console.error('  or, if you are scripting it and accept that the password stays in');
        console.error('  the environment for the rest of the session:');
        console.error('');
        console.error('    SEED_ADMIN_PASS=... npm run ...');
        console.error('');
        return '';
    }

    return askSecret(`Password for ${user} on ${base}: `);
}
