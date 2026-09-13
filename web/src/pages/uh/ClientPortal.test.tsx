/* The client portal screen.

   What matters here is what a pharmacist can do with it at a counter: see
   today at a glance, find the one that did not arrive without hunting for it,
   and read the proof for a delivery somebody is asking about. And what they
   are not offered: a search by patient name. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ClientPortal } from './ClientPortal';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const session = { id: 9, username: 'uh.pharmacist', name: 'Karthik Pharmacist', role: 'staff', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'client_viewer' }];
const BASE = '/api/projects/uh/uh/client';

const sla = (over = {}) => ({ state: 'met', minutesToDue: 12, onTime: true, measuredAt: null, measuredFrom: null, ...over });

const order = (over = {}) => ({
    id: 21, reference: 'RX-1001', serviceType: 'stat', serviceDate: '2026-09-14',
    pharmacy: 'University Hospital Discharge Pharmacy', recipientName: 'Ines Vargas',
    address: '1200 Encanto Street', city: 'San Antonio', zip: '78215',
    status: 'delivered', receivedAt: '2026-09-14T17:00:00.000Z', dueAt: '2026-09-14T19:00:00.000Z',
    pickedUpAt: '2026-09-14T17:40:00.000Z', arrivedAt: '2026-09-14T18:20:00.000Z',
    deliveredAt: '2026-09-14T18:25:00.000Z', returnedAt: null,
    receivedBy: 'Ines Vargas', noSignatureReason: '', failureReason: '',
    courier: 'Ada', sla: sla(), ...over,
});

const summary = (over = {}) => ({
    serviceDate: '2026-09-14', timezone: 'America/Chicago',
    pharmacies: [{ id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' }],
    byStatus: { delivered: 8, failed: 1, picked_up: 3 }, total: 12,
    outstanding: 3, delivered: 8, notDelivered: 1, notes: [], ...over,
});

const list = (over = {}) => ({
    from: '2026-09-14', to: '2026-09-14',
    pharmacies: [{ id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' }],
    orders: [order()], truncated: false, notes: [], ...over,
});

const detail = (over = {}) => ({
    ...order(),
    packages: [{ description: 'Oral solids', quantity: 2, signatureRequired: true, outcome: 'delivered', failureReason: '', failureNote: '' }],
    timeline: [
        { type: 'picked_up', at: '2026-09-14T17:40:00.000Z', by: 'Ada', signedName: 'Pharmacy Tech', reason: '' },
        { type: 'arrived', at: '2026-09-14T18:20:00.000Z', by: 'Ada', signedName: '', reason: '' },
        { type: 'delivered', at: '2026-09-14T18:25:00.000Z', by: 'Ada', signedName: 'Ines Vargas', reason: '' },
    ],
    proofOfDelivery: { available: false, reason: '' },
    ...over,
});

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    [`GET ${BASE}/summary`]: summary(),
    /* Before the wildcard: mockFetch takes the first matching key, and
       `orders*` would otherwise answer the detail request with the list. */
    [`GET ${BASE}/orders/21`]: detail(),
    [`GET ${BASE}/orders*`]: list(),
    ...over,
});

function renderPortal(r = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/deliveries']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/deliveries" element={<ClientPortal />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('ClientPortal', () => {
    it('leads with today in four numbers', async () => {
        renderPortal();
        expect(await screen.findByRole('heading', { name: 'Deliveries' })).toBeInTheDocument();
        const today = screen.getByRole('heading', { name: 'Today' }).closest('.izy-card') as HTMLElement;
        expect(within(today).getByText('12')).toBeInTheDocument();
        expect(within(today).getByText('still out')).toBeInTheDocument();
        expect(within(today).getByText('not delivered')).toBeInTheDocument();
    });

    it('names the pharmacy the account is scoped to', async () => {
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.getAllByText(/Discharge Pharmacy/).length).toBeGreaterThan(0);
    });

    it('puts what did not arrive at the top, not buried in time order', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: list({
                orders: [
                    order({ id: 21, recipientName: 'Delivered Person', status: 'delivered' }),
                    order({ id: 22, recipientName: 'Failed Person', status: 'failed', failureReason: 'no_access', deliveredAt: null }),
                ],
            }),
        }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
        expect(names[0]).toContain('Failed Person');
        expect(names[0]).toContain('could not get access'.replace('could not get access', 'no access'));
    });

    it('says why patient names cannot be searched, rather than silently not working', async () => {
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.getByLabelText('Your reference')).toBeInTheDocument();
        expect(screen.queryByLabelText(/patient name/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Patient names are deliberately not searchable/)).toBeInTheDocument();
    });

    it('shows the proof of delivery for one delivery on request', async () => {
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        const proof = await screen.findByRole('region', { name: /Proof of delivery for Ines Vargas/ });
        expect(proof).toHaveTextContent('Signed for by');
        expect(proof).toHaveTextContent('2 × Oral solids');
        expect(proof).toHaveTextContent('Collected from the pharmacy');
        expect(proof).toHaveTextContent('Handed over');
        // A first name, never more.
        expect(proof).toHaveTextContent('Ada');
    });

    it('offers the proof of delivery as a document', async () => {
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        const link = await screen.findByRole('link', { name: 'Open the proof of delivery' });
        expect(link).toHaveAttribute('href', '/api/projects/uh/uh/client/orders/21/pod.pdf');
        // A plain link, so the browser opens it and no copy of a patient's
        // proof of delivery is kept alive in the tab as a blob URL.
        expect(link).toHaveAttribute('target', '_blank');
    });

    it('tells an unscoped account what is wrong instead of showing an empty page', async () => {
        renderPortal(routes({
            [`GET ${BASE}/summary`]: summary({ pharmacies: [], total: 0, outstanding: 0, delivered: 0, notDelivered: 0, notes: ['No pharmacies are assigned to this account yet. Ask Izy dispatch to set them up.'] }),
            [`GET ${BASE}/orders*`]: list({ pharmacies: [], orders: [], notes: ['No pharmacies are assigned to this account yet. Ask Izy dispatch to set them up.'] }),
        }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.getByText(/No pharmacies are assigned to this account yet/)).toBeInTheDocument();
        expect(screen.getByText('Nothing for this day.')).toBeInTheDocument();
    });

    it('warns when a range was cut short rather than quietly showing part of it', async () => {
        renderPortal(routes({ [`GET ${BASE}/orders*`]: list({ truncated: true }) }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.getByText(/Showing the first 500/)).toBeInTheDocument();
    });

    it('shows the server refusal when a range is too long', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: { status: 400, body: { error: 'That is 2000 days. Ask for 92 or fewer at a time.', code: 'client.rangeTooLong' } },
        }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Ask for 92 or fewer'));
    });
});
