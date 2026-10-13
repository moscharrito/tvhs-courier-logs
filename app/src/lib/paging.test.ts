/* Where a page of a list starts and stops.
 *
 * The interesting cases are not "does it slice". They are what happens when
 * the list moves under a thumb, which every list on a phone does: a run
 * refreshes on a timer, a stop is delivered and leaves the list, a history
 * window goes from 7 days to 90.
 *
 * A courier left on an empty page does not conclude they are on page 3 of 1.
 * They conclude their round has gone.
 */

import { describe, it, expect } from 'vitest';
import { pageOf, PAGE_SIZE } from './paging';

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`);

describe('how many', () => {
    it('is eight, the same eight as the web app', () => {
        /* A lead who works the dispatch board in the morning and the phone
           in the afternoon should not meet two ideas of a long list. */
        expect(PAGE_SIZE).toBe(8);
    });

    it('shows eight and says how many there are', () => {
        const p = pageOf(rows(23), 0);
        expect(p.rows).toHaveLength(8);
        expect(p.rows[0]).toBe('row 1');
        expect(p.total).toBe(23);
        expect(p.pages).toBe(3);
        expect(p.from).toBe(1);
        expect(p.to).toBe(8);
    });

    it('does not pad a last page that is short', () => {
        const p = pageOf(rows(18), 2);
        expect(p.rows).toEqual(['row 17', 'row 18']);
        expect(p.from).toBe(17);
        expect(p.to).toBe(18);
    });

    it('counts from the right place on a middle page', () => {
        const p = pageOf(rows(23), 1);
        expect(p.rows[0]).toBe('row 9');
        expect(p.from).toBe(9);
        expect(p.to).toBe(16);
    });
});

describe('a list that moved under the reader', () => {
    it('lands on the last real page rather than an empty one', () => {
        /* Page 3 of a 23-row list, then the list becomes 4 rows. */
        const p = pageOf(rows(4), 2);
        expect(p.page).toBe(0);
        expect(p.rows).toHaveLength(4);
        expect(p.total).toBe(4);
    });

    it('clamps a page past the end instead of returning nothing', () => {
        const p = pageOf(rows(10), 99);
        expect(p.page).toBe(1);
        expect(p.rows).toEqual(['row 9', 'row 10']);
    });

    it('clamps a negative page', () => {
        expect(pageOf(rows(10), -5).page).toBe(0);
    });

    it('survives a page that is not a number at all', () => {
        /* Nothing should pass NaN, and a list that renders nothing because
           something did is worse than a list that renders page one. */
        expect(pageOf(rows(10), Number.NaN).page).toBe(0);
        expect(pageOf(rows(10), 1.7).page).toBe(1);
    });

    it('copes with an empty list without claiming a row', () => {
        const p = pageOf<string>([], 0);
        expect(p.rows).toEqual([]);
        expect(p.total).toBe(0);
        expect(p.pages).toBe(1);
        /* Not "1 to 0 of 0". */
        expect(p.from).toBe(0);
        expect(p.to).toBe(0);
    });
});

describe('when there is nothing to page', () => {
    it('reports one page at exactly eight rows, so the control hides itself', () => {
        /* A pager under a two-row list is clutter anywhere; on a phone it is
           also a tap target where the thumb wants the next thing. */
        expect(pageOf(rows(8), 0).pages).toBe(1);
        expect(pageOf(rows(9), 0).pages).toBe(2);
    });
});

describe('it does not lose or repeat a row', () => {
    it('walks every page and sees each row exactly once', () => {
        /* The property worth having on a list of medication deliveries. */
        const all = rows(41);
        const seen: string[] = [];
        const { pages } = pageOf(all, 0);
        for (let i = 0; i < pages; i += 1) seen.push(...pageOf(all, i).rows);
        expect(seen).toEqual(all);
    });
});
