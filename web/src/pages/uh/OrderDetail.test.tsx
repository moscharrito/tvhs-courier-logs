/* One delivery, looked up by two different people.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS NOW AND NOT BEFORE.
 *
 * This screen had no test at all, which was survivable while it was one
 * console page for everybody. It is not one page any more: a courier opens
 * it from Details on their own stop and gets the phone app's frame, and
 * dispatch opens it at a desk and gets the console. A branch on who is
 * reading, with no test on it, on a screen that shows what a delivery
 * billed at.
 *
 * THE ONE THAT MATTERS IS PRICING. The server withholds it from a courier
 * (modules/uh/orders.ts) rather than the screen hiding it, so the fixture
 * below mirrors that: the courier's response simply has no `pricing` key.
 * The assertion is still worth making here, because the day somebody
 * "helpfully" makes this screen render a pricing panel from something else
 * is the day a driver can read the contract's margin off their own stop.
 *
 * Every name and address here is invented.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { OrderDetail } from './OrderDetail';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };
const asCourier = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const asLead = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'lead' }];

const detail = (over = {}) => ({
    id: 4182, siteId: 1, externalRef: 'RX-7001', serviceType: 'scheduled', serviceDate: '2026-10-31',
    recipientName: 'Ines Vargas', address: '1100 Broadway St', city: 'San Antonio', state: 'TX', zip: '78215',
    zone: 1, status: 'delivered', dueAt: '2026-10-31T19:00:00.000Z',
    assignedTo: 'ada.courier', assignedToName: 'Ada Courier',
    sla: { state: 'met', minutesToDue: 12, onTime: true, measuredAt: null, measuredFrom: null },
    recipientPhone: '210-555-0144', addressLine: '1100 Broadway St', addressLine2: '', deliveryNotes: '',
    signatureRequired: true, geocodeStatus: 'ok', receivedAt: '2026-10-31T15:00:00.000Z',
    pickupDueAt: null, pickupAt: null, arrivedAt: null, deliveredAt: '2026-10-31T18:48:00.000Z',
    returnedAt: null, assignedAt: null, pickedUpBy: '', receivedBy: 'Ines Vargas', failureReason: '',
    dailyListId: null, packages: [], custody: [], allowed: [],
    ...over,
});

/* The row labels down the left of the tables.
 *
 * Read off the elements rather than through getByRole('rowheader'): a bare
 * <th> in a tbody row does not reliably map to that role in jsdom, so
 * `queryByRole('rowheader', ...)` returns null whether the row is there or
 * not. An assertion that passes for the wrong reason is worse than none,
 * and this one is about a row being ABSENT. */
const rowLabels = () => [...document.querySelectorAll('.izy-table th')].map((th) => th.textContent);

function renderAs(projects: unknown, over = {}) {
    mockFetch({
        'GET /api/session': session,
        'GET /api/me/projects': projects,
        'GET /api/projects/uh/uh/orders/4182': detail(over),
        'GET /api/projects/uh/uh/orders/4182/messages': { messages: [] },
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/orders/4182']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/orders/:orderId" element={<OrderDetail />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
}

describe('a courier looking one up', () => {
    it('gets the phone app\'s frame, with the delivery pinned above the record', async () => {
        renderAs(asCourier);
        await screen.findByRole('heading', { name: 'Order #4182' });

        /* The region that does not scroll away while the tables below do. */
        const panel = screen.getByRole('group', { name: 'This delivery' });
        expect(within(panel).getByText('Ines Vargas')).toBeInTheDocument();
        expect(within(panel).getByText('delivered')).toBeInTheDocument();
        expect(document.querySelector('.izy-screen')).not.toBeNull();
    });

    it('does not print the name and the address twice', async () => {
        /* They are in the panel. The Delivery table used to repeat them four
           rows later, which is the duplication the panel exists to remove. */
        renderAs(asCourier);
        await screen.findByRole('heading', { name: 'Order #4182' });
        expect(screen.getAllByText('Ines Vargas')).toHaveLength(1);
        expect(rowLabels()).not.toContain('Recipient');
        expect(rowLabels()).not.toContain('Address');
        /* The phone is not in the panel, so it keeps a row of its own: it is
           the thing somebody opens this screen to find. */
        expect(screen.getByText('210-555-0144')).toBeInTheDocument();
    });

    it('is sent back to their run, never to the dispatch console', async () => {
        /* Back pointed at the orders list, which is a filter naming every
           counter on the contract and a box for looking up another courier.
           A driver reaches this from their own stop. */
        renderAs(asCourier);
        const back = await screen.findByRole('link', { name: 'Back to today' });
        expect(back).toHaveAttribute('href', '/projects/uh/my-run');
        expect(screen.queryByRole('link', { name: 'Orders' })).toBeNull();
    });

    it('is shown no pricing, because the server sends none', async () => {
        /* Withheld server-side, asserted here anyway: the failure this
           guards against is somebody rebuilding the panel from another
           field, and a driver reading the contract's margin off their own
           stop. */
        renderAs(asCourier);
        await screen.findByRole('heading', { name: 'Order #4182' });
        expect(screen.queryByRole('heading', { name: 'What it bills at' })).toBeNull();
        expect(screen.queryByText(/\$/)).toBeNull();
    });

    it('still offers the proof of delivery, which is why they opened it', async () => {
        renderAs(asCourier);
        const pod = await screen.findByRole('link', { name: 'Proof of delivery (PDF)' });
        expect(pod).toHaveAttribute('href', '/api/projects/uh/uh/orders/4182/pod.pdf');
    });
});

describe('a site lead looking one up', () => {
    it('keeps the console page and the whole record', async () => {
        /* The other half of the branch. A lead reads this at a desk next to
           the orders list, and the frame — a fixed-height sheet pinned to
           the bottom of a 1400px window — would be a shape borrowed past
           the point where it means anything. */
        renderAs(asLead);
        await screen.findByRole('heading', { name: 'Order #4182' });
        await waitFor(() => expect(document.querySelector('.izy-screen')).toBeNull());
        expect(screen.getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/projects/uh/orders');
        /* Recipient and address keep their rows: there is no panel here.
           Matched loosely, because the Recipient cell carries the phone
           beside the name and the Delivered row carries who signed. */
        expect(rowLabels()).toContain('Recipient');
        expect(rowLabels()).toContain('Address');
        expect(screen.getAllByText(/Ines Vargas/).length).toBeGreaterThan(0);
    });
});
