/* The pharmacy dropdown every filtered screen shares.
 *
 * WHAT IS BEING TESTED IS NOT THAT IT RENDERS A <select>. It is the two
 * ways narrowing a filter's own options can go wrong, both of which are
 * worse than the problem narrowing solves:
 *
 *   the chosen option disappearing out from under a selection that is
 *   still in the URL, leaving a blank box above filtered figures;
 *
 *   an option vanishing with nothing said, which reads as a pharmacy
 *   having been removed from the contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { PharmacyFilter, usePharmacies, type CountedSite } from './PharmacyFilter';
import { mockFetch } from '../../test/setup';

afterEach(cleanup);

const site = (id: number, name: string, orders?: number): CountedSite => ({
    id,
    code: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    type: 'pharmacy',
    addressLine: '1 Rehearsal Way',
    city: 'San Antonio',
    state: 'TX',
    zip: '78229',
    fullAddress: '1 Rehearsal Way, San Antonio, TX 78229',
    lat: null,
    lng: null,
    geocodeStatus: 'pending',
    geocodedAt: null,
    releasesList: true,
    status: 'active',
    notes: '',
    createdAt: null,
    updatedAt: null,
    ...(orders === undefined ? {} : { orders }),
} as CountedSite);

const options = () => [...screen.getByLabelText('Pharmacy').querySelectorAll('option')]
    .map((o) => o.textContent);

describe('the pharmacy filter', () => {
    it('offers only the counters that had something in the range', () => {
        render(<PharmacyFilter
            sites={[site(1, 'Wheatley', 4), site(2, 'Vida', 0), site(3, 'Pavilion', 9)]}
            value=""
            onChange={() => {}}
        />);
        expect(options()).toEqual(['Every pharmacy', 'Wheatley', 'Pavilion']);
    });

    it('says how many it left out, and gives them back', async () => {
        /* AN OPTION THAT VANISHES WITHOUT A WORD READS AS A BUG, or worse
           as a counter taken off the contract. The count is said out loud
           and the quiet ones are one click away, which is the same bargain
           the drivers record strikes with the roster it folds. */
        render(<PharmacyFilter
            sites={[site(1, 'Wheatley', 4), site(2, 'Vida', 0), site(3, 'Pavilion', 0)]}
            value=""
            onChange={() => {}}
        />);
        const button = screen.getByRole('button', { name: /2 pharmacies with nothing/ });
        fireEvent.click(button);
        await waitFor(() => { expect(options()).toHaveLength(4); });
        expect(options()).toEqual([
            'Every pharmacy', 'Wheatley', 'Vida — nothing in this range', 'Pavilion — nothing in this range',
        ]);
        expect(screen.queryByRole('button', { name: /nothing in this range/ })).toBeNull();
    });

    it('keeps a pharmacy that is already chosen, even when the range moved past it', () => {
        /* THE ONE THAT MATTERS. Pick the Pavilion, move the dates back a
           week, and a list of only-what-exists no longer holds the option
           the URL still names. A <select> whose value matches no option
           renders BLANK -- so the page would show the Pavilion's empty
           figures above a box that appears to say "every pharmacy". */
        render(<PharmacyFilter
            sites={[site(1, 'Wheatley', 4), site(3, 'Pavilion', 0)]}
            value="3"
            onChange={() => {}}
        />);
        const select = screen.getByLabelText('Pharmacy') as HTMLSelectElement;
        expect(select.value, 'the box still shows what was chosen').toBe('3');
        expect(options()).toContain('Pavilion — nothing in this range');
    });

    it('does not count the chosen one twice when it did have work', () => {
        render(<PharmacyFilter
            sites={[site(1, 'Wheatley', 4), site(3, 'Pavilion', 2)]}
            value="3"
            onChange={() => {}}
        />);
        expect(options()).toEqual(['Every pharmacy', 'Wheatley', 'Pavilion']);
    });

    it('offers everything when nobody counted anything', () => {
        /* NO WINDOW MEANS NO NARROWING, and the absence of `orders` is what
           says so. This is the state the forms are in -- new order, list
           import, a drop handed over -- and narrowing them would make the
           first order at a counter impossible to record. */
        render(<PharmacyFilter
            sites={[site(1, 'Wheatley'), site(2, 'Vida'), site(3, 'Pavilion')]}
            value=""
            onChange={() => {}}
        />);
        expect(options()).toEqual(['Every pharmacy', 'Wheatley', 'Vida', 'Pavilion']);
        expect(screen.queryByRole('button', { name: /nothing in this range/ })).toBeNull();
    });

    it('takes the caller\'s word for what "no pharmacy" is called', () => {
        /* "Every pharmacy" over a report and "any" beside the other filters
           on an operational board. Both are right where they are, and a
           shared control that imposed one of them would be a worse fit than
           the six copies it replaced. */
        render(<PharmacyFilter sites={[site(1, 'Wheatley', 1)]} value="" onChange={() => {}} anyLabel="any" />);
        expect(options()).toEqual(['any', 'Wheatley']);
    });

    it('reports the chosen id back as a string, and an empty one for every pharmacy', () => {
        const seen: string[] = [];
        render(<PharmacyFilter
            sites={[site(1, 'Wheatley', 4), site(3, 'Pavilion', 2)]}
            value=""
            onChange={(v) => seen.push(v)}
        />);
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '' } });
        expect(seen).toEqual(['3', '']);
    });
});

/* A hook needs a component to live in. This one does nothing but say what
   it was given, which is all these tests are asking about. */
function Probe({ range, enabled }: { range?: { from: string; to: string }; enabled?: boolean }) {
    const sites = usePharmacies('uh', range, enabled);
    return <p>{sites.length === 0 ? 'none' : sites.map((s) => s.name).join(', ')}</p>;
}

describe('asking the server for the pharmacies', () => {
    it('sends the range, so the counting happens there rather than here', async () => {
        const mocked = mockFetch({
            'GET /api/projects/uh/uh/sites*': [site(1, 'Wheatley', 2)],
        });
        render(<Probe range={{ from: '2026-11-20', to: '2026-11-21' }} />);
        await screen.findByText('Wheatley');
        expect(mocked.calls).toContain('GET /api/projects/uh/uh/sites?from=2026-11-20&to=2026-11-21');
    });

    it('sends no range at all when there is none, which is what the forms rely on', async () => {
        const mocked = mockFetch({
            'GET /api/projects/uh/uh/sites*': [site(1, 'Wheatley')],
        });
        render(<Probe />);
        await screen.findByText('Wheatley');
        expect(mocked.calls).toContain('GET /api/projects/uh/uh/sites');
        expect(mocked.calls.some((c) => c.includes('from=')), 'no window was invented').toBe(false);
    });

    it('asks for nothing when the filter it feeds is behind a role check', async () => {
        const mocked = mockFetch({
            'GET /api/projects/uh/uh/sites*': [site(1, 'Wheatley')],
        });
        render(<Probe enabled={false} />);
        await screen.findByText('none');
        expect(mocked.calls.some((c) => c.includes('/uh/sites'))).toBe(false);
    });

    it('leaves the filter empty rather than the page broken when the list will not load', async () => {
        /* Silent on failure, which is what each of the six screens had
           separately arrived at: a dropdown is not worth an error banner
           over a payment run. */
        mockFetch({ 'GET /api/projects/uh/uh/sites*': { status: 500, body: { error: 'nope' } } });
        render(<Probe range={{ from: '2026-11-20', to: '2026-11-20' }} />);
        await screen.findByText('none');
    });
});
