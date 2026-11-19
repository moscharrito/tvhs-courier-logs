/* The grey line under a driver's name.
 *
 * Asked for on 19 November 2026 by the people doing the ringing: a
 * dispatcher looking at a late delivery and a pharmacist looking at their
 * own were both given a first name and nothing else, so the call went to
 * our office, who looked the number up and read it back.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CourierPhone } from './CourierPhone';
import { dialable } from './people';

describe('a number under the name', () => {
    it('prints it exactly as the roster typed it', () => {
        /* The roster is a free text field on purpose -- a driver may write
           down an extension, a second number, or somebody else's phone for
           the week. Tidying "(210) 555-0190 after 6" into a canonical
           number throws away the half that matters. */
        render(<CourierPhone phone="(210) 555-0190 after 6" />);
        expect(screen.getByText('(210) 555-0190 after 6')).toBeInTheDocument();
    });

    it('dials the digits out of whatever was typed', () => {
        render(<CourierPhone phone="(210) 555-0190" />);
        expect(screen.getByRole('link')).toHaveAttribute('href', 'tel:2105550190');
    });

    it('keeps a leading + , because an international number without one is a different number', () => {
        render(<CourierPhone phone="+1 210 555 0190" />);
        expect(screen.getByRole('link')).toHaveAttribute('href', 'tel:+12105550190');
    });

    it('says N/A when the roster has no number for them', () => {
        /* ─────────────────────────────────────────────────────────────────
         * This rendered NOTHING first, and nothing is ambiguous in the one
         * way that matters: a dispatcher seeing a bare name cannot tell
         * whether we have no number for this driver or whether the screen
         * simply is not showing it, so they ring the office to find out --
         * which is the call this component exists to stop.
         */
        render(<CourierPhone phone="" />);
        expect(screen.getByText('N/A')).toBeInTheDocument();
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('says it to a screen reader too, which would otherwise read "N/A" as a word', () => {
        render(<CourierPhone phone={null} />);
        expect(screen.getByTitle('No phone number on the driver roster')).toBeInTheDocument();
    });

    it('does not offer a tel: link for something too short to be a number', () => {
        /* An extension or a typo. A tel: link to either is a wrong number
           somebody will dial, so the text stays and the link does not. */
        render(<CourierPhone phone="x4120" />);
        expect(screen.getByText('x4120')).toBeInTheDocument();
        expect(screen.queryByRole('link')).toBeNull();
    });
});

describe('dialable', () => {
    it('refuses what cannot be dialled rather than guessing', () => {
        expect(dialable('')).toBeNull();
        expect(dialable('   ')).toBeNull();
        expect(dialable('ask dispatch')).toBeNull();
        expect(dialable('12345')).toBeNull();
    });
});
