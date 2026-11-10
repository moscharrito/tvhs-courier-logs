/* Which database a script is about to talk to, and whether that is the one
 * the operator asked for.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT TWO COPIES OF AN IF.
 *
 * `--i-mean-production` was written as PERMISSION: refuse to touch Turso
 * unless the flag is there. To the person typing it, it is also an
 * ASSERTION -- "the thing I am about to read is production".
 *
 * On 9 November both meanings were needed and only one existed. The flag was
 * passed in a shell with no Turso variables set, and two scripts answered
 * cheerfully about the laptop's development database: "0 of 9 pharmacies
 * have coordinates", "0 orders in range", "Nobody is owed." The question
 * being asked was whether couriers had been underpaid for a week. The answer
 * looked like "no" and was about nothing at all.
 *
 * A wrong answer delivered confidently is worse than no answer, and this is
 * the second time that sentence has had to be written in this repository.
 * So the check goes in one place, it is pure, and it is tested.
 */

/** Does this connection string point at Turso rather than a local file? */
export function isProduction(databaseUrl) {
    return String(databaseUrl ?? '').startsWith('libsql://');
}

/**
 * Whether a script may proceed against the database it actually has.
 *
 * Returns `{ ok: true }`, or `{ ok: false, message }` with something the
 * operator can act on. Never throws and never exits: the caller decides what
 * to do, which keeps this testable without spawning anything.
 */
export function checkTarget({ databaseUrl, wantsProduction }) {
    const live = isProduction(databaseUrl);

    /* The original guard: do not write to production by accident. */
    if (live && !wantsProduction) {
        return {
            ok: false,
            live,
            message: 'This points at a Turso database. Add --i-mean-production if that is what you meant.',
        };
    }

    /* And the one that was missing. Asking for production and silently
       getting a laptop is how a reassuring answer gets reported about the
       wrong data. */
    if (!live && wantsProduction) {
        return {
            ok: false,
            live,
            message: [
                '',
                '  REFUSING: --i-mean-production was passed, and this is NOT production.',
                `  The connection string is ${databaseUrl ? 'a local file' : 'unset'}, so this would have`,
                '  read the development database on this laptop and told you about that.',
                '',
                '  Set these first, in THIS shell, then run it again:',
                '',
                "    $env:ALLOW_TURSO_OUTSIDE_PRODUCTION = 'true'",
                "    $env:TURSO_DATABASE_URL = 'libsql://...'",
                "    $env:TURSO_AUTH_TOKEN = '...'",
                '',
                '  Drop --i-mean-production to work against this laptop deliberately.',
                '',
            ].join('\n'),
        };
    }

    return { ok: true, live };
}
