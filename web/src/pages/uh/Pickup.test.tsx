/* The pickup screen and the signature pad.

   The rules worth testing are the ones that decide whether the proof of
   delivery is worth anything: you cannot submit a name without a signature,
   you cannot submit a mismatched count without a reason, and the count is
   never pre-filled with the answer. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Pickup } from './Pickup';
import { strokePath, pointCount } from './SignaturePad';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];

const waiting = (over = {}) => ({
    runId: 10,
    courierUsername: 'ada.courier',
    sites: [{
        site: { id: 7, code: 'discharge', name: 'Discharge Pharmacy' },
        orders: [
            { orderId: 21, sequence: 1, recipientName: 'Ines Vargas', externalRef: 'RX-1', packages: 2 },
            { orderId: 22, sequence: 2, recipientName: 'Marcus Ibarra', externalRef: 'RX-2', packages: 1 },
        ],
        packages: 3,
    }],
    totals: { orders: 2, packages: 3 },
    ...over,
});

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/runs/10/pickup': waiting(),
    ...over,
});

function renderPickup(r = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/runs/10/pickup']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/runs/:runId/pickup" element={<Pickup />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

/** Draw on the pad. jsdom has no layout, so the box is given a size first. */
function sign() {
    const pad = screen.getByRole('application', { name: 'Pharmacy signature' });
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    if (!pad.setPointerCapture) pad.setPointerCapture = () => {};
    pad.releasePointerCapture = () => {};
    /* jsdom has no PointerEvent, so a pointer event built by fireEvent
       arrives with no clientX and the pad would record nothing. Build the
       event, put the coordinates on it, then fire it. */
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

beforeEach(() => {
    // jsdom has neither of these; the pad measures itself with one and the
    // screen asks for a position with the other.
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 29.5, longitude: -98.6 } } as GeolocationPosition) },
    });
});

describe('SignaturePad helpers', () => {
    it('renders strokes as a path in the captured 0..1 space', () => {
        const path = strokePath([{ x: 0, y: 0, t: 0 }, { x: 0.5, y: 1, t: 10 }], 200, 100);
        expect(path).toBe('M0.0,0.0 L100.0,100.0');
    });

    it('counts points across every stroke', () => {
        expect(pointCount([])).toBe(0);
        expect(pointCount([[{ x: 0, y: 0, t: 0 }], [{ x: 1, y: 1, t: 1 }, { x: 0, y: 1, t: 2 }]])).toBe(3);
    });
});

