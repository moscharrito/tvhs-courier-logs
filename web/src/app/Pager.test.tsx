/* Pages of eight (ticket 5.15, resized in 7.8).
 *
 * The interesting cases are not "does Next work". They are what happens when
 * the list moves under the reader, which every list here does: the board
 * refreshes on a timer, the order search refilters on a keystroke, resolving
 * a discrepancy removes it from the list it was in.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Pager, usePaged, PAGE_SIZE } from './Pager';

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`);

function List({ items }: { items: string[] }) {
    const paged = usePaged(items);
    return (
        <>
            <ul>{paged.rows.map((r) => <li key={r}>{r}</li>)}</ul>
            <Pager of={paged} noun="rows" />
        </>
    );
}

/** A list that can shrink, the way a filter or a refresh shrinks one. */
function Shrinkable() {
    const [items, setItems] = useState(rows(23));
    return (
        <>
            <button type="button" onClick={() => setItems(rows(4))}>Filter</button>
            <List items={items} />
        </>
    );
}

const next = () => screen.getByRole('button', { name: 'Next' });
const prev = () => screen.getByRole('button', { name: 'Previous' });

describe('paging', () => {
    it('shows eight and no more', () => {
        expect(PAGE_SIZE).toBe(8);
        render(<List items={rows(23)} />);
        expect(screen.getAllByRole('listitem')).toHaveLength(8);
        expect(screen.getByText('row 1')).toBeInTheDocument();
        expect(screen.queryByText('row 9')).not.toBeInTheDocument();
    });

    it('says how many there are, which is the whole point', () => {
        /* A page of eight with no total reads exactly like a list of eight,
           and a dispatcher who thinks they have seen every open discrepancy
           when they have seen the first eight is worse off than before. */
        render(<List items={rows(23)} />);
        expect(screen.getByText('Showing 1 to 8 of 23 rows')).toBeInTheDocument();
    });

    it('walks forward and back, and stops at both ends', () => {
        render(<List items={rows(18)} />);
        expect(prev()).toBeDisabled();

        fireEvent.click(next());
        expect(screen.getByText('row 9')).toBeInTheDocument();
        expect(screen.getByText('Showing 9 to 16 of 18 rows')).toBeInTheDocument();

        fireEvent.click(next());
        // A last page that is not full says so rather than padding.
        expect(screen.getByText('Showing 17 to 18 of 18 rows')).toBeInTheDocument();
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
        expect(next()).toBeDisabled();

        fireEvent.click(prev());
        expect(screen.getByText('Showing 9 to 16 of 18 rows')).toBeInTheDocument();
    });

    it('hides itself when there is nothing to page', () => {
        // A pager under a two-row table is the clutter this was to remove.
        render(<List items={rows(8)} />);
        expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    });

    it('lands on a real page when the list shrinks underneath', () => {
        /* The defect this is written against: filter twenty-three rows down
           to four while standing on page 3, and a stored page number leaves
           you looking at an empty table deciding the search is broken. */
        render(<Shrinkable />);
        fireEvent.click(next());
        fireEvent.click(next());
        expect(screen.getByText('Showing 17 to 23 of 23 rows')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
        expect(screen.getAllByRole('listitem')).toHaveLength(4);
        expect(screen.getByText('row 1')).toBeInTheDocument();
        // One page now, so the control has nothing to do and goes.
        expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    });

    it('copes with an empty list without claiming a row', () => {
        render(<List items={[]} />);
        expect(screen.queryAllByRole('listitem')).toHaveLength(0);
        expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    });

    it('announces the count politely, not as an interruption', () => {
        // It changes on every page turn; that is a fact to read, not an alarm.
        render(<List items={rows(23)} />);
        expect(screen.getByText(/Showing 1 to 8/)).toHaveAttribute('aria-live', 'polite');
    });

    it('carries a note even when there is only one page', () => {
        /* A list the server capped is worth saying so about whether or not it
           happens to fit on one page. */
        function Capped() {
            const paged = usePaged(rows(3));
            return <Pager of={paged} noun="orders" note="the newest 500" />;
        }
        render(<Capped />);
        expect(screen.getByText('the newest 500')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    });
});
