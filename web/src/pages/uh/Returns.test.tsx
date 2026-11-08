/* The take-back screen.

   The rules worth testing: the destination is shown with its reason rather
   than left to the courier to work out, the count is not pre-filled, a
   mismatch needs a reason before anything is sent, and the orders the courier
   was looking at are the orders that get handed back. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Returns } from './Returns';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';
import { IDBFactory } from 'fake-indexeddb';
import { queued, resetOutboxForTests } from '../../lib/outbox';

const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const RETURNS = '/api/projects/uh/uh/returns';

const order = (id: number, over: Record<string, unknown> = {}) => ({
    orderId: id, recipientName: `Recipient ${id}`, externalRef: `RX-${id}`,
    packages: 1, from: 'Discharge Pharmacy', failureReason: 'no access', ...over,
});

const load = (over: Record<string, unknown> = {}) => ({
    courierUsername: 'ada.courier',
    destinations: [{
        site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' },
        reason: 'after_hours',
        why: 'The pharmacy it came from is closed, so it goes to the after-hours pharmacy.',
        orders: [order(21), order(22, { packages: 2 })],
        packages: 3,
    }],
    totals: { orders: 2, packages: 3 },
    notes: [],
    ...over,
});

const routes = (over: Record<string, unknown> = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    [`GET ${RETURNS}`]: load(),
    ...over,
});

function renderReturns(r: Record<string, unknown> = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/returns']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/returns" element={<Returns />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

/* Part 3 of the docket, photographed. The pharmacy's pad went on 19 October:
   they sign the paper, the courier photographs it. */
function attachForm() {
    const input = screen.getByLabelText(/Photo of the signed form/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], 'part3.jpg', { type: 'image/jpeg' })] } });
}

/** The three steps the uploader takes, so a test can reach a bucket. */
const fileRoutes = {
    'POST /api/projects/uh/uh/files': { id: 77, upload: { url: 'https://bucket.test/put', method: 'PUT', headers: {} } },
    'PUT https://bucket.test/put': { ok: true },
    'POST /api/projects/uh/uh/files/77/stored': { ok: true },
};

function sign() {
    const pad = screen.getByRole('application', { name: 'Pharmacy signature' });
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    if (!pad.setPointerCapture) pad.setPointerCapture = () => {};
    pad.releasePointerCapture = () => {};
    const point = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number, clientY: number) => {
        const evt = (createEvent as unknown as Record<string, (el: Element, init: object) => Event>)[type]!(pad, { pointerId: 1 });
        Object.defineProperty(evt, 'clientX', { value: clientX });
        Object.defineProperty(evt, 'clientY', { value: clientY });
        fireEvent(pad, evt);
    };
    point('pointerDown', 20, 50);
    point('pointerMove', 80, 20);
    point('pointerMove', 140, 60);
    point('pointerUp', 140, 60);
}

const bodyOf = (fn: ReturnType<typeof mockFetch>['fn'], key: string) => {
    const call = fn.mock.calls.find(([url, init]) => `${((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${String(url)}` === key);
    return JSON.parse(String((call?.[1] as RequestInit).body));
};

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 29.5, longitude: -98.6 } } as GeolocationPosition) },
    });
});

