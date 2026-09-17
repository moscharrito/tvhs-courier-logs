/* Ticket 7.2: what an applicant is told about each gate.
 *
 * Pure copy logic, which is why it can be tested at all: the screens around
 * it cannot be, on a machine with no Android SDK and no way to build for iOS.
 *
 * The distinction worth pinning is between a gate the applicant can act on
 * and one they cannot. Telling somebody to chase a background check they have
 * no way to chase is how a good applicant decides this is not worth it.
 */

import { describe, it, expect } from 'vitest';
import { CHECK_COPY, checkState, outstanding, overallState, type CheckKind, type CheckStatus } from './checks';

describe('what each gate says', () => {
    it('covers every gate the server knows about', () => {
        /* If the server grows a sixth, this fails rather than the phone
           quietly rendering a blank row for it. */
        expect(Object.keys(CHECK_COPY).sort()).toEqual([
            'background_check', 'confidentiality', 'drivers_licence', 'hipaa_training', 'insurance',
        ]);
    });

    it('does not ask the applicant to chase the one we run', () => {
        expect(CHECK_COPY.background_check.yours).toBe(false);
        expect(checkState('background_check', 'pending', false)).toMatch(/Nothing for you to do/);
    });

    it('tells them plainly when it is their move, and when it is not', () => {
        expect(checkState('hipaa_training', 'pending', false)).toBe('Waiting for you.');
        expect(checkState('hipaa_training', 'pending', true)).toMatch(/Waiting for dispatch/);
    });

    it('does not dress up a failure', () => {
        expect(checkState('drivers_licence', 'failed', true)).toMatch(/did not pass/);
    });

    it('stops talking once a gate is done', () => {
        expect(checkState('insurance', 'verified', true)).toBe('Done.');
    });

    it('never uses the database word for a state', () => {
        // "pending" is a column value, not something to show a person.
        const kinds = Object.keys(CHECK_COPY) as CheckKind[];
        const statuses: CheckStatus[] = ['pending', 'verified', 'failed'];
        for (const kind of kinds) {
            for (const status of statuses) {
                for (const sent of [true, false]) {
                    expect(checkState(kind, status, sent)).not.toMatch(/pending/i);
                }
            }
        }
    });
});

describe('what is left to do', () => {
    const check = (kind: CheckKind, over: Partial<{ status: CheckStatus; submittedReference: string }> = {}) =>
        ({ kind, status: 'pending' as CheckStatus, submittedReference: '', ...over });

    it('lists only what the applicant can act on', () => {
        expect(outstanding([
            check('hipaa_training'),
            check('background_check'),
            check('insurance', { submittedReference: 'POL-1' }),
            check('drivers_licence', { status: 'verified' }),
            check('confidentiality'),
        ])).toEqual(['hipaa_training', 'confidentiality']);
    });

    it('is empty once everything of theirs is sent', () => {
        expect(outstanding([
            check('hipaa_training', { submittedReference: 'C-1' }),
            check('background_check'),
        ])).toEqual([]);
    });
});

describe('the headline', () => {
    it('does not say "waiting for you" when nothing is', () => {
        expect(overallState('submitted', false, 0)).toMatch(/The rest is with us/);
    });

    it('counts what is theirs, singular and plural', () => {
        expect(overallState('submitted', false, 1)).toBe('1 thing is waiting for you.');
        expect(overallState('submitted', false, 3)).toBe('3 things are waiting for you.');
    });

    it('does not claim approval when every gate is green', () => {
        /* Clearance is not a decision. A dispatcher still approves, and
           telling somebody they are in before that is a promise we have not
           made. */
        const text = overallState('submitted', true, 0);
        expect(text).toMatch(/Dispatch has the last word/);
        expect(text).not.toMatch(/approved/i);
    });

    it('says so once they actually are approved', () => {
        expect(overallState('approved', true, 0)).toMatch(/approved/i);
    });

    it('is plain about a rejection rather than cheerful', () => {
        expect(overallState('rejected', false, 2)).toMatch(/not taken forward/);
    });
});
