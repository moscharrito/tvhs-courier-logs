/* Today's run on a courier's phone.

   The assertion that matters most is the map link: it carries the address
   and never the patient's name, because that URL leaves the application into
   a third party's servers and the phone's own history.

   ─────────────────────────────────────────────────────────────────────────
   WHERE THE DIRECTIONS ASSERTIONS LOOK, AND WHY IT MOVED.

   This screen is now the phone app's layout: information in the upper
   region, controls in a sheet under the thumb. Directions and "Open the
   stop" used to sit inside the next-stop card, so these tests scoped to
   `getByLabelText('Next stop')` to pick the current stop's control out of
   the one-per-row in the list below.

   They are controls, so they are in the sheet now, grouped and named "This
   stop". The scoping moved with them and nothing else about these tests
   changed: `thisStop()` does the job `next` did, which was only ever to
   avoid matching twenty rows at once. */

import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MyRun, mapsUrl } from './MyRun';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };

const sla = (over = {}) => ({ state: 'open', minutesToDue: 45, onTime: null, measuredAt: null, measuredFrom: null, ...over });

const stop = (over = {}) => ({
    sequence: 1, orderId: 21, externalRef: 'RX-1', serviceType: 'stat',
    recipientName: 'Ines Vargas', address: '1100 Broadway St, Apt 4B',
    /* COLLECTED, because that is when a courier reads their round. An
       uncollected stop now hides the whole list -- see the note in
       MyRun.tsx -- so the tests that are about the list say so, and the
       ones about the pickup gate ask for 'assigned' explicitly. */
    city: 'San Antonio', zip: '78215', zone: 1, status: 'picked_up',
    dueAt: '2026-09-14T19:00:00.000Z', sla: sla(), ...over,
});

const mine = (over = {}) => ({
    serviceDate: '2026-09-14',
    timezone: 'America/Chicago',
    courierUsername: 'ada.courier',
    runs: [{
        id: 10, courierUsername: 'ada.courier', serviceDate: '2026-09-14',
        label: 'Noon wave', status: 'started', startedAt: null,
        stops: [
            stop(),
            stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra', address: '4502 Medical Dr', zip: '78229', sla: sla({ state: 'due_soon', minutesToDue: 12 }) }),
        ],
    }],
    dispatch: { phone: '(210) 555-0100', name: 'Izy dispatch' },
    directions: { embed: false },
    ...over,
});

function renderRun(routes: Record<string, unknown>) {
    const mock = mockFetch(routes);
    Object.assign(globalThis, { lastMock: mock });
    render(
        <MemoryRouter initialEntries={['/projects/uh/my-run']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/my-run" element={<MyRun />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    /* The mock rather than the render result: the day filter is about
       WHICH request went out, so its tests read `calls`. Nothing used the
       render result. */
    return mock;
}

/** The row of All stops for the stop a courier is driving to right now.
 *
 *  It used to be a group of cards in the sheet -- Open the stop, Directions,
 *  Details -- which went on 3 November: all three are on every row of the
 *  list below, including this one, so the cards were three ways to reach
 *  what a link eight lines further down already reached. The tests that were
 *  about Directions follow it to the row; the two that were about the cards
 *  themselves are rewritten below. */
const thisStop = () => screen.getAllByRole('listitem')[0] as HTMLElement;

const base = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/runs/mine': mine(),
    ...over,
});

describe('mapsUrl', () => {
    it('carries the address and never the patient name', () => {
        // The URL leaves this application: it reaches a third party's servers
        // and the phone's own history. The name adds nothing to navigating
        // there and everything to the disclosure.
        const url = mapsUrl({ address: '1100 Broadway St, Apt 4B', city: 'San Antonio', zip: '78215' });
        expect(url).toContain(encodeURIComponent('1100 Broadway St, Apt 4B, San Antonio, 78215'));
        expect(url).not.toMatch(/Ines|Vargas/);
        expect(url.startsWith('https://www.google.com/maps/search/')).toBe(true);
    });

    it('copes with a missing city or ZIP', () => {
        expect(mapsUrl({ address: '1100 Broadway St', city: '', zip: '' })).toContain(encodeURIComponent('1100 Broadway St'));
    });
});