describe('Returns', () => {
    it('says where the packages go and why, rather than asking the courier', async () => {
        renderReturns();
        expect(await screen.findByRole('heading', { name: 'Take back' })).toBeInTheDocument();
        // The destination is a choice with its reason attached, not a bare name.
        const choice = screen.getByRole('radio', { name: /Discharge Pharmacy/ });
        expect(choice).toBeInTheDocument();
        expect(screen.getByText(/goes to the after-hours pharmacy/)).toBeInTheDocument();
        // One destination, so it is already selected: nothing to tap.
        expect(choice).toBeChecked();
    });

    it('does not pre-fill the count', async () => {
        // Same reason as the pickup screen: a filled-in number turns
        // "confirm the count" into "tap continue".
        renderReturns();
        await screen.findByRole('heading', { name: 'Take back' });
        expect((screen.getByLabelText('Packages counted') as HTMLInputElement).value).toBe('');
    });

    it('will not hand anything back without a name and the signed form', async () => {
        renderReturns();
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });

        const submit = screen.getByRole('button', { name: /Hand back/ });
        expect(submit).toBeDisabled();
        expect(screen.getByText(/Add the printed name/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeDisabled();
        attachForm();
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeEnabled();
    });

    it('asks why when the count does not match, and blocks until it is answered', async () => {
        renderReturns();
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        attachForm();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '2' } });

        expect(screen.getByText(/These orders cover 3/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'One box stayed at the front desk' } });
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeEnabled();
    });

    it('sends the orders the courier was looking at, with the position', async () => {
        const { fn } = renderReturns({
            ...routes(),
            ...fileRoutes,
            [`POST ${RETURNS}`]: { status: 201, body: { returned: [21, 22], refused: [], discrepancy: 0, notes: [] } },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        attachForm();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByText(/Handed back 2 orders/)).toBeInTheDocument());
        const body = bodyOf(fn, `POST ${RETURNS}`);
        expect(body).toMatchObject({
            siteId: 7, signedName: 'Night Pharmacist', countedPackages: 3,
            orderIds: [21, 22], lat: 29.5, lng: -98.6,
        });
        /* The photograph of part 3 is the proof now; strokes go empty
           rather than absent, so every return already recorded with a drawn
           signature still means what it meant. */
        expect(body.courierFormFileId).toBe(77);
        /* ABSENT, NOT EMPTY. `strokes: []` used to ride along to keep the
           column's shape. Nothing captures a signature here any more, so a
           field that could only ever be empty told a reader of the request
           nothing, and hid the difference between "captured none" and
           "cannot capture". The server defaults it. */
        expect(body.strokes).toBeUndefined();
    });

    it('shows the server refusal rather than a generic failure', async () => {
        renderReturns({
            ...routes(),
            ...fileRoutes,
            [`POST ${RETURNS}`]: { status: 400, body: { error: '2 of these should have gone somewhere else. Add a note saying why they came here.', code: 'returns.offRule' } },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        attachForm();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('should have gone somewhere else'));
    });

    it('warns when no after-hours pharmacy is configured', async () => {
        renderReturns({
            ...routes(),
            ...fileRoutes,
            [`GET ${RETURNS}`]: load({
                destinations: [{
                    site: { id: 9, code: 'pavilion', name: 'Pavilion Pharmacy' },
                    reason: 'after_hours_site_missing',
                    why: 'The after-hours pharmacy is not configured for this project, so this falls back to the pharmacy it came from. Check the return settings.',
                    orders: [order(31)], packages: 1,
                }],
                totals: { orders: 1, packages: 1 },
            }),
        });
        await screen.findByRole('heading', { name: 'Take back' });
        expect(screen.getByText(/No after-hours pharmacy is set/)).toBeInTheDocument();
        expect(screen.getByText(/call dispatch rather than leaving them in the van/)).toBeInTheDocument();
    });

    it('says plainly when the van is empty', async () => {
        renderReturns({
            ...routes(),
            ...fileRoutes,
            [`GET ${RETURNS}`]: load({ destinations: [], totals: { orders: 0, packages: 0 }, notes: ['Nothing undelivered is still with you.'] }),
        });
        await screen.findByRole('heading', { name: 'Take back' });
        expect(screen.getByText('Nothing undelivered is still with you.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Hand back/ })).not.toBeInTheDocument();
    });

    it('says these still count as attempted, because taking them back does not undo that', async () => {
        renderReturns();
        await screen.findByRole('heading', { name: 'Take back' });
        expect(screen.getByText(/still count as attempted/)).toBeInTheDocument();
    });
});

describe('the camera beside the photo field', () => {
    it('is gone: the file chooser is the only way in, and it works', async () => {
        /* IT WAS A SECOND DOOR WE BUILT OURSELVES, on 31 October, after a
           courier tapped the field, chose Take Photo and got a black frame.
           The operating system's chooser turned out to be fine -- on both
           collection and drop-off -- and the extra button sat under the
           field confusing the one screen a driver uses at a doorstep.
           Removed 2 November at the owner's instruction.

           accept="image/*" is what keeps this whole: on a phone that
           chooser still offers Take Photo as well as the library, so
           nothing was lost by taking our own camera away. */
        renderReturns();
        const field = await screen.findByLabelText(/Photo of the signed form/);
        expect(field).toHaveAttribute('accept', 'image/*');
        expect(screen.queryByRole('button', { name: 'Take a picture' })).not.toBeInTheDocument();
    });
});

/* ────────────────────────────────── THE SCREEN STAFF COULD NOT OPEN
 *
 * The server has always required staff to name whose load they mean, and
 * this screen never asked: it called GET /returns bare, got a 400, and
 * rendered a page with no counter and therefore no slot to photograph the
 * signed form into. Taking undelivered items off a driver is half of what
 * the site manager role was created for.
 *
 * So the first thing staff see is who is carrying something. A COURIER MUST
 * NEVER SEE IT -- their own load needs no argument, and the list would tell
 * them what their colleagues are holding.
 */
describe('whose load, for staff', () => {
    const staffProjects = (role: string) => [{ ...projects[0], role }];
    const OUTSTANDING = `${RETURNS}/outstanding`;

    const outstanding = {
        couriers: [
            { username: 'ada.courier', name: 'Ada Courier', orders: 2, packages: 3 },
            { username: 'ben.courier', name: 'Ben Courier', orders: 1, packages: 1 },
        ],
        totals: { couriers: 2, orders: 3, packages: 4 },
        notes: [],
    };

    function renderAs(role: string, over: Record<string, unknown> = {}) {
        return renderReturns({
            ...routes(),
            'GET /api/me/projects': staffProjects(role),
            [`GET ${OUTSTANDING}`]: outstanding,
            ...over,
        });
    }

    for (const role of ['admin', 'lead']) {
        it(`opens on the couriers carrying something for ${role}`, async () => {
            renderAs(role);
            expect(await screen.findByRole('button', { name: /Ada Courier/ })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Ben Courier/ })).toBeInTheDocument();
            /* The form is NOT on screen yet: there is no counter to hand
               anything over until somebody's van has been chosen. */
            expect(screen.queryByLabelText(/Photo of the signed form/)).not.toBeInTheDocument();
        });
    }

    it('loads that courier load, named in the request, once one is chosen', async () => {
        const scoped = `${RETURNS}?courier=ada.courier`;
        const mocked = renderAs('admin', { [`GET ${scoped}`]: load() });

        fireEvent.click(await screen.findByRole('button', { name: /Ada Courier/ }));

        /* THE USERNAME IS THE KEY, not the display name: everything else in
           the system joins on it, and the picker is where a wrong one would
           be introduced. */
        await waitFor(() => expect(mocked.calls).toContain(`GET ${scoped}`));
        expect(await screen.findByLabelText(/Photo of the signed form/)).toBeInTheDocument();
        /* Whose load it is, said on screen. "Still with you" would be a lie
           on a dispatcher's monitor. */
        expect(screen.getByText(/Still with Ada Courier/)).toBeInTheDocument();
    });

    it('never shows the picker to a courier, and never asks who they are', async () => {
        const mocked = renderReturns();
        /* Straight to the form: the courier path is untouched. */
        expect(await screen.findByLabelText(/Photo of the signed form/)).toBeInTheDocument();
        expect(screen.getByText(/Still with you/)).toBeInTheDocument();
        expect(mocked.calls).toContain(`GET ${RETURNS}`);
        expect(mocked.calls.some((c) => c.includes('outstanding'))).toBe(false);
        expect(mocked.calls.some((c) => c.includes('courier='))).toBe(false);
    });

    it('says so plainly when nothing is out, rather than showing an empty form', async () => {
        renderAs('admin', {
            [`GET ${OUTSTANDING}`]: { couriers: [], totals: { couriers: 0, orders: 0, packages: 0 }, notes: [] },
        });
        expect(await screen.findByText(/Nothing undelivered is still out with a courier/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/Photo of the signed form/)).not.toBeInTheDocument();
    });
});

