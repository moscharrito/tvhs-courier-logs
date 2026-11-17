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
        /* Folded since ticket 5.14. An adjustment is a credit or a charge
           agreed with University Health by name, which happens rarely; the
           form for it sat open under every invoice anybody read. */
        fireEvent.click(within(panel).getByRole('button', { name: /Add an adjustment/ }));
        const reason = within(panel).getByLabelText('Reason') as HTMLInputElement;
        expect(reason).toBeRequired();
        expect(within(panel).getByLabelText('Amount')).toBeRequired();
    });

    it('does not report a made-up delivery count for a draft', async () => {
        /* line_count is only stored when an invoice is issued, so the list
           read a confident "0 deliveries" for a draft that opens with three
           and a total of $74.00. Somebody scanning for a period worth billing
           would read the 0 and move on. */
        renderInvoices();
        const rows = await screen.findAllByRole('row');
        const draft = rows.find((r) => within(r).queryByText('counted on open'));
        expect(draft).toBeDefined();
        expect(within(draft!).queryByText('0')).not.toBeInTheDocument();
    });
});

/* ────────────────── pricing a range without billing for it
 *
 * The dates were already on this card; what was missing was a way to use
 * them that did not open a billing period. Asking what a range comes to was
 * being refused by the two guards that stop a period being billed twice or
 * billed early, which are about billing and not about asking.
 */
describe('exporting a range without billing', () => {
    const openPage = async () => {
        renderInvoices();
        await screen.findByRole('heading', { name: 'Open a draft' });
    };

    it('offers nothing to click until both dates are given', async () => {
        await openPage();
        /* Queried by text, not by role: an anchor with no href is not a
           link as far as the accessibility tree is concerned, which is
           precisely the state being asserted. */
        /* Scoped to the anchor: the paragraph below repeats the name in
           bold, so a bare text query matches twice. */
        const link = screen.getByText('Export without billing', { selector: 'a' });
        expect(link).not.toHaveAttribute('href');
        expect(link).toHaveAttribute('aria-disabled', 'true');
        /* And it must not be queryable as a link either, or a keyboard user
           would land on a control that does nothing. */
        expect(screen.queryByRole('link', { name: /Export without billing/ })).toBeNull();
    });

    it('points at the export once a range is chosen', async () => {
        await openPage();
        fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
        fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-15' } });
        expect(screen.getByRole('link', { name: /Export without billing/ }))
            .toHaveAttribute('href', '/api/projects/uh/uh/invoices/export.xlsx?from=2026-11-01&to=2026-11-15');
    });

    it('does not post anything, because it bills nothing', async () => {
        /* A link, not a submit. If this ever became a button inside the
           form it would open a draft instead, which is the exact thing it
           exists to avoid. */
        await openPage();
        fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
        fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-15' } });
        const link = screen.getByRole('link', { name: /Export without billing/ });
        expect(link.tagName).toBe('A');
        expect(link).not.toHaveAttribute('type', 'submit');
    });

    it('says plainly that it raises no invoice', async () => {
        await openPage();
        expect(screen.getByText(/raises nothing/)).toBeInTheDocument();
        expect(screen.getByText(/No invoice, no number reserved/)).toBeInTheDocument();
    });
});

describe('deleting one that never went out', () => {
    /* Void stays the answer for anything University Health has seen. The
       delete button is for the invoice opened on the wrong dates and
       noticed a minute later, which voiding leaves in the list for ever as
       a row whose only content is that somebody mistyped. */


    /** The list before the delete and after it. mockFetch calls a handler
     *  per request, so the same URL can answer differently once the row is
     *  gone -- which is what the screen actually sees. */
    const emptyingList = () => {
        let deleted = false;
        return {
            [`DELETE ${BASE}/3`]: () => { deleted = true; return { ok: true, id: 3, number: 'IZY-UH-2026-08-0001' }; },
            [`GET ${BASE}`]: () => ({ invoices: deleted ? [] : [summary()] }),
        };
    };

    const openIt = async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByRole('button', { name: 'Issue' });
    };

    it('offers it on a draft nobody has seen', async () => {
        renderInvoices();
        await openIt();

        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('does not offer it once the invoice has been issued', async () => {
        /* The line the whole thing is drawn around: a figure that has been
           sent stays answerable, so Void is the only way out. */
        renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({ status: 'issued', issuedAt: '2026-09-01T12:00:00.000Z' }),
            [`GET ${BASE}`]: { invoices: [summary({ status: 'issued', issuedAt: '2026-09-01T12:00:00.000Z' })] },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByRole('button', { name: 'Mark paid' });

        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Void' })).toBeInTheDocument();
    });

    it('does not offer it on one that was issued and then voided', async () => {
        /* issued_at, not the status word: the number went out. */
        renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({
                status: 'void', issuedAt: '2026-09-01T12:00:00.000Z', voidReason: 'Billed to the wrong pharmacy',
            }),
            [`GET ${BASE}`]: { invoices: [summary({ status: 'void', issuedAt: '2026-09-01T12:00:00.000Z' })] },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByText(/Billed to the wrong pharmacy/);

        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    });

    it('asks before it goes, and names what is going', async () => {
        const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { calls } = renderInvoices(routes(emptyingList()));
        await openIt();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(confirmed).toHaveBeenCalledWith(expect.stringContaining('IZY-UH-2026-08-0001'));
        expect(confirmed).toHaveBeenCalledWith(expect.stringContaining('cannot be undone'));
        await waitFor(() => expect(calls).toContain(`DELETE ${BASE}/3`));
    });

    it('does nothing at all when the question is declined', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        const { calls } = renderInvoices(routes({ [`DELETE ${BASE}/3`]: { ok: true } }));
        await openIt();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(calls).not.toContain(`DELETE ${BASE}/3`);
    });

    it('closes the panel and says where the number went', async () => {
        /* The panel cannot reopen onto a row that is gone, and a number
           missing from the sequence is a question somebody will ask. */
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        renderInvoices(routes(emptyingList()));
        await openIt();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(screen.getByText(/recorded in the audit trail/)).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
    });

    it('makes a draft carrying adjustments say why, and sends what was typed', async () => {
        const asked = vi.spyOn(window, 'prompt').mockReturnValue('Opened against the wrong pharmacy');
        const { calls, bodies } = renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({
                adjustments: [{ id: 8, description: 'Goodwill', amount: -25, amountCents: -2500, reason: 'Agreed on the telephone', createdBy: 'admin' }],
                adjustmentsTotal: -25, total: 2.5, totalCents: 250,
            }),
            ...emptyingList(),
        }));
        await openIt();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(asked).toHaveBeenCalledWith(expect.stringContaining('entered by hand'));
        await waitFor(() => expect(calls).toContain(`DELETE ${BASE}/3`));
        expect(bodies[`DELETE ${BASE}/3`]).toMatchObject({ reason: 'Opened against the wrong pharmacy' });
    });

    it('will not take a reason too short to mean anything', async () => {
        vi.spyOn(window, 'prompt').mockReturnValue('oops');
        const { calls } = renderInvoices(routes({
            [`GET ${BASE}/3`]: invoice({
                adjustments: [{ id: 8, description: 'Goodwill', amount: -25, amountCents: -2500, reason: 'Agreed', createdBy: 'admin' }],
            }),
            [`DELETE ${BASE}/3`]: { ok: true },
        }));
        await openIt();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        expect(calls).not.toContain(`DELETE ${BASE}/3`);
    });
});
