/* Taking a STAT call. The deadline has to be visible before the dispatcher
   commits, and the result has to say what the order actually became. */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewOrder } from './NewOrder';
import { mockFetch } from '../../test/setup';

const sites = [
    { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy', type: 'pharmacy', addressLine: '4502 Medical Drive', city: 'San Antonio', state: 'TX', zip: '78229', fullAddress: '', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
];

const routes = { 'GET /api/projects/uh/uh/sites': sites };

function fill() {
    fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'Ines Vargas' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '1100 Broadway St' } });
    fireEvent.change(screen.getByLabelText('ZIP'), { target: { value: '78215' } });
}

/* An order taken by hand is the one most likely to be wrong: the wrong
   pharmacy picked from nine, a call logged twice because two people
   answered it. Cancelling leaves the row in the day's counts and in the
   next duplicate check, so dispatch asked to be able to remove it. */
const taken = (over = {}) => ({
    id: 41, externalRef: 'RX-9001', serviceType: 'stat', status: 'ready',
    recipientName: 'Ines Vargas', address: '1100 Broadway St', zip: '78215',
    dueAt: '2026-09-14T19:00:00.000Z', siteId: 7, assignedTo: null, ...over,
});

const listed = (orders: unknown[], over: Record<string, unknown> = {}) => ({
    ...routes,
    'GET /api/projects/uh/uh/orders*': { orders, total: orders.length },
    ...over,
});