/* ───────────────────── A COUNTER WITH NO SIGNAL
 *
 * A return happens inside a pharmacy -- the one place on a round with a
 * concrete stockroom between the phone and the sky -- and at the end of a
 * shift, when there is no coming back to try again.
 *
 * This screen used to upload the photograph by hand before it called
 * sendOrQueue, and return early when that threw. So with no signal nothing
 * was queued: a courier holding medication a pharmacist had just signed for
 * was told to try again, and could not hand it back at all. The comment on
 * that code claimed it followed "the same rule the door and the counter
 * follow", and the door does the opposite -- it hands its photographs to
 * the outbox and lets it wait.
 *
 * It now tries live first, because the server's refusals are correctable by
 * the person standing there, and falls back to the queue for anything that
 * is not a 4xx.
 */
describe('when it cannot be sent right now', () => {
    /* A FRESH INDEXEDDB PER TEST, not just a reset of the module's
       handles: resetOutboxForTests drops the cached connection and nothing
       else, so entries queued by one test are still in the store for the
       next one -- and a test asserting that NOTHING was queued would read
       the previous test's hand-back and fail for the wrong reason. Same
       pattern as Stop.test.tsx. */
    beforeEach(() => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        resetOutboxForTests();
    });

    /** Fill the form in, ready to submit. */
    const fillIn = () => {
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        attachForm();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
    };

    it('queues the hand-back, with its photograph, when the upload cannot go', async () => {
        /* The file service unreachable: a 503 is what a restart looks like,
           and putPhoto turns it into a retry rather than a refusal. */
        const mocked = renderReturns({
            ...routes(),
            ...fileRoutes,
            'POST /api/projects/uh/uh/files': { status: 503, body: { error: 'upstream' } },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fillIn();
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        /* NOT AN ERROR. The hand-back is on the phone. */
        await waitFor(() => expect(screen.getByText(/Saved on this phone/)).toBeInTheDocument());

        const waiting = await queued();
        expect(waiting.length).toBe(1);
        /* Bound rather than indexed four times. noUncheckedIndexedAccess is
           on, so `waiting[0].photos` is a type error -- and the build runs
           tsc while vitest does not, which is how a green test run shipped
           a failing deploy once already. */
        const entry = waiting[0]!;
        /* WITH THE PICTURE. An entry queued without it would post a return
           the server refuses for a missing fileId -- which is the shape of
           the bug this replaced, one layer down. */
        expect(entry.photos?.length).toBe(1);
        expect(entry.photos?.[0]?.kind).toBe('courier_form');
        expect(entry.photos?.[0]?.bodyKey).toBe('courierFormFileId');
        /* And the hand-back itself, so the flush has something to send. */
        expect(entry.body).toMatchObject({
            siteId: 7, signedName: 'Night Pharmacist', countedPackages: 3, orderIds: [21, 22],
        });
        /* The id is NOT in the queued body: the outbox puts it there once
           the picture is actually in the bucket. */
        expect(entry.body.courierFormFileId).toBeUndefined();

        /* It did try to send it for real first. */
        expect(mocked.calls).toContain('POST /api/projects/uh/uh/files');
    });

    it('queues it when the request itself never leaves the building', async () => {
        const mocked = renderReturns({ ...routes(), ...fileRoutes });
        await screen.findByRole('heading', { name: 'Take back' });

        /* Signal that drops mid-submit: the network is "up" and fetch
           rejects, which is the realistic failure in a stockroom and the
           one navigator.onLine does not report. */
        mocked.fn.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
        fillIn();
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByText(/Saved on this phone/)).toBeInTheDocument());
        expect((await queued()).length).toBe(1);
    });

    /* THE OTHER HALF, and the reason it tries live at all. */
    it('does not queue a refusal the courier can fix on the spot', async () => {
        renderReturns({
            ...routes(),
            ...fileRoutes,
            [`POST ${RETURNS}`]: {
                status: 400,
                body: { error: '2 of these should have gone somewhere else. Add a note saying why they came here.', code: 'returns.offRule' },
            },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fillIn();
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('should have gone somewhere else'));
        /* IN THE QUEUE IT WOULD BE A REJECTED ENTRY somebody finds hours
           later, long after the courier drove home -- for a mistake that
           takes one sentence to fix while they are standing there. */
        expect(await queued()).toEqual([]);
        expect(screen.queryByText(/Saved on this phone/)).toBeNull();
    });

    it('keeps what was typed, so the note can be added and sent again', async () => {
        renderReturns({
            ...routes(),
            ...fileRoutes,
            [`POST ${RETURNS}`]: { status: 400, body: { error: 'Add a note saying why they came here.', code: 'returns.offRule' } },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fillIn();
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        /* A refusal that cleared the form would make the fix a re-entry:
           the name, the count and the photograph all over again, at a
           counter, to add one sentence. */
        expect((screen.getByLabelText('Printed name') as HTMLInputElement).value).toBe('Night Pharmacist');
        expect((screen.getByLabelText('Packages counted') as HTMLInputElement).value).toBe('3');
    });
});
