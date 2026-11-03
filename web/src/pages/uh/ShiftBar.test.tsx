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
        /* TWO WORDS, NOT A SENTENCE. The explanation beside the dot went on
           2 November: it stood at the top of the one screen a driver works
           from all day, and by the second day nobody reads it. */
        expect(screen.getByText('Off shift')).toBeInTheDocument();
    });

    it('offers a way off when they are on', async () => {
        renderBar({ [`GET ${MINE}`]: on() });
        expect(await screen.findByRole('button', { name: 'Go off shift' })).toBeInTheDocument();
        expect(screen.getByText('On shift')).toBeInTheDocument();
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
        expect(screen.getByText(/Checking/)).toBeInTheDocument();
        expect(screen.queryByText('Off shift')).not.toBeInTheDocument();
        await screen.findByRole('button', { name: 'Go off shift' });
    });

    it('says once, dismissibly, when a shift ends over unfinished work', async () => {
        /* IT USED TO BE A REFUSAL. The server declined to end a shift while
           deliveries were still open and the bar printed the reason; before
           that the reason was swallowed and the button looked dead. The
           block went on 3 November -- the stops list already shows what is
           unfinished, and keeping a shift open never got anything back to a
           pharmacy -- so what is left is a notice. It appears once, after
           the shift has already ended, and closes with one tap. */
        renderBar({
            ['GET ' + MINE]: on([{ id: 9, reference: 'RX-9', status: 'failed' }]),
            ['POST /api/projects/uh/uh/shifts/end']: { ok: true, carrying: 2 },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Go off shift' }));

        const notice = await screen.findByText(/2 deliveries are still open/);
        expect(notice).toBeInTheDocument();
        /* NOT an alert: nothing is wrong and nothing is waiting on it. */
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByText(/still open/)).not.toBeInTheDocument();
    });

    it('says nothing about carrying when nothing has been refused', async () => {
        renderBar({ [`GET ${MINE}`]: on([{ id: 9, reference: 'RX-9', status: 'failed' }]) });
        await screen.findByRole('button', { name: 'Go off shift' });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says it does not know, quietly, when the shift cannot be read', async () => {
        /* Their stops are the job, so a failure here gets out of the way.

           AND IT DOES NOT RAISE AN ALERT, which changed when this moved into
           the top bar on 2 November. The bar is now on every screen of the
           driver portal: a read that fails would put a red alert over
           whatever the courier was doing, and on a page with an alert of its
           own there would be two. Nobody asked for this request. A refused
           TOGGLE still shouts, because that one they did ask for. */
        renderBar({ [`GET ${MINE}`]: { status: 500, body: { error: 'nope' } } });
        expect(await screen.findByText('Shift unknown')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});
