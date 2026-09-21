/* The TVHS driver's day.
 *
 * The rules worth pinning are the ones that decide whether a half-filled
 * sheet can be saved, because a screen that refuses until every row is full
 * is a screen that gets filled with zeroes.
 */

import { describe, it, expect } from 'vitest';
import {
    emptyLeg, legIsEmpty, legsForRoute, legsFromSaved, parseYmd, problemsIn, toPayload,
    totals, totesOf, weekLabel, weekOf, weekSummary, ymd,
    type Leg, type Routes,
} from './tvhs';

const ROUTES: Routes = {
    northbound: {
        label: 'NorthBound',
        legs: [
            { from: 'Murfreesboro', to: 'Clarksville', defaultMiles: 80 },
            { from: 'Clarksville', to: 'Fort Campbell', defaultMiles: 15 },
        ],
    },
};

const filled = (over: Partial<Leg> = {}): Leg => ({
    legFrom: 'Murfreesboro', legTo: 'Clarksville',
    startTime: '08:00', endTime: '09:20', sterile: '4', soiled: '2', miles: '80',
    ...over,
});

describe('the day a driver starts with', () => {
    it('fills in the route, and only the route', () => {
        /* From, to and the usual mileage are fixed and awkward to type in a
           moving van. Times and totes are what happened, and a prefilled
           number is a number nobody checks. */
        const legs = legsForRoute(ROUTES, 'northbound');
        expect(legs).toHaveLength(2);
        expect(legs[0]).toMatchObject({ legFrom: 'Murfreesboro', legTo: 'Clarksville', miles: '80' });
        expect(legs[0]!.startTime).toBe('');
        expect(legs[0]!.sterile).toBe('');
    });

    it('gives one blank leg for a route it does not know', () => {
        expect(legsForRoute(ROUTES, 'nope')).toHaveLength(1);
    });
});

describe('a day that was already saved', () => {
    it('comes back in leg order, whatever order the rows arrived in', () => {
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 1, leg_from: 'B', leg_to: 'C', start_time: '10:00', end_time: '10:30', sterile: 1, soiled: 0, miles: 15 },
            { date: '2026-09-20', leg_index: 0, leg_from: 'A', leg_to: 'B', start_time: '08:00', end_time: '09:00', sterile: 4, soiled: 2, miles: 80 },
        ]);
        expect(legs.map((l) => l.legFrom)).toEqual(['A', 'B']);
    });

    it('keeps a zero the driver wrote rather than blanking it', () => {
        /* Zero soiled totes is a fact about the day. An empty box is not. */
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 0, leg_from: 'A', leg_to: 'B', start_time: '08:00', end_time: '09:00', sterile: 0, soiled: 0, miles: 80 },
        ]);
        expect(legs[0]!.soiled).toBe('0');
    });
});

describe('which legs count as done', () => {
    it('treats a leg with only its prefilled mileage as untouched', () => {
        /* The route fills the mileage in, so mileage alone means nobody
           drove it. Otherwise every unused leg would save as a journey. */
        expect(legIsEmpty({ ...emptyLeg(), legFrom: 'A', legTo: 'B', miles: '80' })).toBe(true);
    });

    it('counts a leg with any time or tote on it', () => {
        expect(legIsEmpty(filled({ startTime: '', endTime: '', soiled: '', sterile: '1' }))).toBe(false);
        expect(legIsEmpty(filled({ sterile: '', soiled: '', endTime: '', startTime: '08:00' }))).toBe(false);
    });
});

describe('what stops a day being saved', () => {
    it('lets a half-finished sheet through', () => {
        /* Four legs of six is an ordinary day. Refusing it is how a sheet
           ends up full of zeroes. */
        const legs = [filled(), { ...emptyLeg(), legFrom: 'C', legTo: 'D', miles: '15' }];
        expect(problemsIn(legs)).toEqual([]);
    });

    it('catches a time that is not a time', () => {
        const out = problemsIn([filled({ startTime: '8am' })]);
        expect(out).toHaveLength(1);
        expect(out[0]!.message).toMatch(/should look like 14:30/);
    });

    it('accepts both 8:05 and 08:05, and refuses 25:00', () => {
        expect(problemsIn([filled({ startTime: '8:05' })])).toEqual([]);
        expect(problemsIn([filled({ startTime: '08:05' })])).toEqual([]);
        expect(problemsIn([filled({ startTime: '25:00' })])).toHaveLength(1);
        expect(problemsIn([filled({ endTime: '10:75' })])).toHaveLength(1);
    });

    it('catches a tote count that is not a number', () => {
        expect(problemsIn([filled({ sterile: 'four' })])[0]!.message).toMatch(/Sterile on leg 1/);
    });

    it('allows a decimal mileage', () => {
        expect(problemsIn([filled({ miles: '12.5' })])).toEqual([]);
    });

    it('ignores rubbish in a leg nobody drove', () => {
        /* A blank leg still carrying the route default is not a problem to
           report at somebody. */
        expect(problemsIn([{ ...emptyLeg(), miles: '80' }])).toEqual([]);
    });
});

