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
    it('fills in the labels and not one number', () => {
        /* From and to are fixed and awkward to type in a moving van, so the
           route supplies them. Mileage is not: it used to be prefilled from
           defaultMiles and the owner asked for that to stop, which also puts
           this back in step with the web, where an unsaved leg starts empty.
           A prefilled number is a number nobody checks. */
        const legs = legsForRoute(ROUTES, 'northbound');
        expect(legs).toHaveLength(2);
        expect(legs[0]).toMatchObject({ legFrom: 'Murfreesboro', legTo: 'Clarksville', miles: '' });
        expect(legs[0]!.startTime).toBe('');
        expect(legs[0]!.sterile).toBe('');
    });

    it('gives one blank leg for a route it does not know', () => {
        expect(legsForRoute(ROUTES, 'nope')).toHaveLength(1);
    });
});

describe('a day that was already saved', () => {
    const NB = ROUTES['northbound']!.legs;

    it('comes back in leg order, whatever order the rows arrived in', () => {
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 1, leg_from: '', leg_to: '', start_time: '10:00', end_time: '10:30', sterile: 1, soiled: 0, miles: 15 },
            { date: '2026-09-20', leg_index: 0, leg_from: '', leg_to: '', start_time: '08:00', end_time: '09:00', sterile: 4, soiled: 2, miles: 80 },
        ], NB);
        expect(legs.map((l) => l.startTime)).toEqual(['08:00', '10:00']);
    });

    it('takes the name of a standard leg from the route, never from the row', () => {
        /* The regression this exists to stop: toPayload writes leg_from and
           leg_to EMPTY for standard legs, the way the web always has, so a
           reader that trusts the row shows a sheet of nameless legs. The
           owner saw exactly that, and called it the legs list disappearing. */
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 0, leg_from: '', leg_to: '', start_time: '08:00', end_time: '', sterile: 0, soiled: 0, miles: 0 },
        ], NB);
        expect(legs[0]).toMatchObject({ legFrom: 'Murfreesboro', legTo: 'Clarksville' });
    });

    it('shows every leg of the route even when only one was filled in', () => {
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 0, leg_from: '', leg_to: '', start_time: '08:00', end_time: '', sterile: 0, soiled: 0, miles: 0 },
        ], NB);
        expect(legs).toHaveLength(2);
        expect(legs[1]).toMatchObject({ legFrom: 'Clarksville', legTo: 'Fort Campbell', startTime: '' });
    });

    it('keeps an extra leg past the end of the route, with its own name', () => {
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 2, leg_from: 'Nashville', leg_to: 'Smyrna', start_time: '15:00', end_time: '16:00', sterile: 1, soiled: 0, miles: 22 },
        ], NB);
        expect(legs).toHaveLength(3);
        expect(legs[2]).toMatchObject({ legFrom: 'Nashville', legTo: 'Smyrna', miles: '22' });
    });

    it('gives a full sheet for a day nothing was saved against', () => {
        expect(legsFromSaved([], NB)).toHaveLength(2);
    });

    it('shows a stored zero as an empty box', () => {
        /* This asserted the opposite until toPayload started sending every
           leg in position. Now a zero is what an untouched cell saves as, so
           rendering zeros would put a number in every box on a fresh sheet.
           A driver who means zero and one who typed nothing save the same
           row either way, so showing neither loses nothing. */
        const legs = legsFromSaved([
            { date: '2026-09-20', leg_index: 0, leg_from: '', leg_to: '', start_time: '08:00', end_time: '09:00', sterile: 0, soiled: 0, miles: 80 },
        ], NB);
        expect(legs[0]!.soiled).toBe('');
        expect(legs[0]!.miles).toBe('80');
    });
});