const found = async (r: Record<string, unknown>) => {
    const mocked = mockFetch(r);
    render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete />);
    /* The panel is folded by default -- it is a phone-call form, not
       something anybody wants open all day -- so the list inside it has to
       be revealed before it can be used. */
    fireEvent.click(await screen.findByRole('button', { name: /STAT or ad hoc order/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Find orders' }));
    return mocked;
};

describe('finding and removing an order taken by hand', () => {
    it('asks only for hand-taken work, for one day', async () => {
        const { calls } = await found(listed([taken()]));
        await screen.findByText(/Ines Vargas/);
        const asked = calls.find((c) => c.includes('/orders?'));
        /* STAT and ad hoc together. A scheduled delivery came in on a list
           and is withdrawn as a whole list, not a row at a time. */
        expect(asked).toContain('serviceType=stat%2Cadhoc');
        expect(asked).toContain('serviceDate=');
    });

    it('narrows to one pharmacy and one service level', async () => {
        const { calls } = await found(listed([taken()]));
        await screen.findByText(/Ines Vargas/);
        fireEvent.change(screen.getByLabelText('At pharmacy'), { target: { value: '7' } });
        fireEvent.change(screen.getByLabelText('Service level'), { target: { value: 'adhoc' } });
        fireEvent.change(screen.getByLabelText('On day'), { target: { value: '2026-09-14' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find orders' }));

        await waitFor(() => {
            const last = calls.filter((c) => c.includes('/orders?')).pop();
            expect(last).toContain('siteId=7');
            expect(last).toContain('serviceType=adhoc');
            expect(last).toContain('serviceDate=2026-09-14');
        });
    });

    it('says plainly when there is nothing, and why scheduled work is absent', async () => {
        await found(listed([]));
        expect(await screen.findByText(/No STAT or ad hoc order/)).toBeInTheDocument();
        expect(screen.getByText(/withdrawn from the import screen/)).toBeInTheDocument();
    });

    it('says when it is showing fewer orders than there are', async () => {
        /* The list endpoint sends `total` as well as the rows and says why:
           a caller that ignores it tells somebody a short list is the whole
           list. A dispatcher hunting the order they just took must not be
           shown forty-nine of fifty-one and conclude it is not there. */
        await found({ ...routes, 'GET /api/projects/uh/uh/orders*': { orders: [taken()], total: 51 } });
        expect(await screen.findByText(/Showing 1 of 51/)).toBeInTheDocument();
    });

    it('stays quiet when the list is complete', async () => {
        await found(listed([taken()]));
        await screen.findByText(/Ines Vargas/);
        expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    });

    it('will not delete on one click', async () => {
        /* The first press asks. Nothing has been sent at that point: a
           single press on a row in a table is far too easy to do by
           accident for something with no undo. */
        const { calls } = await found(listed([taken()]));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete order 41 for Ines Vargas' }));
        expect(screen.getByText(/permanently\? There is no undo/)).toBeInTheDocument();
        expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    });

    it('lets the confirm be taken back', async () => {
        const { calls } = await found(listed([taken()]));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete order 41 for Ines Vargas' }));
        fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
        expect(screen.queryByText(/There is no undo/)).not.toBeInTheDocument();
        expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    });

    it('says a delivered order is already delivered before it goes', async () => {
        /* Deleting a stop a courier has finished is a different act from
           deleting one nobody has touched, and only the operator can tell
           which this is. */
        await found(listed([taken({ status: 'delivered' })]));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete order 41 for Ines Vargas' }));
        expect(screen.getByText(/already delivered/)).toBeInTheDocument();
    });

    it('deletes on the second press and says what went with it', async () => {
        const { calls } = await found(listed([taken()], {
            'DELETE /api/projects/uh/uh/orders/41': {
                status: 200,
                body: { id: 41, was: { reference: 'RX-9001', status: 'ready' }, onInvoices: ['12:issued'], filesDeleted: 2, runsRemoved: 0 },
            },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete order 41 for Ines Vargas' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

        const said = await screen.findByRole('status');
        expect(said).toHaveTextContent(/Order 41 \(RX-9001\) deleted permanently/);
        /* An invoice that is now short a line is not a detail. */
        expect(said).toHaveTextContent(/on an invoice, which is now short a line/);
        expect(said).toHaveTextContent(/2 photographs went with it/);
        expect(calls).toContain('DELETE /api/projects/uh/uh/orders/41');
    });

    it('re-reads the list afterwards rather than trusting itself', async () => {
        /* A delete can empty a planned run. The list should show what is
           actually there, not what this screen thinks is left. */
        const { calls } = await found(listed([taken()], {
            'DELETE /api/projects/uh/uh/orders/41': {
                status: 200,
                body: { id: 41, was: { reference: '', status: 'ready' }, onInvoices: [], filesDeleted: 0, runsRemoved: 1 },
            },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete order 41 for Ines Vargas' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
        await screen.findByRole('status');
        expect(calls.filter((c) => c.includes('/orders?')).length).toBeGreaterThan(1);
    });

    it('reports a refusal instead of appearing to have deleted it', async () => {
        await found(listed([taken()], {
            'DELETE /api/projects/uh/uh/orders/41': { status: 403, body: { error: 'Only an administrator may delete an order' } },
        }));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete order 41 for Ines Vargas' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/Only an administrator/);
        /* Still listed, because it did not go. Matched on the row's own
           cell rather than the patient's name: the confirm sentence names
           her too, so a name match would pass even if the row had gone. */
        expect(screen.getByText('#41 · RX-9001')).toBeInTheDocument();
    });
});

describe('NewOrder', () => {
    it('offers nothing at all to someone who cannot create orders', () => {
        mockFetch(routes);
        const { container } = render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate={false} canDelete={false} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says STAT is two hours, and that it is also one hour from pickup', async () => {
        mockFetch(routes);
        render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));

        expect(screen.getByText(/Saved now, this is due by/)).toBeInTheDocument();
        expect(screen.getByText(/one hour of pickup/)).toBeInTheDocument();
    });

    it('drops the pickup clock line for ad hoc, which has no such rule', async () => {
        mockFetch(routes);
        render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'adhoc' } });
        expect(screen.queryByText(/one hour of pickup/)).not.toBeInTheDocument();
    });

    it('creates the order and reports its number, deadline and zone', async () => {
        const { calls } = mockFetch({
            ...routes,
            'POST /api/projects/uh/uh/orders': {
                id: 41, serviceType: 'stat', status: 'ready', zone: 1,
                dueAt: '2026-09-14T19:00:00.000Z', recipientName: 'Ines Vargas',
            },
        });
        render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Create order' }));

        expect(await screen.findByRole('status')).toHaveTextContent(/Order 41 created and ready for dispatch/);
        expect(screen.getByRole('status')).toHaveTextContent(/Zone 1/);
        expect(calls).toContain('POST /api/projects/uh/uh/orders');
        // The form closes, so the same call is not saved twice by accident.
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Create order' })).not.toBeInTheDocument());
    });

    it('warns when the address is outside the zone list rather than staying silent', async () => {
        mockFetch({
            ...routes,
            'POST /api/projects/uh/uh/orders': {
                id: 42, serviceType: 'stat', status: 'ready', zone: null,
                dueAt: '2026-09-14T19:00:00.000Z', recipientName: 'Theo Nakamura',
            },
        });
        render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
        expect(await screen.findByRole('status')).toHaveTextContent(/Out of area, so it needs a distance/);
    });

    it('shows the server validation details and keeps the form open', async () => {
        mockFetch({
            ...routes,
            'POST /api/projects/uh/uh/orders': { status: 400, body: { error: 'Invalid request', details: ['zip: five digit ZIP, optionally ZIP+4'] } },
        });
        render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Create order' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request');
        expect(screen.getByText('zip: five digit ZIP, optionally ZIP+4')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create order' })).toBeInTheDocument();
    });
});

/* ────────────────── taking an order is not the same as destroying one
 *
 * Both are dispatch's today, and they are still two flags: the server
 * decides each on its own guard, so a change to one must not quietly move
 * the other. This pins the panel with deleting withheld -- the shape no
 * role is in this week and any role could be next -- because a prop with
 * nobody exercising it is a prop that stops working silently.
 *
 * The failure it stands against: one flag used to draw this whole panel,
 * delete button included, so widening it for dispatch would have handed
 * them a Delete the server then refused. A button that 403s reads as a
 * broken product rather than as a permission somebody does not have.
 */
describe('the panel with deleting withheld', () => {
    const asDispatch = async (r: Record<string, unknown>) => {
        const mocked = mockFetch(r);
        render(<NewOrder projectCode="uh" timezone="America/Chicago" canCreate canDelete={false} />);
        fireEvent.click(await screen.findByRole('button', { name: /STAT or ad hoc order/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Find orders' }));
        return mocked;
    };

    it('still gets the panel and the form', async () => {
        await asDispatch(listed([taken()]));
        expect(await screen.findByText(/Ines Vargas/)).toBeInTheDocument();
    });

    it('is given no Delete button to press', async () => {
        await asDispatch(listed([taken()]));
        await screen.findByText(/Ines Vargas/);
        expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    });

    it('can still read the list, which is how they check their own work', async () => {
        /* The search is not the destructive half. A dispatcher looking for
           the STAT they typed ten minutes ago should find it. */
        const { calls } = await asDispatch(listed([taken()]));
        await screen.findByText(/Ines Vargas/);
        expect(calls.find((c) => c.includes('/orders?'))).toContain('serviceType=stat%2Cadhoc');
    });
});