describe('the totals a driver checks before saving', () => {
    it('adds up only the legs that were driven', () => {
        const out = totals([filled(), filled({ sterile: '1', soiled: '1', miles: '15' }), { ...emptyLeg(), miles: '80' }]);
        expect(out).toEqual({ legs: 2, sterile: 5, soiled: 3, miles: 95 });
    });

    it('does not produce 189.99999 for 80 + 15 + 15 + 80', () => {
        const legs = [80, 15, 15, 80].map((m) => filled({ miles: String(m) }));
        expect(totals(legs).miles).toBe(190);
    });
});

describe('what is sent', () => {
    it('drops the legs nobody drove', () => {
        const payload = toPayload('2026-09-20', [filled(), { ...emptyLeg(), miles: '80' }]);
        expect(payload.legs).toHaveLength(1);
        expect(payload.date).toBe('2026-09-20');
    });

    it('trims what was typed', () => {
        const payload = toPayload('2026-09-20', [filled({ startTime: ' 08:00 ', sterile: ' 4 ' })]);
        expect(payload.legs[0]).toMatchObject({ startTime: '08:00', sterile: '4' });
    });
});

describe('the week, copied from the web rather than reasoned out', () => {
    it('runs Monday to Friday', () => {
        /* Aug 31 2026 is a Monday; the web shows "Aug 31, 2026 — Sep 4, 2026". */
        const week = weekOf('2026-09-02');
        expect(week).toHaveLength(5);
        expect(week[0]).toMatchObject({ date: '2026-08-31', dayName: 'Monday', dayOfMonth: 31 });
        expect(week[4]).toMatchObject({ date: '2026-09-04', dayName: 'Friday', dayOfMonth: 4 });
        expect(weekLabel(week)).toBe('Aug 31, 2026 — Sep 4, 2026');
    });

    it('puts a Sunday in the week that is ending, not the one starting', () => {
        /* Straight from app.js: day === 0 ? -6 : 1. Getting this wrong would
           file a Sunday against the wrong week, and the two clients would
           disagree about the same sheet. */
        const week = weekOf('2026-09-06');
        expect(week[0]!.date).toBe('2026-08-31');
        expect(week[4]!.date).toBe('2026-09-04');
    });

    it('takes a Monday as the start of its own week', () => {
        expect(weekOf('2026-08-31')[0]!.date).toBe('2026-08-31');
    });

    it('does not slip a day through a timezone', () => {
        /* new Date('2026-09-02') is UTC midnight, which is the previous day
           anywhere west of Greenwich. This runs in Texas. */
        expect(ymd(parseYmd('2026-09-02'))).toBe('2026-09-02');
        expect(weekOf('2026-01-01')[0]!.date).toBe('2025-12-29');
    });
});

describe('the totes column and the weekly summary', () => {
    it('computes totes as sterile plus soiled, like the web', () => {
        expect(totesOf(filled({ sterile: '4', soiled: '2' }))).toBe(6);
        expect(totesOf(filled({ sterile: '', soiled: '' }))).toBe(0);
    });

    it('adds up the week the way the summary cards do', () => {
        const out = weekSummary({
            '2026-08-31': [filled(), filled({ miles: '15', sterile: '1', soiled: '1' })],
            '2026-09-01': [filled({ miles: '35', sterile: '0', soiled: '3' })],
            '2026-09-02': [{ ...emptyLeg(), miles: '80' }],
        });
        expect(out.days, 'a day with only prefilled mileage is not a day logged').toBe(2);
        expect(out.routes).toBe(3);
        expect(out.miles).toBe(130);
        expect(out.totes).toBe(6 + 2 + 3);
    });
});
