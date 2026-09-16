/* Tickets 6.1 and 6.2: the rule that stands between a submitted form and a
 * patient's address.
 *
 * This is the pure half. It is a pure function on purpose, so that the answer
 * to "who decided this person could see patient data" is a table of recorded
 * facts and not somebody's judgement at six on a Friday.
 */

import { describe, it, expect } from 'vitest';
import { CHECK_KINDS, clearanceOf } from '../src/core/onboarding/clearance.ts';

const TODAY = '2026-09-16';

/** Every gate green, so each test can spoil exactly one thing. */
const allGood = (over = {}) => CHECK_KINDS.map((kind) => ({
    kind,
    status: 'verified',
    verifiedBy: 'dee.dispatch',
    verifiedAt: '2026-09-01T12:00:00.000Z',
    expiresAt: null,
    ...(over[kind] ?? {}),
}));

describe('clearance', () => {
    it('passes only when all five are verified and current', () => {
        const c = clearanceOf(allGood(), TODAY);
        expect(c.ready).toBe(true);
        expect(c.missing).toEqual([]);
        expect(c.expired).toEqual([]);
        expect(c.failed).toEqual([]);
    });

    it('refuses an empty application, which is what a new signup is', () => {
        /* The default state of a person who has just filled in the form is
           five pending checks and no access to anything. */
        const c = clearanceOf([], TODAY);
        expect(c.ready).toBe(false);
        expect(c.missing).toEqual([...CHECK_KINDS]);
    });

    it('refuses when any single gate is missing, and names it', () => {
        for (const kind of CHECK_KINDS) {
            const checks = allGood().filter((c) => c.kind !== kind);
            const c = clearanceOf(checks, TODAY);
            expect(c.ready, `${kind} missing should refuse`).toBe(false);
            expect(c.missing).toEqual([kind]);
        }
    });

    it('treats pending as missing, not as a maybe', () => {
        const c = clearanceOf(allGood({ background_check: { status: 'pending', verifiedBy: '' } }), TODAY);
        expect(c.ready).toBe(false);
        expect(c.missing).toEqual(['background_check']);
    });

    it('treats a failed check as its own answer, louder than missing', () => {
        const c = clearanceOf(allGood({ background_check: { status: 'failed' } }), TODAY);
        expect(c.ready).toBe(false);
        expect(c.failed).toEqual(['background_check']);
        expect(c.missing).toEqual([]);
        expect(c.why).toMatch(/did not pass/);
    });

    it('stops trusting training that has expired', () => {
        /* The quiet one. A verified row stays verified forever unless
           somebody checks the date, and HIPAA training from three years ago
           is a filename. */
        const c = clearanceOf(allGood({ hipaa_training: { expiresAt: '2026-09-15' } }), TODAY);
        expect(c.ready).toBe(false);
        expect(c.expired).toEqual(['hipaa_training']);
        expect(c.why).toMatch(/expired/);
    });

    it('counts the expiry date itself as still valid', () => {
        // A licence is valid through its expiry date, not until the day before.
        const c = clearanceOf(allGood({ drivers_licence: { expiresAt: TODAY } }), TODAY);
        expect(c.ready).toBe(true);
    });

    it('separates expired from missing, because they are different conversations', () => {
        const c = clearanceOf(
            allGood({ hipaa_training: { expiresAt: '2020-01-01' }, insurance: { status: 'pending' } }),
            TODAY,
        );
        expect(c.expired).toEqual(['hipaa_training']);
        expect(c.missing).toEqual(['insurance']);
        expect(c.why).toMatch(/expired/);
        expect(c.why).toMatch(/not recorded yet/);
    });

    it('says what it costs, because the reader is deciding whether to argue', () => {
        expect(clearanceOf([], TODAY).why).toMatch(/Nobody reads a patient's address until all five are green/);
    });

    it('compares dates as text, so no timezone can drag one across midnight', () => {
        /* Three places in this codebase once computed a date with
           toISOString() and printed tomorrow, one of them on an invoice sent
           to University Health. Both sides here are YYYY-MM-DD, which sorts
           correctly as text and never meets a Date constructor. */
        const c = clearanceOf(allGood({ insurance: { expiresAt: '2026-12-31' } }), '2026-09-16');
        expect(c.ready).toBe(true);
        expect(clearanceOf(allGood({ insurance: { expiresAt: '2026-09-16' } }), '2026-09-17').ready).toBe(false);
    });
});