describe('Pickup', () => {
    it('shows what is waiting, without pre-filling the count', async () => {
        // Pre-filling the expected number would turn "confirm the count" into
        // "tap continue", which is the failure this screen exists to prevent.
        renderPickup();
        expect(await screen.findByRole('heading', { name: 'Pick up' })).toBeInTheDocument();
        expect(screen.getByText(/2 orders for this pharmacy/)).toBeInTheDocument();
        expect((screen.getByLabelText('Packages counted') as HTMLInputElement).value).toBe('');
    });

    it('will not submit a printed name without a signature', async () => {
        renderPickup();
        await screen.findByRole('heading', { name: 'Pick up' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });

        const submit = screen.getByRole('button', { name: /Take custody/ });
        expect(submit).toBeDisabled();
        expect(screen.getByText(/Add the signature/)).toBeInTheDocument();
    });

    it('will not submit a signature without a printed name', async () => {
        renderPickup();
        await screen.findByRole('heading', { name: 'Pick up' });
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        sign();
        expect(screen.getByRole('button', { name: /Take custody/ })).toBeDisabled();
        expect(screen.getByText(/Add the printed name/)).toBeInTheDocument();
    });

    it('asks why when the count does not match, and blocks until it is answered', async () => {
        renderPickup();
        await screen.findByRole('heading', { name: 'Pick up' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '2' } });

        expect(screen.getByText(/The list expects 3/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Take custody/ })).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'One item not ready' } });
        await waitFor(() => expect(screen.getByRole('button', { name: /Take custody/ })).toBeEnabled());
    });

    it('sends the batch, the signature and the position in one request', async () => {
        const { fn, calls } = renderPickup(routes({
            'POST /api/projects/uh/uh/runs/10/pickup': {
                collected: [21, 22], refused: [], expectedPackages: 3, countedPackages: 3,
                discrepancy: 0, notes: [], remaining: [],
            },
        }));
        await screen.findByRole('heading', { name: 'Pick up' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Take custody/ }));

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs/10/pickup'));
        const post = fn.mock.calls.find(([, init]) => init?.method === 'POST');
        const body = JSON.parse(String(post?.[1]?.body));
        expect(body).toMatchObject({ siteId: 7, signedName: 'Pharmacy Tech', countedPackages: 3, lat: 29.5, lng: -98.6 });
        expect(body.strokes[0].length).toBeGreaterThan(2);
        // Captured in a 0..1 space so it does not depend on the phone's screen.
        for (const p of body.strokes[0]) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(1);
        }
        expect(await screen.findByText(/Collected 2 orders/)).toBeInTheDocument();
    });

    it('carries on without a position when the phone refuses', async () => {
        // A courier inside a building will often have no fix; that must not
        // stop the handover being recorded.
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: { getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) => fail({ code: 1 } as GeolocationPositionError) },
        });
        const { fn, calls } = renderPickup(routes({
            'POST /api/projects/uh/uh/runs/10/pickup': {
                collected: [21, 22], refused: [], expectedPackages: 3, countedPackages: 3,
                discrepancy: 0, notes: ['No location was recorded for this pickup.'], remaining: [],
            },
        }));
        await screen.findByRole('heading', { name: 'Pick up' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Take custody/ }));

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs/10/pickup'));
        const post = fn.mock.calls.find(([, init]) => init?.method === 'POST');
        const body = JSON.parse(String(post?.[1]?.body));
        expect(body.lat).toBeUndefined();
        expect(await screen.findByText(/No location was recorded/)).toBeInTheDocument();
    });

    it('shows the server refusal rather than looking like it worked', async () => {
        renderPickup(routes({
            'POST /api/projects/uh/uh/runs/10/pickup': {
                status: 409, body: { error: 'Nothing on this run is waiting to be collected from that pharmacy.' },
            },
        }));
        await screen.findByRole('heading', { name: 'Pick up' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Take custody/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing on this run is waiting/);
    });

    it('keeps every point of a fast stroke, not just the ends', async () => {
        /* pointermove fires faster than React re-renders and the updates are
           batched, so reading the prop in each handler collapses the stroke to
           its first and last point per batch: a signature recorded as straight
           lines. This fires a burst synchronously, which is what a real finger
           produces. */
        const { fn, calls } = renderPickup(routes({
            'POST /api/projects/uh/uh/runs/10/pickup': {
                collected: [21, 22], refused: [], expectedPackages: 3, countedPackages: 3,
                discrepancy: 0, notes: [], remaining: [],
            },
        }));
        await screen.findByRole('heading', { name: 'Pick up' });

        const pad = screen.getByRole('application', { name: 'Pharmacy signature' });
        pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
        pad.setPointerCapture = () => {};
        pad.releasePointerCapture = () => {};
        const point = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number, clientY: number) => {
            const evt = (createEvent as unknown as Record<string, (el: Element, init: object) => Event>)[type]!(pad, { pointerId: 1 });
            Object.defineProperty(evt, 'clientX', { value: clientX });
            Object.defineProperty(evt, 'clientY', { value: clientY });
            fireEvent(pad, evt);
        };
        point('pointerDown', 10, 50);
        for (let i = 1; i <= 20; i += 1) point('pointerMove', 10 + i * 8, 50 + (i % 2 === 0 ? 20 : -20));
        point('pointerUp', 170, 50);

        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Take custody/ }));
        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/runs/10/pickup'));

        const post = fn.mock.calls.find(([, init]) => init?.method === 'POST');
        const body = JSON.parse(String(post?.[1]?.body));
        expect(body.strokes).toHaveLength(1);
        // One down plus twenty moves; the up ends the stroke without adding a
        // point. Before the fix this collapsed to 2.
        expect(body.strokes[0].length).toBe(21);
    });

    it('still records the stroke when the browser refuses pointer capture', async () => {
        // Capture throws on a pointer the browser does not recognise. Losing
        // it costs an edge case; letting it throw would abort the signature
        // before a single point was kept.
        renderPickup();
        await screen.findByRole('heading', { name: 'Pick up' });
        const pad = screen.getByRole('application', { name: 'Pharmacy signature' });
        pad.setPointerCapture = () => { throw new DOMException('InvalidPointerId'); };
        sign();
        expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Pharmacy Tech' } });
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        await waitFor(() => expect(screen.getByRole('button', { name: /Take custody/ })).toBeEnabled());
    });

    it('clears the signature when asked, so a wrong one is not submitted', async () => {
        renderPickup();
        await screen.findByRole('heading', { name: 'Pick up' });
        sign();
        const clear = screen.getByRole('button', { name: 'Clear' });
        expect(clear).toBeEnabled();
        fireEvent.click(clear);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled());
    });

    it('says there is nothing left rather than showing an empty form', async () => {
        renderPickup(routes({
            'GET /api/projects/uh/uh/runs/10/pickup': waiting({ sites: [], totals: { orders: 0, packages: 0 } }),
        }));
        expect(await screen.findByText('Nothing left to collect on this run.')).toBeInTheDocument();
        expect(screen.queryByLabelText('Packages counted')).not.toBeInTheDocument();
    });

    it('lists the batch so a courier can check it against the counter', async () => {
        renderPickup();
        await screen.findByRole('heading', { name: 'Pick up' });
        const details = screen.getByText('What is in this batch').closest('details')!;
        expect(within(details).getByText(/Ines Vargas/)).toBeInTheDocument();
        expect(within(details).getByText(/Marcus Ibarra/)).toBeInTheDocument();
    });
});
