/* The staff order screen and the detail page.

   Two things matter beyond rendering. The filters have to reach the server
   as a query, because filtering in the browser would only filter the page
   that was already fetched. And the detail page has to show the custody
   signatures rather than summarising them away, since that is the proof of
   delivery Scope 1.2.8 asks for. */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Orders, slaLabel, type Sla } from './Orders';
import { OrderDetail } from './OrderDetail';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'dispatcher' }];
const session = { id: 9, username: 'dispatch', name: 'Dispatcher One', role: 'staff', route: null };

const sites = [
    { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy', type: 'pharmacy', addressLine: '', city: '', state: 'TX', zip: '78229', fullAddress: '', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
];

const sla = (over: Partial<Sla> = {}): Sla => ({ state: 'open', minutesToDue: 45, onTime: null, measuredAt: null, measuredFrom: null, ...over });

const row = (over: Record<string, unknown> = {}) => ({
    id: 12, siteId: 7, externalRef: 'RX-1001', serviceType: 'stat', serviceDate: '2026-09-14',
    recipientName: 'Ines Vargas', address: '1100 Broadway St', city: 'San Antonio', zip: '78215',
    zone: 1, status: 'assigned', dueAt: '2026-09-14T19:00:00.000Z', assignedTo: 'sam.courier',
    sla: sla(), ...over,
});

const summary = {
    total: 2, byStatus: { assigned: 1, delivered: 1 }, overdue: 1,
    onTime: { met: 1, missed: 1, measured: 2, rate: 50 },
};

function renderOrders(routes: Record<string, unknown>, initial = '/projects/uh/orders') {
    mockFetch(routes);
    return render(
        <MemoryRouter initialEntries={[initial]}>
            <AuthProvider>
                <Routes>
                    <Route path="/projects/:code/orders" element={<Orders />} />
                    <Route path="/projects/:code/orders/:orderId" element={<OrderDetail />} />
                </Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
}

const baseRoutes = {
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/sites': sites,
    'GET /api/projects/uh/uh/orders': [row(), row({ id: 13, status: 'delivered', sla: sla({ state: 'overdue', minutesToDue: -22 }) })],
    'GET /api/projects/uh/uh/orders/summary': summary,
};

describe('slaLabel', () => {
    it('says how long is left, or how late it already is', () => {
        expect(slaLabel(sla({ state: 'open', minutesToDue: 45 }))).toEqual({ text: '45 min left', tone: 'muted' });
        expect(slaLabel(sla({ state: 'due_soon', minutesToDue: 12 }))).toEqual({ text: '12 min left', tone: 'warn' });
        expect(slaLabel(sla({ state: 'overdue', minutesToDue: -22 }))).toEqual({ text: '22 min late', tone: 'off' });
        expect(slaLabel(sla({ state: 'met', minutesToDue: 5 }))).toEqual({ text: 'on time', tone: 'ok' });
        expect(slaLabel(sla({ state: 'missed', minutesToDue: -7 }))).toEqual({ text: 'late by 7 min', tone: 'off' });
        expect(slaLabel(sla({ state: 'not_applicable' })).text).toBe('');
    });
});

describe('Orders', () => {
    it('lists orders with the time remaining first, and the counts above them', async () => {
        renderOrders(baseRoutes);
        expect(await screen.findByRole('heading', { name: 'Orders' })).toBeInTheDocument();
        expect(await screen.findByText('45 min left')).toBeInTheDocument();
        expect(screen.getByText('22 min late')).toBeInTheDocument();
        // Scope the counts to the summary line: bare numbers like "1" also
        // appear as zones in the table.
        const stats = document.querySelector('.izy-statline') as HTMLElement;
        expect(within(stats).getByText('2')).toBeInTheDocument();          // total
        expect(stats.textContent).toContain('2 orders');
        expect(within(stats).getByText(/overdue/)).toHaveTextContent('1 overdue');
        expect(within(stats).getByText('50%')).toBeInTheDocument();
        expect(within(stats).getByText(/1 of 2/)).toBeInTheDocument();
    });

    it('sends a filter to the server rather than filtering the page it already has', async () => {
        const { calls } = mockFetch(baseRoutes);
        render(
            <MemoryRouter initialEntries={['/projects/uh/orders']}>
                <AuthProvider>
                    <Routes><Route path="/projects/:code/orders" element={<Orders />} /></Routes>
                </AuthProvider>
            </MemoryRouter>,
        );
        await screen.findByRole('heading', { name: 'Orders' });
        fireEvent.change(await screen.findByLabelText('Status'), { target: { value: 'delivered' } });

        await waitFor(() => {
            expect(calls.some((c) => c.includes('/uh/orders?') && c.includes('status=delivered'))).toBe(true);
        });
        // And the summary is refetched with the same filter, so the header
        // cannot disagree with the table.
        expect(calls.some((c) => c.includes('/uh/orders/summary?') && c.includes('status=delivered'))).toBe(true);
    });

    it('reads its filters back out of the URL, so a view can be shared', async () => {
        renderOrders(baseRoutes, '/projects/uh/orders?status=delivered&overdue=true&ref=RX-1001');
        await screen.findByRole('heading', { name: 'Orders' });
        expect((await screen.findByLabelText('Status')).getAttribute('value') ?? (screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('delivered');
        expect((screen.getByLabelText('Reference') as HTMLInputElement).value).toBe('RX-1001');
        expect(screen.getByRole('checkbox')).toBeChecked();
    });

    it('says plainly why it will not search by patient name', async () => {
        renderOrders(baseRoutes);
        expect(await screen.findByText(/would put a name in a URL/)).toBeInTheDocument();
    });

    it('says so when nothing matches', async () => {
        renderOrders({ ...baseRoutes, 'GET /api/projects/uh/uh/orders': [] });
        expect(await screen.findByText('No orders match these filters.')).toBeInTheDocument();
    });

    it('counts one order as an order, not as "1 orders"', async () => {
        renderOrders({
            ...baseRoutes,
            'GET /api/projects/uh/uh/orders': [row()],
            'GET /api/projects/uh/uh/orders/summary': { ...summary, total: 1, byStatus: { assigned: 1 } },
        });
        await screen.findByRole('heading', { name: 'Orders' });
        await waitFor(() => expect(document.querySelector('.izy-statline')?.textContent).toContain('1 order'));
        expect(document.querySelector('.izy-statline')?.textContent).not.toContain('1 orders');
    });

    it('flags an out-of-area order in the list rather than leaving the zone blank', async () => {
        renderOrders({ ...baseRoutes, 'GET /api/projects/uh/uh/orders': [row({ zone: null })] });
        expect(await screen.findByText('out of area')).toBeInTheDocument();
    });
});

const detail = {
    ...row(),
    recipientPhone: '2105550190', addressLine: '1100 Broadway St', addressLine2: '', state: 'TX',
    deliveryNotes: 'Leave with front desk', signatureRequired: true, geocodeStatus: 'pending',
    receivedAt: '2026-09-14T17:00:00.000Z', pickupDueAt: '2026-09-14T18:40:00.000Z',
    pickupAt: '2026-09-14T17:40:00.000Z', arrivedAt: '2026-09-14T18:20:00.000Z',
    deliveredAt: '2026-09-14T18:25:00.000Z', returnedAt: null, assignedAt: '2026-09-14T17:10:00.000Z',
    pickedUpBy: 'Pharmacy Tech', receivedBy: 'Ines Vargas', failureReason: '', dailyListId: 3,
    status: 'delivered', sla: sla({ state: 'met', minutesToDue: 40, onTime: true, measuredFrom: 'arrived', measuredAt: '2026-09-14T18:20:00.000Z' }),
    packages: [{ id: 5, description: 'Cold pack', quantity: 2, signatureRequired: true, outcome: 'delivered' }],
    custody: [
        { id: 1, packageId: null, type: 'created', at: '2026-09-14T17:00:00.000Z', actor: 'admin', from: '', to: 'pending', signedName: '', signatureKey: '', reason: '', lat: null, lng: null, describes: 'The order entered the system.' },
        { id: 2, packageId: null, type: 'picked_up', at: '2026-09-14T17:40:00.000Z', actor: 'sam.courier', from: 'assigned', to: 'picked_up', signedName: 'Pharmacy Tech', signatureKey: '', reason: '', lat: 29.5, lng: -98.6, describes: 'Took custody.' },
        { id: 3, packageId: null, type: 'delivered', at: '2026-09-14T18:25:00.000Z', actor: 'sam.courier', from: 'picked_up', to: 'delivered', signedName: 'Ines Vargas', signatureKey: '', reason: '', lat: null, lng: null, describes: 'Handed over.' },
    ],
    pricing: {
        available: true, zone: 1, base: 12.5, statSurcharge: 22, afterHoursSurcharge: 0, dryRunFee: 0,
        outOfArea: { miles: 0, perMile: 1.95, amount: 0 }, total: 34.5, effectiveFrom: '2026-05-18',
        notes: [], afterHours: false, measuredAt: '2026-09-14T18:25:00.000Z', measuredFrom: 'delivered',
        provisional: false, currency: 'USD',
    },
    allowed: ['note'],
};

describe('OrderDetail', () => {
    const routes = { ...baseRoutes, 'GET /api/projects/uh/uh/orders/12': detail };

    it('shows both signatures the proof of delivery needs', async () => {
        renderOrders(routes, '/projects/uh/orders/12');
        await screen.findByRole('heading', { name: 'Order #12' });
        const custody = (await screen.findByText('Chain of custody')).closest('.izy-card') as HTMLElement;
        // Sending personnel at pickup, receiving personnel at the door.
        expect(within(custody).getByText('Pharmacy Tech')).toBeInTheDocument();
        expect(within(custody).getByText('Ines Vargas')).toBeInTheDocument();
    });

    it('says the record cannot be edited, which is what makes it evidence', async () => {
        renderOrders(routes, '/projects/uh/orders/12');
        expect(await screen.findByText(/cannot be edited or deleted/)).toBeInTheDocument();
    });

    it('breaks the price down and says which instant it was measured at', async () => {
        renderOrders(routes, '/projects/uh/orders/12');
        const card = (await screen.findByText('What it bills at')).closest('.izy-card') as HTMLElement;
        expect(within(card).getByText('Zone 1 delivery')).toBeInTheDocument();
        expect(within(card).getByText('$12.50')).toBeInTheDocument();
        expect(within(card).getByText('$22.00')).toBeInTheDocument();
        expect(within(card).getByText('$34.50')).toBeInTheDocument();
        expect(within(card).getByText(/measured at the delivered time/)).toBeInTheDocument();
    });

    it('marks a price that can still change as provisional', async () => {
        renderOrders({
            ...routes,
            'GET /api/projects/uh/uh/orders/12': { ...detail, status: 'assigned', pricing: { ...detail.pricing, provisional: true } },
        }, '/projects/uh/orders/12');
        const card = (await screen.findByText('What it bills at')).closest('.izy-card') as HTMLElement;
        expect(within(card).getByText('provisional')).toBeInTheDocument();
    });

    it('explains that the deadline is measured at arrival', async () => {
        renderOrders(routes, '/projects/uh/orders/12');
        expect(await screen.findByText(/what the deadline is measured against/)).toBeInTheDocument();
        expect(screen.getByText('on time')).toBeInTheDocument();
    });

    it('shows the STAT pickup clock alongside the overall deadline', async () => {
        renderOrders(routes, '/projects/uh/orders/12');
        expect(await screen.findByText(/within an hour of pickup/)).toBeInTheDocument();
    });

    it('says an out-of-area order still needs a distance', async () => {
        renderOrders({
            ...routes,
            'GET /api/projects/uh/uh/orders/12': {
                ...detail, zone: null,
                pricing: { ...detail.pricing, zone: null, base: 0, total: 22, notes: ['Destination ZIP is outside the published zone list; billed per one-way loaded mile.'] },
            },
        }, '/projects/uh/orders/12');
        expect(await screen.findByText(/out of area, needs a distance/)).toBeInTheDocument();
        expect(screen.getByText(/outside the published zone list/)).toBeInTheDocument();
    });

    it('tells a courier plainly when the order is not theirs', async () => {
        renderOrders({
            ...routes,
            'GET /api/projects/uh/uh/orders/12': { status: 403, body: { error: 'That order is not assigned to you' } },
        }, '/projects/uh/orders/12');
        expect(await screen.findByRole('heading', { name: 'Order not available' })).toBeInTheDocument();
        expect(screen.getByText('That order is not assigned to you')).toBeInTheDocument();
    });
});