describe('MyRun', () => {
    it('leads with the next stop, not with a list to scroll', async () => {
        renderRun(base());
        expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
        const next = screen.getByLabelText('Next stop');
        expect(within(next).getByText('Next: stop 1')).toBeInTheDocument();
        expect(within(next).getByText('Ines Vargas')).toBeInTheDocument();
        expect(within(next).getByText('45 min left')).toBeInTheDocument();
    });

    it('sends nothing anywhere until the courier asks, when maps are embedded', async () => {
        /* With the embed on, the run screen renders with no third-party URL
           on it at all. Twenty stops used to mean twenty addresses sitting in
           the DOM as Google URLs whether or not anybody tapped one. */
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': mine({ directions: { embed: true } }) }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(document.querySelectorAll('a[href^="http"]').length).toBe(0);
        expect(document.querySelectorAll('iframe').length).toBe(0);
        expect(screen.getAllByRole('button', { name: 'Directions' }).length).toBeGreaterThan(0);
    });

    it('is a plain link on the first tap when this server embeds nothing', async () => {
        /* The configured state today, and the one that matters most: a
           courier at a van door presses Directions once and the map opens.
           A button that turns into a link they have to press again would be
           a regression dressed as a feature. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        const link = within(thisStop()).getByRole('link', { name: 'Directions' });
        expect(link).toHaveAttribute('href', expect.stringContaining('google.com/maps/search'));
        expect(link).toHaveAttribute('target', '_blank');
        expect(within(thisStop()).queryByRole('button', { name: 'Directions' })).toBeNull();
        expect(document.querySelectorAll('iframe').length).toBe(0);
    });

    it('puts no patient name in the map it opens, whichever way it opens', async () => {
        /* The rule this whole feature is built around, asserted on both
           branches: the frame when the server allows one, and the link when
           it does not. The address is what it takes to drive there. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({ directions: { embed: true } }),
            'GET /api/projects/uh/uh/orders/21/directions*': {
                available: true,
                embedUrl: 'https://www.google.com/maps/embed/v1/place?key=k&q=1100%20Broadway%20St%2C%20Apt%204B%2C%20San%20Antonio%2C%2078215',
                mapsUrl: mapsUrl({ address: '1100 Broadway St, Apt 4B', city: 'San Antonio', zip: '78215' }),
                why: '',
            },
        }));
        await screen.findByRole('heading', { name: 'Today' });
        fireEvent.click(within(thisStop()).getByRole('button', { name: 'Directions' }));

        const frame = await screen.findByTitle('Directions to this stop');
        const urls = [
            frame.getAttribute('src') ?? '',
            ...[...document.querySelectorAll('a[href^="http"]')].map((a) => a.getAttribute('href') ?? ''),
            // The request we made to get it, which leaves this app too.
            ...(globalThis as { lastMock?: { calls: string[] } }).lastMock!.calls,
        ];
        expect(urls.length).toBeGreaterThan(2);
        for (const url of urls) {
            expect(url).not.toMatch(/Ines|Vargas|Marcus|Ibarra/i);
        }
    });

    it('falls back to the link, not a dead frame, when one stop cannot be mapped', async () => {
        /* Maps are on for this installation, but this stop came back without
           one: no address on it, say. The courier still gets somewhere to
           tap rather than an empty grey box. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({ directions: { embed: true } }),
            'GET /api/projects/uh/uh/orders/21/directions*': {
                available: false,
                embedUrl: null,
                mapsUrl: mapsUrl({ address: '1100 Broadway St, Apt 4B', city: 'San Antonio', zip: '78215' }),
                why: 'This stop has no address on it.',
            },
        }));
        await screen.findByRole('heading', { name: 'Today' });
        fireEvent.click(within(thisStop()).getByRole('button', { name: 'Directions' }));

        const link = await within(thisStop()).findByRole('link', { name: 'Directions' });
        expect(link).toHaveAttribute('href', expect.stringContaining('google.com/maps/search'));
        expect(link).toHaveAttribute('target', '_blank');
        expect(document.querySelectorAll('iframe').length).toBe(0);
    });

    it('does not offer to dial dispatch, whether a number is set or not', async () => {
        /* REMOVED 3 NOVEMBER as redundant: a driver has the dispatch number.
           It is the only place the number appeared to them, so the absence
           is worth pinning rather than letting a later change quietly put a
           phone card back on the one screen that is meant to be the stops.

           Both ways round, because the old behaviour differed: a number set
           drew the card, and no number drew nothing. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/832|dispatch number/i)).not.toBeInTheDocument();

        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': mine({ dispatch: { phone: '', name: 'Dispatch' } }) }));
        expect(screen.queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
        /* And still no instruction aimed at somebody who is not holding this
           phone, which is why the empty branch went silent in the first
           place. */
        expect(screen.queryByText(/operating settings/i)).not.toBeInTheDocument();
    });

    it('counts progress and moves the next stop along', async () => {
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{
                    ...mine().runs[0],
                    stops: [stop({ status: 'delivered' }), stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra' })],
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.getByText(/1 of 2 done/)).toBeInTheDocument();
        const next = screen.getByLabelText('Next stop');
        expect(within(next).getByText('Marcus Ibarra')).toBeInTheDocument();
    });

    it('says there is nothing to do rather than showing an empty page', async () => {
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': mine({ runs: [] }) }));
        expect(await screen.findByText('No stops assigned to you today.')).toBeInTheDocument();
    });

    it('says it cannot reach dispatch, instead of implying there is no work', async () => {
        // A courier in a basement with no signal must not read an empty
        // screen as "you are finished for the day".
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': { status: 503, body: { error: 'Service unavailable' } } }));
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByText('No stops assigned to you today.')).not.toBeInTheDocument();
    });

    it('marks completed stops without hiding them', async () => {
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [stop({ status: 'delivered' }), stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra' })] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        const list = screen.getByRole('list');
        expect(within(list).getByText('delivered')).toBeInTheDocument();
        expect(within(list).getByText('Ines Vargas')).toBeInTheDocument();
    });

    /* ── The round is on screen once it is assigned ────────────────────── */

    it('shows the round before any pickup is recorded', async () => {
        /* THIS USED TO BE THE OPPOSITE TEST. Until 3 November the whole list
           was replaced by "Collect first" until custody was taken, because
           an unrecorded pickup was the only evidence a courier had not
           started -- the sweep assigned work on its own. Dispatch now
           assigns every delivery by hand to a named driver on shift at that
           pharmacy, so the assignment is the decision the gate stood in
           for, and the driver it hid the round from is the one person told
           to drive it. Removed on the drivers' own feedback. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [stop({ status: 'assigned' })] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });

        expect(screen.getByLabelText('Next stop')).toBeInTheDocument();
        expect(screen.getAllByText('Ines Vargas').length).toBeGreaterThan(0);
        expect(screen.getAllByText(/1100 Broadway St/).length).toBeGreaterThan(0);
        expect(screen.getByRole('link', { name: 'Open the stop' })).toBeInTheDocument();
    });

    it('shows collected and uncollected stops together', async () => {
        /* The gate was all-or-nothing on purpose, so this was its mirror:
           one picked up and one still at the counter used to hide both.
           Both now show, and the one being carried leads. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [
                    stop({ status: 'assigned' }),
                    stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra', status: 'picked_up' }),
                ] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.getAllByText('Marcus Ibarra').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Ines Vargas').length).toBeGreaterThan(0);
        /* Carrying beats still-at-the-counter: the next stop is the one in
           the van, not stop 1. */
        expect(within(screen.getByLabelText('Next stop')).getByText('Marcus Ibarra')).toBeInTheDocument();
    });

    it('opens a finished stop too, and says it is the record rather than the form', async () => {
        /* THE GATE THAT COST MORE THAN IT PROTECTED (4 November 2026).
           A finished row had no link at all, so a blurred photograph of
           the signed form, or a dry run where the patient rang the
           pharmacy back and the driver got there again an hour later, was
           a telephone call to dispatch or went unrecorded.

           The label differs so nobody taps it on a delivered row
           expecting to record a delivery. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{
                    id: 10, courierUsername: 'ada.courier', serviceDate: '2026-09-14',
                    label: 'Noon wave', status: 'started', startedAt: null,
                    stops: [stop({ status: 'failed' })],
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });

        const open = await screen.findByRole('link', { name: 'Open the record' });
        expect(open).toHaveAttribute('href', '/projects/uh/orders/21/stop');
        expect(screen.queryByRole('link', { name: 'Open the stop' })).not.toBeInTheDocument();
    });

    /* ─────────────────────────────────────────────────────────────────────
     * WHICH DAY'S ROUND (4 November 2026).
     *
     * A photograph of the signed form that came out blurred is found
     * later, and the stop it belongs to is on the day it happened. The
     * stop screen can amend one now; without a way back to that day there
     * was nothing to open.
     *
     * The property these are really testing: the screen fixates on today
     * and only moves when a driver moves it.
     * ───────────────────────────────────────────────────────────────────── */

    it('asks for no day at all, so today is the SERVER\'s and not the phone\'s', async () => {
        /* A handset an hour out, or one that has crossed into tomorrow UTC
           while it is still Tuesday in San Antonio, must see the round it
           is driving. Reading a date off the browser and sending it is the
           bug this avoids, so the first request names no date. */
        const { calls } = renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        expect(calls).toContain('GET /api/projects/uh/uh/runs/mine');
        expect(calls.some((c) => c.includes('serviceDate='))).toBe(false);
    });

    it('fetches the day a driver picks, and says which day it is', async () => {
        const { calls } = renderRun(base({
            'GET /api/projects/uh/uh/runs/mine?serviceDate=2026-09-10': mine({
                serviceDate: '2026-09-10',
                runs: [{
                    id: 11, courierUsername: 'ada.courier', serviceDate: '2026-09-10',
                    label: 'Tuesday', status: 'completed', startedAt: null,
                    stops: [stop({ status: 'delivered' })],
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });

        fireEvent.change(screen.getByLabelText('Show the round for a day'), { target: { value: '2026-09-10' } });

        await waitFor(() => expect(calls).toContain('GET /api/projects/uh/uh/runs/mine?serviceDate=2026-09-10'));
        /* THE PICKER IS THE ONLY PLACE THE DATE IS WRITTEN. The heading
           line used to print it as text with the control underneath --
           two places saying which day, one of them inert. The title now
           says what KIND of day it is and the picker says which. */
        expect(await screen.findByRole('heading', { name: 'Earlier day' })).toBeInTheDocument();
        expect(screen.getByLabelText('Show the round for a day')).toHaveValue('2026-09-10');
        expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument();
    });

    it('offers a way back, and going back asks for no day again', async () => {
        const { calls } = renderRun(base({
            'GET /api/projects/uh/uh/runs/mine?serviceDate=2026-09-10': mine({ serviceDate: '2026-09-10', runs: [] }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        fireEvent.change(screen.getByLabelText('Show the round for a day'), { target: { value: '2026-09-10' } });
        await screen.findByRole('heading', { name: 'Earlier day' });

        const before = calls.length;
        fireEvent.click(screen.getByRole('button', { name: 'Back to today' }));

        await screen.findByRole('heading', { name: 'Today' });
        /* Unfiltered again, not ?serviceDate=<today>: the server decides
           what today is, every time. */
        expect(calls.slice(before)).toContain('GET /api/projects/uh/uh/runs/mine');
    });

    it('has no way back while it is already on today', async () => {
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByRole('button', { name: 'Back to today' })).not.toBeInTheDocument();
    });

    it('will not offer a day that has not happened', async () => {
        /* A round is assigned for a day that has arrived, and the reason
           this control exists is a proof of delivery on a day that has
           gone. Without the cap a mistyped year shows an empty round,
           which reads as "no work that day" rather than as a typo. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.getByLabelText('Show the round for a day')).toHaveAttribute('max', '2026-09-14');
    });

    it('drops the Next card on a day that has gone', async () => {
        /* There is no "next" on a finished day: anything still open on it
           was missed, not queued, and a card saying Next over it would
           send a driver to a door they are not due at. The list stays,
           which is what the day is being opened for. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine?serviceDate=2026-09-10': mine({
                serviceDate: '2026-09-10',
                runs: [{
                    id: 11, courierUsername: 'ada.courier', serviceDate: '2026-09-10',
                    label: 'Tuesday', status: 'started', startedAt: null,
                    /* Deliberately still open, which is the case that would
                       otherwise render a Next card for a day gone by. */
                    stops: [stop({ status: 'picked_up' })],
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        fireEvent.change(screen.getByLabelText('Show the round for a day'), { target: { value: '2026-09-10' } });
        await screen.findByRole('heading', { name: 'Earlier day' });

        expect(screen.queryByLabelText('Next stop')).not.toBeInTheDocument();
        /* And no paragraph explaining that it is an earlier day: the
           title is the date and there is a Back to today button beside
           it, which says the same thing in the space it already takes. */
        expect(screen.queryByText(/An earlier day/)).not.toBeInTheDocument();
        /* And the round itself is still there to be opened. */
        expect(screen.getAllByText('Ines Vargas').length).toBeGreaterThan(0);
    });

    it('shows the round in both places, the panel and the list', async () => {
        renderRun(base());
        /* Twice over: the Next card and the full list. getAllBy, because
           one of those appearing without the other would be the bug. */
        await screen.findByLabelText('Next stop');
        expect(screen.getAllByText('Ines Vargas').length).toBeGreaterThan(1);
        expect(screen.getAllByRole('link', { name: 'Open the stop' }).length).toBeGreaterThan(0);
        /* And the panel that used to stand in front of all of it is gone
           for good, not merely skipped for this fixture. */
        expect(screen.queryByRole('heading', { name: 'Collect first' })).not.toBeInTheDocument();
        expect(screen.queryByText(/stops appear once you have recorded the pickup/)).not.toBeInTheDocument();
    });

    /* ── The app's shape ──────────────────────────────────────────────── */

    it('keeps the upper region information and puts every control in the sheet', async () => {
        /* The split this screen was rebuilt around, and the one thing about
           it that is easy to undo by accident: somebody adds a button to the
           next-stop card because that is where the stop is, and the shape
           stops being the app's. Information above, actions under the thumb.
           Asserted as "no interactive element at all" rather than as a list
           of the ones that moved, so a new one cannot creep back in. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        const next = screen.getByLabelText('Next stop');
        expect(within(next).queryAllByRole('link')).toHaveLength(0);
        expect(within(next).queryAllByRole('button')).toHaveLength(0);

        /* THE CONTROLS ARE ON THE ROW, and only there. The sheet carried a
           second copy of all three until 3 November; what has to stay true
           is that the panel is information and the controls are reachable,
           not which of two places they are in. */
        expect(within(thisStop()).getByRole('link', { name: 'Open the stop' })).toBeInTheDocument();
        expect(within(thisStop()).getByRole('link', { name: 'Directions' })).toBeInTheDocument();
        /* AND NOWHERE ELSE. Counted against the list rather than against a
           number, because the fixture’s stop count is not the point: what
           is being pinned is that no copy of this control survives outside
           the row it belongs to. */
        const list = screen.getAllByRole('list')[0] as HTMLElement;
        expect(screen.getAllByRole('link', { name: 'Open the stop' }))
            .toHaveLength(within(list).getAllByRole('link', { name: 'Open the stop' }).length);
    });

    it('names a card after its action, not after the whole card', async () => {
        /* A card is a glyph, a verb and a sentence under it, and left alone
           its accessible name is all three: "My deliveries Everything you
           have finished". That is a name no two cards can share even when
           they are the same action, so a voice-control user asking for "My
           deliveries" matches nothing and a screen reader reads a paragraph.

           The detail is still announced -- as a description. Both halves are
           asserted, because pinning the name by DELETING the explanation
           would pass the first half and be a worse screen.

           Pointed at My deliveries since 3 November: the cards this was
           written for have all moved or gone, and the rule belongs to
           CardLink rather than to any one of them. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        const card = screen.getByRole('link', { name: 'My deliveries' });
        expect(card.getAttribute('aria-describedby')).not.toBeNull();
        expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent)
            .toContain('Everything you have finished');
    });

    it('offers no way to record a collection, because there is no longer one', async () => {
        /* Drivers stopped recording collections on 3 November -- the server
           writes the custody event itself when a courier first acts on a
           delivery. The card, the screen and the endpoint behind it all went
           together, which is the part worth pinning: a card that opens a
           route nobody serves is worse than no card. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [stop({ status: 'assigned' })] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByRole('link', { name: /Collect/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/waiting to be picked up/)).not.toBeInTheDocument();
    });

    it('keeps the once-a-day jobs off the screen that is about the stops', async () => {
        /* MOVED 2 NOVEMBER, not dropped. Take back undelivered now sits
           under the earnings on My deliveries -- the screen a courier opens
           at the end of a round, which is the same moment they are standing
           at a van with packages that did not go out. The discrepancy form
           went to You, with the other things that are about them rather than
           about a stop. Their own screens pin that they arrived.

           Refresh went entirely: every screen re-reads on its own, and a
           button whose job is "try that again" teaches a courier that the
           screen cannot be trusted without it. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByRole('link', { name: 'Take back undelivered' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Something did not match' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Refresh/ })).not.toBeInTheDocument();
    });

    it('says nothing about PINs, on a set-up phone or an unenrolled one', async () => {
        /* The offer lived here from ticket 5.4 until it came out again: a
           setup task on a working screen, shown to a courier mid-round and
           repeated every day until acted on. Enrolment is still reachable
           from Your account, which is where a setting belongs.
         
           Both device answers, because the prompt was keyed on one of them
           and a regression would only show on that branch. */
        renderRun(base({ 'GET /api/login/device': { enrolled: false } }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByText(/PIN/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Set up this phone' })).not.toBeInTheDocument();
    });
});
