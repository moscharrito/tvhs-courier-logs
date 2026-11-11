/* Which database a script is about to answer about.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RUN THAT MADE THIS NECESSARY.
 *
 * 9 November. Two pay scripts were run against production to find out
 * whether couriers had been underpaid for a week:
 *
 *   npm run measure:zones  -w server -- --i-mean-production
 *   npm run backfill:zones -w server -- --from 2026-11-01 --i-mean-production
 *
 * The shell had no Turso variables set. Both scripts read the laptop's
 * development database and reported, in a calm banner, "0 of 9 pharmacies
 * have coordinates", "0 orders in range" and "Nobody is owed." Every line
 * was true about a database nobody had asked about.
 *
 * --i-mean-production had been written as a PERMISSION -- do not touch Turso
 * without it -- and the operator typing it means it as an ASSERTION: the
 * thing I am about to read is production. Only the first half existed.
 *
 * These are four lines of logic and they are tested because the failure is
 * silent, confident, and about money.
 */

import { describe, it, expect } from 'vitest';
import { checkTarget, isProduction } from '../scripts/lib/target.mjs';

const TURSO = 'libsql://izy-logs-moscharrito.turso.io';
const LOCAL = 'file:local.db';

describe('what counts as production', () => {
    it('is a Turso connection string and nothing else', () => {
        expect(isProduction(TURSO)).toBe(true);
        expect(isProduction(LOCAL)).toBe(false);
        expect(isProduction('')).toBe(false);
        expect(isProduction(null)).toBe(false);
        expect(isProduction(undefined)).toBe(false);
    });
});

describe('checkTarget', () => {
    it('lets a local run proceed', () => {
        expect(checkTarget({ databaseUrl: LOCAL, wantsProduction: false }))
            .toEqual({ ok: true, live: false });
    });

    it('lets a deliberate production run proceed', () => {
        expect(checkTarget({ databaseUrl: TURSO, wantsProduction: true }))
            .toEqual({ ok: true, live: true });
    });

    /* The guard that already existed: no accidental writes to production. */
    it('refuses production that was not asked for', () => {
        const got = checkTarget({ databaseUrl: TURSO, wantsProduction: false });
        expect(got.ok).toBe(false);
        expect(got.message).toContain('--i-mean-production');
    });

    /* ── THE ONE THAT WAS MISSING, AND THE WHOLE REASON FOR THIS FILE. */
    it('refuses to answer about a laptop when production was asked for', () => {
        const got = checkTarget({ databaseUrl: LOCAL, wantsProduction: true });
        expect(got.ok).toBe(false);
        expect(got.message).toContain('is NOT production');
        /* It has to say what to do next: the operator is three environment
           variables away and will otherwise just run it again. */
        expect(got.message).toContain('TURSO_DATABASE_URL');
        expect(got.message).toContain('ALLOW_TURSO_OUTSIDE_PRODUCTION');
    });

    it('says so even when there is no connection string at all', () => {
        /* undefined is no longer in this list: it now means the CALLER is
           wrong rather than the environment, and says so in its own words.
           See the test below, which is the one that would have caught the
           12 November bug. */
        for (const databaseUrl of ['', null]) {
            const got = checkTarget({ databaseUrl, wantsProduction: true });
            expect(got.ok).toBe(false);
            expect(got.message).toContain('unset');
        }
    });

    /* ─────────────────────────────────────────────────────────────────
     * A GUARD DISARMED BY A TYPO IN THE CALL (12 November 2026).
     *
     * measure-pay-zones.mjs and backfill-pay-zones.mjs both passed
     * `config.databaseUrl`, which has never been a field on the config --
     * it is `config.db.url`. So checkTarget was handed undefined on every
     * run, and the failure was not in the safe direction:
     *
     *   WITH --i-mean-production   it refused always, which is what finally
     *                              made somebody look.
     *   WITHOUT the flag           undefined is not production and
     *                              production was not asked for, so it
     *                              returned ok -- and createDatabase(config)
     *                              then went to config.db.url, which IS
     *                              Turso. The script would have written to
     *                              production believing it was a laptop.
     *
     * This module was written on 9 November precisely to stop a script
     * answering confidently about the wrong database. It was correct and it
     * was tested. Both callers wired it to nothing, and nothing said so.
     * ───────────────────────────────────────────────────────────────── */
    it('refuses undefined as a caller bug, not as an unset environment', () => {
        const got = checkTarget({ databaseUrl: undefined, wantsProduction: true });
        expect(got.ok).toBe(false);
        expect(got.message).toContain('does not exist');
        /* Names the field, because the person reading this is in a script
           and the fix is one identifier. */
        expect(got.message).toContain('config.db.url');
        /* And does NOT send them off to set environment variables that are
           already perfectly fine. */
        expect(got.message).not.toContain('TURSO_DATABASE_URL');
    });

    it('refuses undefined in the unguarded direction too, which was the dangerous one', () => {
        /* No flag. Before the fix this returned ok and the script ran on
           against whatever config.db.url happened to be. */
        const got = checkTarget({ databaseUrl: undefined, wantsProduction: false });
        expect(got.ok).toBe(false);
    });

    /* A refusal must never read as a result. Nothing in either message may
       look like an answer to the question that was asked. */
    it('never reports a count in a refusal', () => {
        for (const c of [
            { databaseUrl: TURSO, wantsProduction: false },
            { databaseUrl: LOCAL, wantsProduction: true },
        ]) {
            const got = checkTarget(c);
            expect(got.message).not.toMatch(/\b0 (orders|of)\b/);
            expect(got.message).not.toMatch(/Nobody is owed/);
        }
    });
});

/* THE FIELD THE CALLERS READ HAS TO EXIST.
 *
 * script-target.test.mjs tested checkTarget in isolation and passed
 * throughout, because the bug was never in checkTarget. It was in what the
 * callers handed it. This is the cheapest assertion that would have caught
 * it: the shape the scripts read, read the same way they read it. */
describe('the config field the scripts pass to it', () => {
    it('is db.url, and there is no databaseUrl', async () => {
        /* The one value loadConfig refuses to boot without. Nothing else is
           set, so this reads the same defaults a script picks up when
           somebody runs it with no environment at all -- which is exactly
           the situation the bug hid in. */
        const had = process.env['SESSION_SECRET'];
        process.env['SESSION_SECRET'] = 'test-session-secret-for-config-shape';
        const { loadConfig } = await import('../src/config.ts');
        const config = loadConfig();
        if (had === undefined) delete process.env['SESSION_SECRET'];
        else process.env['SESSION_SECRET'] = had;
        expect(typeof config.db.url).toBe('string');
        expect(config.db.url.length).toBeGreaterThan(0);
        /* If this ever becomes defined, the comment in measure-pay-zones.mjs
           and backfill-pay-zones.mjs is wrong and one of them is reading the
           other field by accident again. */
        expect(config.databaseUrl).toBeUndefined();
    });
});
