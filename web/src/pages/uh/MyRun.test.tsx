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
import { render, screen, within, fireEvent } from '@testing-library/react';
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
    return render(
        <MemoryRouter initialEntries={['/projects/uh/my-run']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/my-run" element={<MyRun />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
}

/** The sheet's controls for the stop a courier is driving to right now. */
const thisStop = () => screen.getByRole('group', { name: 'This stop' });

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

    it('dials dispatch in one tap', async () => {
        renderRun(base());
        const call = await screen.findByRole('link', { name: /Call Izy dispatch/ });
        // Stripped to digits so the phone dialler accepts it.
        expect(call).toHaveAttribute('href', 'tel:2105550100');
    });

    it('hides the call button rather than offering a number nobody set, and says nothing about it', async () => {
        /* It used to explain the absence: "an administrator adds one in the
           project's operating settings". That is an instruction for somebody
           who is not holding this phone, printed on the screen a driver
           works from, and the driver reading it is the one person who cannot
           act on it. */
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': mine({ dispatch: { phone: '', name: 'Dispatch' } }) }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/dispatch number/i)).not.toBeInTheDocument();
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

    /* ── Nothing until it is collected ─────────────────────────────────── */

    it('hides the whole round until the pickup is recorded', async () => {
        /* The names and addresses of people expecting medication, for a
           round the courier has not taken custody of yet, on a phone open
           at a pharmacy counter. Custody is the line. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [stop({ status: 'assigned' })] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });

        expect(screen.getByRole('heading', { name: 'Collect first' })).toBeInTheDocument();
        expect(screen.getByText(/Your stops appear once you have recorded the pickup/)).toBeInTheDocument();

        /* Not the name, not the address, not the deadline, and no way in. */
        expect(screen.queryByText('Ines Vargas')).not.toBeInTheDocument();
        expect(screen.queryByText(/1100 Broadway St/)).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Next stop')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Open the stop' })).not.toBeInTheDocument();
    });

    it('hides all of it, not merely the uncollected ones', async () => {
        /* A partial list is the same disclosure made quieter, and a courier
           part-way through a pickup should be finishing it. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [
                    stop({ status: 'assigned' }),
                    stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra', status: 'picked_up' }),
                ] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByText('Marcus Ibarra')).not.toBeInTheDocument();
        expect(screen.queryByText('Ines Vargas')).not.toBeInTheDocument();
    });

    it('shows the round the moment everything is collected', async () => {
        renderRun(base());
        /* Twice over: the Next card and the full list. getAllBy, because
           one of those appearing without the other would be the bug. */
        await screen.findByLabelText('Next stop');
        expect(screen.getAllByText('Ines Vargas').length).toBeGreaterThan(1);
        expect(screen.getAllByRole('link', { name: 'Open the stop' }).length).toBeGreaterThan(0);
        expect(screen.queryByRole('heading', { name: 'Collect first' })).not.toBeInTheDocument();
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

        /* And the controls for it are together, in the sheet, named. */
        const sheet = thisStop();
        expect(within(sheet).getByRole('link', { name: 'Open the stop' })).toBeInTheDocument();
        expect(within(sheet).getByRole('link', { name: 'Directions' })).toBeInTheDocument();
    });

    it('names a card after its action, not after the whole card', async () => {
        /* A card is a glyph, a verb and a sentence under it, and left alone
           its accessible name is all three: "Open the stop Stop 1 for Ines
           Vargas". That is a name no two cards can share even when they are
           the same action, so a voice-control user asking for "Open the
           stop" matches nothing and a screen reader reads a paragraph.

           The detail is still announced — as a description. Both halves are
           asserted, because pinning the name by DELETING the explanation
           would pass the first half and be a worse screen. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        /* Scoped, because the list below has one per row and they share this
           name — which is the point: before this they could not. */
        const open = within(thisStop()).getByRole('link', { name: 'Open the stop' });
        expect(open.getAttribute('aria-describedby')).not.toBeNull();
        expect(document.getElementById(open.getAttribute('aria-describedby')!)?.textContent)
            .toContain('Stop 1 for Ines Vargas');
    });

    it('offers to collect from a pharmacy rather than naming a run number', async () => {
        /* It used to read "Pick up for run 10". A driver has no idea what
           run 10 is and does not need to: what they need is that there is
           something at a counter and how much of it. The app's wording. */
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [stop({ status: 'assigned' }), stop({ sequence: 2, orderId: 22, status: 'assigned' })] }],
            }),
        }));
        const collect = await screen.findByRole('link', { name: 'Collect from a pharmacy' });
        expect(collect).toHaveAttribute('href', '/projects/uh/runs/10/pickup');
        expect(screen.queryByText(/run 10/i)).not.toBeInTheDocument();
        expect(document.getElementById(collect.getAttribute('aria-describedby')!)?.textContent)
            .toContain('2 orders are waiting');
    });

    it('offers the way back and the way to complain on every run, finished or not', async () => {
        /* Both were a grey link in a row at the bottom. A package can sit in
           a van overnight, and a screen that hides the way to hand it back
           is how it stays there; the discrepancy form is the only screen the
           people at the door have for the shadow week. */
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.getByRole('link', { name: 'Take back undelivered' }))
            .toHaveAttribute('href', '/projects/uh/returns');
        expect(screen.getByRole('link', { name: 'Something did not match' }))
            .toHaveAttribute('href', '/projects/uh/discrepancies');
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
