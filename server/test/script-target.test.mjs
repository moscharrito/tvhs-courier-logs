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
        for (const databaseUrl of ['', null, undefined]) {
            const got = checkTarget({ databaseUrl, wantsProduction: true });
            expect(got.ok).toBe(false);
            expect(got.message).toContain('unset');
        }
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
