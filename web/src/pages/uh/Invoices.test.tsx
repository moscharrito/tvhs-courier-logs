/* The invoices screen.

   The mistake this screen guards against is somebody quoting a draft total as
   final, or sending an invoice without noticing that deliveries were left off
   it. So both of those have to be impossible to miss. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Invoices } from './Invoices';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const session = { id: 1, username: 'admin', name: 'Administrator', role: 'admin', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];
const BASE = '/api/projects/uh/uh/invoices';

const line = (over = {}) => ({
    orderId: 41, serviceDate: '2026-08-24', reference: 'RX-7001', pharmacy: 'Discharge Pharmacy',
    deliveryZip: '78215', zone: 1, serviceType: 'scheduled', dryRun: false, items: 1,
    baseCents: 1250, statCents: 0, afterHoursCents: 0, dryRunCents: 0,
    outOfAreaMiles: null, outOfAreaCents: 0, amountCents: 1250, note: '', ...over,
});

const invoice = (over = {}) => ({
    id: 3, number: 'IZY-UH-2026-08-0001', status: 'draft',
    periodFrom: '2026-08-24', periodTo: '2026-08-30',
    lines: [line(), line({ orderId: 42, reference: 'RX-7002', dryRun: true, items: 2, amountCents: 1500 })],
    exceptions: [], adjustments: [],
    byZone: [{ zone: 'zone 1', count: 2, cents: 2750 }],
    byServiceType: [{ serviceType: 'scheduled', count: 2, cents: 2750 }],
    dryRuns: { count: 1, items: 2, cents: 1500 },
    subtotal: 27.5, subtotalCents: 2750, adjustmentsTotal: 0,
    total: 27.5, totalCents: 2750,
    lineCount: 2, excludedCount: 0, excludedNote: '', notes: '',
    issuedAt: null, paidAt: null, voidReason: '', recomputes: true, ...over,
});

const summary = (over = {}) => ({
    id: 3, number: 'IZY-UH-2026-08-0001', status: 'draft',
    periodFrom: '2026-08-24', periodTo: '2026-08-30', pharmacy: null,
    total: 27.5, lineCount: 2, excludedCount: 0, issuedAt: null, paidAt: null, ...over,
});

const routes = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    [`GET ${BASE}/3`]: invoice(),
    [`GET ${BASE}`]: { invoices: [summary()] },
    ...over,
});

function renderInvoices(r = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/invoices']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/invoices" element={<Invoices />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

const openFirst = async () => {
    await screen.findByRole('heading', { name: 'Invoices' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    return screen.findByRole('region', { name: /IZY-UH-2026-08-0001/ });
};

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('Invoices', () => {
    it('says a draft is a draft, in the list and on the invoice', async () => {
        renderInvoices();
        await screen.findByRole('heading', { name: 'Invoices' });
        // The list shows no total for a draft: a number there would be quoted.
        const row = screen.getByText('IZY-UH-2026-08-0001').closest('tr') as HTMLElement;
        // The status pill, and the word where a total would otherwise be: a
        // number in that column is a number somebody quotes.
        expect(within(row).getAllByText('draft')).toHaveLength(2);

        const panel = await openFirst();
        expect(within(panel).getByText(/recomputed every time it is opened/)).toBeInTheDocument();
        expect(within(panel).getByText(/Do not quote them as final/)).toBeInTheDocument();
    });

    it('puts what cannot be priced above the total, not below it', async () => {
        renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({
                exceptions: [{ orderId: 44, serviceDate: '2026-08-26', reference: 'RX-7004', reason: 'Out of area with no mileage recorded. Needs the distance from ticket 1.4.' }],
            }),
        }));
        const panel = await openFirst();
        const alert = within(panel).getByRole('alert');
        expect(alert).toHaveTextContent('1 delivery cannot be priced');
        expect(alert).toHaveTextContent('RX-7004');
        expect(alert).toHaveTextContent('ticket 1.4');

        // Above the total in the document order, which is what a reader follows.
        const html = panel.innerHTML;
        expect(html.indexOf('cannot be priced')).toBeLessThan(html.indexOf('subtotal'));
    });

    it('asks before issuing an invoice with deliveries left off it', async () => {
        const { calls } = renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({
                exceptions: [{ orderId: 44, serviceDate: '2026-08-26', reference: 'RX-7004', reason: 'No mileage.' }],
            }),
            [`POST ${BASE}/3/issue`]: invoice({ status: 'issued', recomputes: false, excludedCount: 1 }),
        }));
        await openFirst();

        vi.stubGlobal('confirm', vi.fn(() => false));
        fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
        // Said no: nothing was sent.
        await waitFor(() => expect(calls.some((c) => c.includes('POST') && c.includes('/issue'))).toBe(false));

        vi.stubGlobal('confirm', vi.fn(() => true));
        fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
        await waitFor(() => expect(calls.some((c) => c.includes('POST') && c.includes('/issue'))).toBe(true));
    });

    it('issues without a prompt when everything could be priced', async () => {
        const { calls } = renderInvoices(routes({
            [`POST ${BASE}/3/issue`]: invoice({ status: 'issued', recomputes: false }),
        }));
        await openFirst();
        const confirmSpy = vi.fn(() => true);
        vi.stubGlobal('confirm', confirmSpy);
        fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
        await waitFor(() => expect(calls.some((c) => c.includes('/issue'))).toBe(true));
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('shows an issued invoice as settled rather than moving', async () => {
        renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({ status: 'issued', recomputes: false, issuedAt: '2026-09-01T12:00:00.000Z' }),
            [`GET ${BASE}`]: { invoices: [summary({ status: 'issued', issuedAt: '2026-09-01T12:00:00.000Z' })] },
        }));
        const panel = await openFirst();
        expect(within(panel).queryByText(/Do not quote them as final/)).not.toBeInTheDocument();
        expect(within(panel).getByText(/issued 2026-09-01/)).toBeInTheDocument();
        expect(within(panel).getByRole('button', { name: 'Mark paid' })).toBeInTheDocument();
    });

    it('will not void without a reason', async () => {
        const { calls } = renderInvoices();
        await openFirst();
        vi.stubGlobal('prompt', vi.fn(() => null));
        fireEvent.click(screen.getByRole('button', { name: 'Void' }));
        await waitFor(() => expect(calls.some((c) => c.includes('/void'))).toBe(false));
    });

    it('offers both documents for the invoice on screen', async () => {
        renderInvoices();
        const panel = await openFirst();
        expect(within(panel).getByRole('link', { name: 'PDF' })).toHaveAttribute('href', `${BASE}/3/invoice.pdf`);
        expect(within(panel).getByRole('link', { name: 'Excel' })).toHaveAttribute('href', `${BASE}/3/invoice.xlsx`);
    });

    it('shows a dry run line as a dry run with its item count', async () => {
        renderInvoices();
        const panel = await openFirst();
        expect(within(panel).getByText('dry run, 2 items')).toBeInTheDocument();
        expect(within(panel).getByText('delivered')).toBeInTheDocument();
        expect(within(panel).getByText(/1 dry run|dry runs, 2 items/)).toBeInTheDocument();
    });

    it('requires a reason on an adjustment, through the form', async () => {
        renderInvoices();
        const panel = await openFirst();
        const reason = within(panel).getByLabelText('Reason') as HTMLInputElement;
        expect(reason).toBeRequired();
        expect(within(panel).getByLabelText('Amount')).toBeRequired();
    });
});
