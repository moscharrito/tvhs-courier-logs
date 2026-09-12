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

    it('will not hand anything back without a name and a signature', async () => {
        renderReturns();
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });

        const submit = screen.getByRole('button', { name: /Hand back/ });
        expect(submit).toBeDisabled();
        expect(screen.getByText(/Add the printed name/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeDisabled();
        sign();
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeEnabled();
    });

    it('asks why when the count does not match, and blocks until it is answered', async () => {
        renderReturns();
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '2' } });

        expect(screen.getByText(/These orders cover 3/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'One box stayed at the front desk' } });
        expect(screen.getByRole('button', { name: /Hand back/ })).toBeEnabled();
    });

    it('sends the orders the courier was looking at, with the position', async () => {
        const { fn } = renderReturns({
            ...routes(),
            [`POST ${RETURNS}`]: { status: 201, body: { returned: [21, 22], refused: [], discrepancy: 0, notes: [] } },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByText(/Handed back 2 orders/)).toBeInTheDocument());
        const body = bodyOf(fn, `POST ${RETURNS}`);
        expect(body).toMatchObject({
            siteId: 7, signedName: 'Night Pharmacist', countedPackages: 3,
            orderIds: [21, 22], lat: 29.5, lng: -98.6,
        });
        expect(body.strokes[0].length).toBeGreaterThan(2);
    });

    it('shows the server refusal rather than a generic failure', async () => {
        renderReturns({
            ...routes(),
            [`POST ${RETURNS}`]: { status: 400, body: { error: '2 of these should have gone somewhere else. Add a note saying why they came here.', code: 'returns.offRule' } },
        });
        await screen.findByRole('heading', { name: 'Take back' });
        fireEvent.change(screen.getByLabelText('Printed name'), { target: { value: 'Night Pharmacist' } });
        sign();
        fireEvent.change(screen.getByLabelText('Packages counted'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: /Hand back/ }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('should have gone somewhere else'));
    });

    it('warns when no after-hours pharmacy is configured', async () => {
        renderReturns({
            ...routes(),
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
