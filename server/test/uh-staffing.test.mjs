/* Putting names on the proposed runs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS WORTH TESTING HERE.
 *
 * Not "does every run get somebody". The interesting cases are the ones
 * where a plausible answer is the wrong one: a Southeast driver sent to
 * Pavilion while Southeast's own run goes to a floater, a roster that runs
 * out and drops the STAT rather than the slack work, or a dispatcher being
 * told everything is fine when a counter is short-handed.
 *
 * The shape of the roster is University Health's own, from the assignment
 * draft of 26 October 2026: twenty-three drivers hired against a home
 * pharmacy, Robert B. Green with five, Southeast with four, down to one
 * driver covering Vida and Wheatley together.
 */

import { describe, it, expect } from 'vitest';
import { staffProposal } from '../src/modules/uh/cluster.ts';

const GREEN = 1;
const SOUTHEAST = 2;
const PAVILION = 3;

/** A proposed run, with only the fields staffing reads. */
const run = (over = {}) => ({
    kind: 'standard',
    orderIds: [1],
    zips: ['78207'],
    siteIds: [GREEN],
    earliestDueAt: '2026-11-02T18:00:00.000Z',
    ...over,
});

const driver = (username, homeSiteId, name = username) => ({ username, name, homeSiteId });

describe('staffProposal', () => {
    it('gives a run to a driver whose own pharmacy it collects from', () => {
        const s = staffProposal(
            [run({ siteIds: [SOUTHEAST] })],
            [driver('zoe', GREEN), driver('grant', SOUTHEAST)],
        );
        expect(s.suggested[0]?.username).toBe('grant');
        expect(s.suggested[0]?.why).toBe('home');
        expect(s.unstaffed).toBe(0);
    });

    it('does not spend a home driver on somebody else\'s run', () => {
        /* The failure this guards: Southeast's run is offered first, a
           Green driver happens to sort earlier, and Southeast's own driver
           is then left for a Green run they have no business on. Both runs
           get staffed either way, so a test that only counted would pass. */
        const s = staffProposal(
            [run({ siteIds: [GREEN] }), run({ siteIds: [SOUTHEAST] })],
            [driver('grant', SOUTHEAST), driver('zoe', GREEN)],
        );
        expect(s.suggested[0]?.username).toBe('zoe');
        expect(s.suggested[1]?.username).toBe('grant');
        expect(s.suggested.every((x) => x?.why === 'home')).toBe(true);
    });

    it('uses a floater before taking somebody off their own counter', () => {
        const s = staffProposal(
            [run({ siteIds: [PAVILION] })],
            [driver('grant', SOUTHEAST), driver('rene', null)],
        );
        expect(s.suggested[0]?.username).toBe('rene');
        expect(s.suggested[0]?.why).toBe('floater');
    });

    it('falls back to cover, and says so rather than looking tidy', () => {
        /* A counter with nobody left is news. The dispatcher should see it
           before the wave goes out, not at four o'clock. */
        const s = staffProposal(
            [run({ siteIds: [PAVILION] })],
            [driver('grant', SOUTHEAST)],
        );
        expect(s.suggested[0]?.username).toBe('grant');
        expect(s.suggested[0]?.why).toBe('cover');
        expect(s.notes.join(' ')).toMatch(/another pharmacy/i);
    });

    it('staffs STAT first when the roster runs out', () => {
        /* THE ONE THAT MATTERS. A STAT has an hour from pickup; a scheduled
           run has until eight. If somebody has to go unstaffed it cannot be
           the STAT, whatever order the runs arrived in. */
        const s = staffProposal(
            [
                run({ kind: 'standard', earliestDueAt: '2026-11-02T20:00:00.000Z' }),
                run({ kind: 'stat', earliestDueAt: '2026-11-02T23:00:00.000Z' }),
            ],
            [driver('zoe', GREEN)],
        );
        expect(s.suggested[1]?.username).toBe('zoe');
        expect(s.suggested[0]).toBeNull();
        expect(s.unstaffed).toBe(1);
    });

    it('leaves the slackest work unstaffed, not whatever came last', () => {
        const s = staffProposal(
            [
                run({ earliestDueAt: '2026-11-02T23:00:00.000Z' }),
                run({ earliestDueAt: '2026-11-02T18:00:00.000Z' }),
            ],
            [driver('zoe', GREEN)],
        );
        expect(s.suggested[1]?.username).toBe('zoe');
        expect(s.suggested[0]).toBeNull();
    });

    it('keeps suggestions parallel to the runs it was given', () => {
        /* The sort inside carries indices precisely so the caller can zip
           these two arrays. A regression here mislabels every run on the
           screen, and each one still looks individually plausible. */
        const runs = [
            run({ orderIds: [10], siteIds: [PAVILION], earliestDueAt: '2026-11-02T23:00:00.000Z' }),
            run({ orderIds: [20], siteIds: [SOUTHEAST], earliestDueAt: '2026-11-02T18:00:00.000Z' }),
            run({ orderIds: [30], siteIds: [GREEN], kind: 'stat' }),
        ];
        const s = staffProposal(runs, [
            driver('zoe', GREEN), driver('grant', SOUTHEAST), driver('anita', PAVILION),
        ]);
        expect(s.suggested).toHaveLength(3);
        expect(s.suggested[0]?.username).toBe('anita');
        expect(s.suggested[1]?.username).toBe('grant');
        expect(s.suggested[2]?.username).toBe('zoe');
    });

    it('gives one driver at most one run', () => {
        const s = staffProposal([run(), run(), run()], [driver('zoe', GREEN)]);
        const named = s.suggested.filter(Boolean).map((x) => x.username);
        expect(named).toEqual(['zoe']);
        expect(s.unstaffed).toBe(2);
    });

    it('reports an empty roster as unstaffed rather than throwing', () => {
        const s = staffProposal([run(), run()], []);
        expect(s.unstaffed).toBe(2);
        expect(s.suggested).toEqual([null, null]);
        expect(s.notes.join(' ')).toMatch(/nobody is on shift/i);
    });

    it('says nothing about an empty roster when there is nothing to drive', () => {
        const s = staffProposal([], []);
        expect(s.notes).toEqual([]);
        expect(s.unstaffed).toBe(0);
    });

    it('does not claim the spare drivers are on shift', () => {
        /* staffProposal is given a roster and does not know what kind it
           is. When nobody has tapped Go on shift the caller plans from the
           full driver list, and "31 drivers are on shift with no run"
           printed directly under "Nobody is on shift" is a contradiction
           the dispatcher has to reason past. Seen on screen, 29 October. */
        const s = staffProposal([run()], [driver('zoe', GREEN), driver('grant', SOUTHEAST)]);
        expect(s.notes.join(' ')).not.toMatch(/on shift/i);
    });

    it('names the drivers left over, so a dispatcher can see slack', () => {
        const s = staffProposal([run()], [driver('zoe', GREEN), driver('grant', SOUTHEAST)]);
        expect(s.spare.map((d) => d.username)).toEqual(['grant']);
        expect(s.notes.join(' ')).toMatch(/not needed by this plan/i);
    });

    it('does not claim slack on a day that did not fit', () => {
        /* "1 driver is on shift with no run" beside "3 runs have no driver"
           is a contradiction a dispatcher would have to reason past. It
           cannot happen -- a spare driver would have taken a run -- but the
           note is suppressed rather than relying on that. */
        const s = staffProposal([run(), run()], [driver('zoe', GREEN)]);
        expect(s.notes.join(' ')).toMatch(/no driver/i);
        expect(s.notes.join(' ')).not.toMatch(/not needed by this plan/i);
    });

    it('handles the contract roster without leaving a counter short', () => {
        /* Twenty-three drivers as the 26 October draft assigns them, and
           one run per counter. Everybody should be on their own site. */
        const roster = [
            ...Array.from({ length: 5 }, (_, i) => driver(`green${i}`, GREEN)),
            ...Array.from({ length: 4 }, (_, i) => driver(`se${i}`, SOUTHEAST)),
            ...Array.from({ length: 3 }, (_, i) => driver(`pav${i}`, PAVILION)),
        ];
        const runs = [
            run({ siteIds: [GREEN] }), run({ siteIds: [SOUTHEAST] }), run({ siteIds: [PAVILION] }),
        ];
        const s = staffProposal(runs, roster);
        expect(s.suggested.every((x) => x?.why === 'home')).toBe(true);
        expect(s.spare).toHaveLength(9);
    });
});