describe('which legs count as done', () => {
    it('treats a leg carrying only its route labels as untouched', () => {
        /* legsForRoute fills the from and the to in and nothing else, so a
           leg holding only those is a leg nobody drove. Mileage no longer
           arrives that way and so no longer belongs in this case. */
        expect(legIsEmpty({ ...emptyLeg(), legFrom: 'A', legTo: 'B' })).toBe(true);
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

    it('treats a leg with only mileage as driven, now that nothing prefills it', () => {
        /* This used to assert the opposite, and it was right at the time: the
           route wrote its defaultMiles into the cell, so mileage alone meant
           a leg nobody touched. Nothing prefills it any more, so a number in
           that box was typed by a person and the leg counts. */
        expect(legIsEmpty({ ...emptyLeg(), miles: '80' })).toBe(false);
        expect(problemsIn([{ ...emptyLeg(), miles: 'eighty' }])).toHaveLength(1);
    });

    it('wants a from and a to on an extra leg', () => {
        const legs = [filled(), { ...filled(), legFrom: '', legTo: '' }];
        const out = problemsIn(legs, 1);
        expect(out).toHaveLength(1);
        expect(out[0]!.message).toMatch(/Enter From and To for extra leg 2/);
    });

    it('does not ask a standard leg to name itself', () => {
        expect(problemsIn([{ ...filled(), legFrom: '', legTo: '' }], 1)).toEqual([]);
    });
});

describe('the totals a driver checks before saving', () => {
    it('adds up only the legs that were driven', () => {
        const out = totals([filled(), filled({ sterile: '1', soiled: '1', miles: '15' }), emptyLeg()]);
        expect(out).toEqual({ legs: 2, sterile: 5, soiled: 3, miles: 95 });
    });

    it('does not produce 189.99999 for 80 + 15 + 15 + 80', () => {
        const legs = [80, 15, 15, 80].map((m) => filled({ miles: String(m) }));
        expect(totals(legs).miles).toBe(190);
    });
});

describe('what is sent', () => {
    /* The server takes leg_index from the position in this array, so the
       array has to keep its holes. See toPayload. */
    it('keeps a skipped leg in its place instead of closing the gap', () => {
        const payload = toPayload('2026-09-20', [filled(), emptyLeg(), filled({ miles: '31' })], 3);
        expect(payload.legs).toHaveLength(3);
        expect(payload.legs[1]).toMatchObject({ startTime: '', miles: '' });
        /* Leg three stays leg three. Dropping the empty one put it at index
           1, where it came back as leg two and leg four was deleted. */
        expect(payload.legs[2]).toMatchObject({ miles: '31' });
        expect(payload.date).toBe('2026-09-20');
    });

    it('lets an extra leg name itself and makes a standard leg not', () => {
        const legs = [
            { ...filled(), legFrom: 'Murfreesboro', legTo: 'Chattanooga' },
            { ...filled(), legFrom: 'Nashville', legTo: 'Clarksville' },
        ];
        const payload = toPayload('2026-09-20', legs, 1);
        /* The route definition names a standard leg, so sending today's copy
           of the label would freeze a name that can change. */
        expect(payload.legs[0]).toMatchObject({ legFrom: '', legTo: '' });
        expect(payload.legs[1]).toMatchObject({ legFrom: 'Nashville', legTo: 'Clarksville' });
    });

    it('trims what was typed', () => {
        const payload = toPayload('2026-09-20', [filled({ startTime: ' 08:00 ', sterile: ' 4 ' })], 1);
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
            /* A day opened and not filled in. It used to be written as a leg
               carrying only its prefilled mileage, which no longer exists. */
            '2026-09-02': [emptyLeg()],
        });
        expect(out.days, 'a day with nothing on it is not a day logged').toBe(2);
        expect(out.routes).toBe(3);
        expect(out.miles).toBe(130);
        expect(out.totes).toBe(6 + 2 + 3);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * PARITY WITH THE WEB.
 *
 * TVHS is live. Two drivers file against it every day, some from the phone
 * and some from the browser, and an administrator reads one report over
 * both. So the question these answer is not "does the app work" but "does
 * the app write what the web writes", which is a different and stricter
 * question. Each case names the function in server/public/app.js it is
 * pinned to, so a change on either side has somewhere to fail.
 * ───────────────────────────────────────────────────────────────────────── */
describe('writes the same rows the web writes', () => {
    const NB = ROUTES['northbound']!.legs;

    it('sends every leg in position, holes included, like saveLog', () => {
        /* app.js saveLog(): `const legs = rows.map(...)` over collectRows(),
           which returns one row per leg whether or not anything is on it.
           The server takes leg_index from the array position. */
        const legs = [filled(), emptyLeg(), filled({ miles: '31' })];
        expect(toPayload('2026-09-21', legs, NB.length).legs).toHaveLength(3);
    });

    it('leaves a standard leg unnamed and names an extra one, like saveLog', () => {
        /* app.js saveLog(): `legFrom: r.extra ? r.from : ''`. The route
           definition names a standard leg; storing a copy in the row would
           freeze today's spelling of a place that can be renamed. */
        const legs = [filled(), { ...filled(), legFrom: 'Nashville', legTo: 'Smyrna' }];
        const sent = toPayload('2026-09-21', legs, 1).legs;
        expect(sent[0]).toMatchObject({ legFrom: '', legTo: '' });
        expect(sent[1]).toMatchObject({ legFrom: 'Nashville', legTo: 'Smyrna' });
    });

    it('rebuilds the sheet from the route after a clear, like buildLogTable', () => {
        /* app.js clearCurrentDay() DELETEs the day and rebuilds from the
           route. The app sends the same DELETE, so what comes back is an
           empty list, and this is what the screen must make of it. */
        const sheet = legsFromSaved([], NB);
        expect(sheet).toHaveLength(NB.length);
        expect(sheet.every((l) => l.startTime === '' && l.miles === '')).toBe(true);
        expect(sheet[0]).toMatchObject({ legFrom: 'Murfreesboro', legTo: 'Clarksville' });
    });

    it('refuses an unnamed extra leg, like saveLog', () => {
        /* app.js saveLog(): "Enter From and To for each extra leg". */
        const legs = [filled(), { ...filled(), legFrom: '', legTo: '' }];
        expect(problemsIn(legs, 1)).toHaveLength(1);
    });
});
