/* Going on shift from a browser (ticket 7.21).

   THE GAP THIS CLOSES. The dispatch board has always READ shift state -- it
   prints "(not on shift)" beside a courier in the assign dropdown, counts
   "Drivers on shift", and requests.ts escalates unclaimed work to whoever is
   on one. Nothing in web/ ever called shifts/start. Invisible while drivers
   used the phone app, which opened the shift; fatal the moment drivers work
   from the browser instead, because then every driver is permanently off
   shift and the escalation that is meant to catch an unclaimed STAT finds
   nobody.

   So what is tested is that the button exists, posts to the right endpoint,
   and tells the truth in between -- including the half-second before the
   first read answers, where claiming "off shift" to somebody who is on one
   sends them to tap a button that will be refused. */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShiftBar } from './ShiftBar';
import { mockFetch } from '../../test/setup';

const MINE = '/api/projects/uh/uh/shifts/mine';

const off = { shift: null, carrying: [] };
const on = (carrying: unknown[] = []) => ({
    shift: { id: 3, startedAt: '2026-11-01T13:00:00.000Z', open: true },
    carrying,
});

function renderBar(routes: Record<string, unknown>) {
    const mocked = mockFetch(routes);
    render(<MemoryRouter><ShiftBar code="uh" /></MemoryRouter>);
    return mocked;
}

describe('the shift control', () => {
    it('offers a way on when the courier is off shift', async () => {
        renderBar({ [`GET ${MINE}`]: off });
        expect(await screen.findByRole('button', { name: 'Go on shift' })).toBeInTheDocument();
        expect(screen.getByText(/Dispatch cannot assign you anything/)).toBeInTheDocument();
    });

    it('offers a way off when they are on, and says what that means', async () => {
        renderBar({ [`GET ${MINE}`]: on() });
        expect(await screen.findByRole('button', { name: 'Go off shift' })).toBeInTheDocument();
        expect(screen.getByText(/Dispatch can give you work/)).toBeInTheDocument();
    });

    it('opens the shift against the server, not in the page', async () => {
        /* The board reads the shifts table. A button that only changed local
           state would leave the courier looking "on shift" to themselves and
           missing from every dropdown dispatch uses. */
        const mocked = renderBar({
            [`GET ${MINE}`]: off,
            [`POST /api/projects/uh/uh/shifts/start`]: { ok: true },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Go on shift' }));
        await waitFor(() => {
            expect(mocked.calls).toContain('POST /api/projects/uh/uh/shifts/start');
        });
    });

    it('closes it against the server too', async () => {
        const mocked = renderBar({
            [`GET ${MINE}`]: on(),
            [`POST /api/projects/uh/uh/shifts/end`]: { ok: true },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Go off shift' }));
        await waitFor(() => {
            expect(mocked.calls).toContain('POST /api/projects/uh/uh/shifts/end');
        });
    });

    it('does not claim they are off shift before it has asked', async () => {
        /* The direction that matters. Told "off shift" while actually on one,
           a courier taps Go on shift, is refused by the server, and has no
           idea why. */
        renderBar({ [`GET ${MINE}`]: on() });
        expect(screen.getByText(/Checking whether you are on shift/)).toBeInTheDocument();
        expect(screen.queryByText(/Off shift\./)).not.toBeInTheDocument();
        await screen.findByRole('button', { name: 'Go off shift' });
    });

    it('warns about packages still in the car before the shift ends', async () => {
        /* Section 9 of the offer letter: every undelivered package goes back
           to the pharmacy it came from the same day. A courier needs that
           before they drive home, not after. */
        renderBar({ [`GET ${MINE}`]: on([{ id: 9, reference: 'RX-9', status: 'failed' }]) });
        expect(await screen.findByText(/still carrying 1 package/)).toBeInTheDocument();
        expect(screen.getByText(/back to the pharmacy they came from/)).toBeInTheDocument();
    });

    it('says nothing about carrying when their hands are empty', async () => {
        renderBar({ [`GET ${MINE}`]: on() });
        await screen.findByRole('button', { name: 'Go off shift' });
        expect(screen.queryByText(/still carrying/)).not.toBeInTheDocument();
    });

    it('keeps the courier on their run when the shift cannot be read', async () => {
        /* Their stops are the job. A failure here reports and gets out of the
           way rather than replacing the screen with an error. */
        renderBar({ [`GET ${MINE}`]: { status: 500, body: { error: 'nope' } } });
        expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
});
