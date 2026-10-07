/* Getting from a number to the rows behind it, without changing the question.
 *
 * The tests that matter are not "does it build a query string". They are the
 * ones about the range: a bucket is a calendar month or quarter and the report
 * was run over whatever dates somebody typed, so the obvious link asks for
 * more rows than the figure it hangs off. Two numbers that disagree, one of
 * them quoted back at us later.
 */

import { describe, it, expect } from 'vitest';
import {
    clampToWindow, describeFilter, drillQuery, rangeOfBucket, siteIdOfSliceKey,
} from './drilldown';

describe('what a bucket covers', () => {
    it('is the day itself, for a day', () => {
        expect(rangeOfBucket('2026-11-03', 'day')).toEqual({ from: '2026-11-03', to: '2026-11-03' });
    });

    it('is Monday to Sunday, for a week', () => {
        /* bucketFor keys a week by its Monday. Six days on, not seven: both
           ends are inclusive, and an off-by-one here silently pulls the next
           week's Monday into every weekly figure. */
        expect(rangeOfBucket('2026-11-02', 'week')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    });

    it('is the whole calendar month, including the short ones', () => {
        expect(rangeOfBucket('2026-11', 'month')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
        expect(rangeOfBucket('2026-02', 'month')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    });

    it('knows February in a leap year', () => {
        /* 2028 is the first leap year this contract will see. */
        expect(rangeOfBucket('2028-02', 'month')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    });

    it('is three months, for a quarter', () => {
        expect(rangeOfBucket('2026-Q1', 'quarter')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
        expect(rangeOfBucket('2026-Q4', 'quarter')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    });

    it('refuses a key it does not recognise rather than guessing', () => {
        /* The keys are made on the server. If bucketFor changes shape, this
           has to produce no link rather than a link to the wrong fortnight. */
        for (const [key, grouping] of [
            ['2026-W45', 'week'], ['nonsense', 'day'], ['2026-13', 'month'],
            ['2026-Q5', 'quarter'], ['', 'day'], ['2026-00', 'month'],
        ] as const) {
            expect(rangeOfBucket(key, grouping), `${grouping} key "${key}"`).toBeNull();
        }
    });
});

describe('clamping to the window the report ran over', () => {
    it('leaves a bucket that sits inside it alone', () => {
        expect(clampToWindow({ from: '2026-11-01', to: '2026-11-30' }, { from: '2026-10-01', to: '2026-12-31' }))
            .toEqual({ from: '2026-11-01', to: '2026-11-30' });
    });

    it('cuts a month bucket back to the days the report asked for', () => {
        /* THE PROPERTY. Report run over 15 to 30 September, somebody clicks
           the September row: the list must show the same fifteen days the
           figure counted, not the whole month. */
        expect(clampToWindow({ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-09-15', to: '2026-09-30' }))
            .toEqual({ from: '2026-09-15', to: '2026-09-30' });
    });

    it('cuts the week that hangs off the end of a range', () => {
        /* Weekly grouping over a range that does not start on a Monday
           produces exactly this at both ends, every time. */
        expect(clampToWindow({ from: '2026-11-02', to: '2026-11-08' }, { from: '2026-10-20', to: '2026-11-04' }))
            .toEqual({ from: '2026-11-02', to: '2026-11-04' });
    });

    it('is null when they do not overlap, rather than an inverted range', () => {
        /* from after to is a 400 from the list endpoint. Better to render no
           link than one that errors. */
        expect(clampToWindow({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-06-01', to: '2026-06-30' }))
            .toBeNull();
    });
});

describe('the query the list is asked for', () => {
    const window = { from: '2026-11-01', to: '2026-11-30' };

    it('always carries the range', () => {
        expect(drillQuery({ window })).toBe('from=2026-11-01&to=2026-11-30');
    });

    it('carries only what is being filtered', () => {
        const q = new URLSearchParams(drillQuery({ window, status: 'failed', siteId: 4 }));
        expect(q.get('status')).toBe('failed');
        expect(q.get('siteId')).toBe('4');
        expect(q.get('serviceType')).toBeNull();
        expect(q.get('reference')).toBeNull();
    });

    it('never carries a patient name or a reference', () => {
        /* Not an oversight to be fixed later: a name in a query string
           reaches browser history, proxies and referrer headers, which is
           why the portal search box refuses them too. There is no parameter
           here to pass one through. */
        const q = drillQuery({ window, status: 'failed', siteId: 4, serviceType: 'stat' });
        expect(q).not.toMatch(/name|patient|recipient|reference/i);
    });

    it('passes the open group through as a status, because the list knows it', () => {
        expect(new URLSearchParams(drillQuery({ window, status: 'open' })).get('status')).toBe('open');
    });
});

describe('reading a pharmacy slice key back', () => {
    it('undoes the padding sliceBy applies', () => {
        /* reports.ts keys a site slice as String(siteId).padStart(6, '0') so
           the rows sort. */
        expect(siteIdOfSliceKey('000004')).toBe(4);
        expect(siteIdOfSliceKey('000123')).toBe(123);
    });

    it('refuses anything that is not a positive whole number', () => {
        /* A NaN in a URL becomes a 403 at the far end, which reads to a
           pharmacist as "you are not allowed to see your own pharmacy". */
        for (const key of ['', 'zzz', 'zone-2', '-1', '0', '1.5', '00000x']) {
            expect(siteIdOfSliceKey(key), `key "${key}"`).toBeNull();
        }
    });
});

describe('saying what the list is narrowed to', () => {
    const none = { from: '', to: '', status: '', siteId: '', serviceType: '', reference: '' };

    it('says nothing when nothing is filtered', () => {
        expect(describeFilter(none)).toBe('');
    });

    it('says one date once, not twice', () => {
        expect(describeFilter({ ...none, from: '2026-11-03', to: '2026-11-03' })).toBe('2026-11-03');
    });

    it('names the pharmacy when it knows the name', () => {
        expect(describeFilter({ ...none, siteId: '4' }, 'Robert B. Green')).toContain('Robert B. Green');
    });

    it('falls back to something true when it does not', () => {
        /* The name comes from the summary, which may not have landed yet.
           "one pharmacy" is honest; the id would be meaningless. */
        expect(describeFilter({ ...none, siteId: '4' })).toContain('one pharmacy');
        expect(describeFilter({ ...none, siteId: '4' })).not.toContain('4');
    });

    it('says still out rather than open, which is our word', () => {
        expect(describeFilter({ ...none, status: 'open' })).toContain('still out');
    });

    it('does not show a status with an underscore in it', () => {
        expect(describeFilter({ ...none, status: 'picked_up' })).toBe('picked up');
    });
});
