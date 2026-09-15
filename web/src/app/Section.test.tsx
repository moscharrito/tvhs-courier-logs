/* The folding card (ticket 5.14).
 *
 * Four of these are about a fold costing the reader something it should not:
 * the information on the header, the ability to find it again, the heading
 * structure a screen reader navigates by, and a header button that opens
 * something inside the fold.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Section } from './Section';

const open = (name: RegExp | string) => screen.getByRole('button', { name });

beforeEach(() => { window.localStorage.clear(); });

describe('Section', () => {
    it('is a heading and a button, not a div somebody made clickable', () => {
        /* The accordion pattern. A div with an onClick looks identical and is
           neither reachable by Tab nor announced as expandable. */
        render(<Section id="t.a" title="Pickup locations">inside</Section>);
        const heading = screen.getByRole('heading', { name: /Pickup locations/ });
        expect(heading).toBeInTheDocument();
        const toggle = open(/Pickup locations/);
        expect(heading).toContainElement(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('folds and unfolds, and says which it is', () => {
        render(<Section id="t.b" title="Contract pricing">the rate card</Section>);
        expect(screen.getByText('the rate card')).toBeInTheDocument();

        fireEvent.click(open(/Contract pricing/));
        expect(screen.queryByText('the rate card')).not.toBeInTheDocument();
        expect(open(/Contract pricing/)).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(open(/Contract pricing/));
        expect(screen.getByText('the rate card')).toBeInTheDocument();
    });

    it('remembers across a remount, because a preference that resets is not one', () => {
        const { unmount } = render(<Section id="t.c" title="Operating settings">body</Section>);
        fireEvent.click(open(/Operating settings/));
        unmount();

        render(<Section id="t.c" title="Operating settings">body</Section>);
        expect(open(/Operating settings/)).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('body')).not.toBeInTheDocument();
    });

    it('keeps one section’s choice out of another’s', () => {
        render(
            <>
                <Section id="t.d1" title="First">one</Section>
                <Section id="t.d2" title="Second">two</Section>
            </>,
        );
        fireEvent.click(open(/First/));
        expect(screen.queryByText('one')).not.toBeInTheDocument();
        expect(screen.getByText('two')).toBeInTheDocument();
    });

    it('shows the summary only while folded, so it never doubles the content', () => {
        /* The order page showed "$34.50" on the header and "Total $34.50" in
           the table directly beneath it. A summary stands in for content; on
           top of that content it is just more of it. */
        render(<Section id="t.e" title="What it bills at" summary="$34.50">Total $34.50</Section>);
        expect(screen.queryByText('$34.50')).not.toBeInTheDocument();

        fireEvent.click(open(/What it bills at/));
        expect(screen.getByText('$34.50')).toBeInTheDocument();
        expect(screen.queryByText('Total $34.50')).not.toBeInTheDocument();
    });

    it('reads out as the title and then the summary', () => {
        /* The gap on screen is flex, so it is worth pinning that the name
           does not run the two together for somebody who only hears it. */
        render(<Section id="t.i" title="Pickup locations" summary="9 pharmacies" defaultOpen={false}>x</Section>);
        expect(open('Pickup locations 9 pharmacies')).toBeInTheDocument();
    });

    it('lets a header action open the panel it needs', () => {
        /* Found by clicking it: "Take an order" hid itself and showed no
           form, because the form was inside the fold. A control that reveals
           something has to be able to open the thing it lives on. */
        render(
            <Section
                id="t.f"
                title="STAT or ad hoc order"
                defaultOpen={false}
                actions={(expand) => <button type="button" onClick={expand}>Take an order</button>}
            >
                the form
            </Section>,
        );
        expect(screen.queryByText('the form')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Take an order' }));
        expect(screen.getByText('the form')).toBeInTheDocument();
    });

    it('does not fold when the header action is pressed', () => {
        // An Edit control that also closed the panel it edits would be a trap.
        render(
            <Section id="t.g" title="Operating settings" actions={<button type="button">Edit</button>}>
                body
            </Section>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect(screen.getByText('body')).toBeInTheDocument();
    });

    it('still renders when localStorage refuses, rather than taking the page down', () => {
        /* A private window and blocked site data both throw on access. A
           screen that will not render because it could not remember whether a
           panel was open is a worse bug than the one being fixed. */
        const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { throw new Error('blocked'); },
        });
        try {
            render(<Section id="t.h" title="Pickup locations">inside</Section>);
            expect(screen.getByText('inside')).toBeInTheDocument();
            fireEvent.click(open(/Pickup locations/));
            expect(screen.queryByText('inside')).not.toBeInTheDocument();
        } finally {
            if (real) Object.defineProperty(window, 'localStorage', real);
        }
    });
});
