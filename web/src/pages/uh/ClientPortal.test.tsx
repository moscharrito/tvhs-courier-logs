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
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'pharmacy' }];
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
    photo: { available: false, reason: '' },
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

    it('shows the doorstep photograph, because the document cannot carry one', async () => {
        /* The PDF writer draws vectors and embeds no images, so the only place
           University Health can ever see the photograph is here. */
        renderPortal(routes({
            [`GET ${BASE}/orders/21`]: detail({ photo: { available: true, reason: '' } }),
        }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        const img = await screen.findByRole('img', { name: /delivery location for Ines Vargas/i });
        /* Our own endpoint, not a storage URL in the markup: it checks this
           viewer may see this delivery, then redirects to a link that expires. */
        expect(img).toHaveAttribute('src', '/api/projects/uh/uh/client/orders/21/photo');
    });

    it('says why the photograph is missing rather than showing a broken frame', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders/21`]: detail({
                photo: { available: false, reason: 'A photograph was taken at the door. File storage is not configured on this server, so it cannot be shown.' },
            }),
        }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        expect(await screen.findByText(/File storage is not configured/i)).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /delivery location/i })).not.toBeInTheDocument();
    });

    it('does not throw when the server is older than the bundle and omits the photo', async () => {
        /* A cached bundle can outlive the server that grew this field. A proof
           of delivery panel that throws is worse than one with no photograph. */
        const withoutPhoto = detail();
        delete (withoutPhoto as Record<string, unknown>)['photo'];
        renderPortal(routes({ [`GET ${BASE}/orders/21`]: withoutPhoto }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        expect(await screen.findByRole('link', { name: 'Open the proof of delivery' })).toBeInTheDocument();
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

/* ------------------------------------------------- the live counter screen
 *
 * This sits open on a pharmacy counter all day. The questions it has to keep
 * answering are "what is still out" and "what went wrong", and both change
 * under the reader while they are looking at them. */
describe('staying current', () => {
    it('says it is live and when it last looked', async () => {
        renderPortal();
        expect(await screen.findByText(/Live/)).toBeInTheDocument();
        expect(screen.getByText(/updated/)).toBeInTheDocument();
    });

    it('stops refreshing when a pharmacist pauses it to read a row', async () => {
        /* A row moving under somebody mid-read is a support call. Pausing is
           theirs to choose, and the screen keeps saying how stale it is. */
        renderPortal();
        const pause = await screen.findByRole('button', { name: 'Pause' });
        fireEvent.click(pause);
        expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
        expect(screen.getByText(/Paused/)).toBeInTheDocument();
    });

    it('reloads on demand without waiting for the timer', async () => {
        const { calls } = renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        const before = calls.filter((c) => c.includes('/client/orders')).length;
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => {
            expect(calls.filter((c) => c.includes('/client/orders')).length).toBeGreaterThan(before);
        });
    });
});

describe('an account covering several pharmacies', () => {
    const many = {
        [`GET ${BASE}/orders*`]: list({
            orders: [
                order({ id: 21, pharmacy: 'Robert B Green Pharmacy' }),
                order({ id: 22, pharmacy: 'Robert B Green Pharmacy', recipientName: 'Delphine Okonkwo' }),
                order({ id: 23, pharmacy: 'University Hospital Discharge Pharmacy', recipientName: 'Marcus Ibarra' }),
            ],
        }),
    };

    it('groups the day by pharmacy rather than one long list', async () => {
        /* A contract manager scoped to eight pharmacies was otherwise reading
           several hundred undifferentiated rows. */
        renderPortal(routes(many));
        expect(await screen.findByRole('button', { name: /Robert B Green Pharmacy/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /University Hospital Discharge Pharmacy/ })).toBeInTheDocument();
    });

    it('says what is inside a pharmacy once it is folded away', async () => {
        /* The shared folding panel shows its summary only while folded: it
           stands in for the content, so printing it above the table it
           describes is the clutter the primitive exists to remove. Folding
           should cost less information, not all of it. */
        renderPortal(routes(many));
        const rbg = await screen.findByRole('button', { name: /Robert B Green Pharmacy/ });
        expect(screen.queryByText(/2 deliveries/)).toBeNull();
        fireEvent.click(rbg);
        expect(await screen.findByText(/2 deliveries/)).toBeInTheDocument();
    });

    it('rolls a pharmacy up and leaves the others alone', async () => {
        renderPortal(routes(many));
        const rbg = await screen.findByRole('button', { name: /Robert B Green Pharmacy/ });
        expect(rbg).toHaveAttribute('aria-expanded', 'true');
        fireEvent.click(rbg);

        await waitFor(() => expect(rbg).toHaveAttribute('aria-expanded', 'false'));
        /* Its rows are gone and the other pharmacy's are not. */
        expect(screen.queryByText('Delphine Okonkwo')).toBeNull();
        expect(screen.getByText('Marcus Ibarra')).toBeInTheDocument();
    });

    it('does not group when the account covers one pharmacy', async () => {
        /* A pharmacist at one counter should never see a section header that
           only ever says their own name. */
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.queryByRole('button', { name: /University Hospital Discharge Pharmacy/ })).toBeNull();
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE DRILL-DOWN.
 *
 * The page had the counts and it had the list and nothing joined them: a
 * pharmacist reading "1 not delivered" had to work out for themselves that
 * the row was somewhere below, and a contract manager arriving from the
 * performance page landed on a filtered list with no statement of what it was
 * filtered to. The tests that matter are the two that stop a figure and the
 * rows under it disagreeing.
 */
describe('opening the figures at the top', () => {
    it('asks the server for the deliveries behind a count', async () => {
        const mocked = renderPortal();
        const stillOut = await screen.findByRole('button', { name: /Show the 3 still out/ });
        fireEvent.click(stillOut);

        /* open, not picked_up: the figure includes everything without an
           outcome, and the server knows that word. Asking for one status
           would show fewer rows than the number just clicked. */
        await waitFor(() => {
            expect(mocked.calls.some((u) => u.includes('status=open'))).toBe(true);
        });
    });

    it('drops the other filters, so the rows match the number clicked', async () => {
        /* The counts are for today across the whole account. Keeping a
           pharmacy or a reference would show a subset of the figure, and
           there is no way for the reader to tell which of the two is wrong. */
        const mocked = renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });

        fireEvent.change(screen.getByLabelText(/Your reference/), { target: { value: 'RX-9999' } });
        await waitFor(() => expect(mocked.calls.some((u) => u.includes('reference=RX-9999'))).toBe(true));

        fireEvent.click(await screen.findByRole('button', { name: /Show the 8 delivered/ }));
        await waitFor(() => {
            const last = [...mocked.calls].reverse().find((u) => u.includes('/orders?'));
            expect(last).toContain('status=delivered');
            expect(last).not.toContain('reference');
        });
    });

    it('does not offer a nought as something to open', async () => {
        /* A link to no rows teaches somebody the page is unreliable. */
        renderPortal(routes({ [`GET ${BASE}/summary`]: summary({ notDelivered: 0 }) }));
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.queryByRole('button', { name: /Show the 0 not delivered/ })).toBeNull();
    });

    it('says the four figures add up, because they did not before', async () => {
        renderPortal();
        expect(await screen.findByText(/add up to what was sent to us/)).toBeInTheDocument();
    });
});

describe('the link to sending a list', () => {
    it('is not offered until the contract has switched it on', async () => {
        /* Off is the default, and a link to a page the server would refuse is
           worse than no link: a pharmacist who follows it and is turned away
           learns that the portal is unreliable. */
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.queryByRole('link', { name: /Send a list/i })).toBeNull();
    });

    it('appears once it is on', async () => {
        renderPortal(routes({ [`GET ${BASE}/summary`]: summary({ canUploadList: true }) }));
        expect(await screen.findByRole('link', { name: /Send a list/i })).toBeInTheDocument();
    });

    it('never hides performance and reports, which every account gets', async () => {
        renderPortal();
        expect(await screen.findByRole('link', { name: /Performance and reports/i })).toBeInTheDocument();
    });
});

describe('arriving from the performance page', () => {
    function renderAt(url: string, r = routes()) {
        const mocked = mockFetch(r);
        render(
            <MemoryRouter initialEntries={[url]}>
                <AuthProvider>
                    <Routes><Route path="/projects/:code/deliveries" element={<ClientPortal />} /></Routes>
                </AuthProvider>
            </MemoryRouter>,
        );
        return mocked;
    }

    it('says in words what the list is narrowed to', async () => {
        /* THE PROPERTY. Without this somebody who clicked "3 not delivered"
           on the performance page is looking at three rows, a set of filter
           boxes they did not fill in, and no statement of why. The natural
           reading of that is that deliveries are missing. */
        renderAt('/projects/uh/deliveries?from=2026-09-01&to=2026-09-30&status=failed');
        const showing = await screen.findByText(/Showing/);
        expect(showing).toHaveTextContent('2026-09-01 to 2026-09-30');
        expect(showing).toHaveTextContent('failed');
    });

    it('names the pharmacy rather than showing its id', async () => {
        renderAt('/projects/uh/deliveries?from=2026-09-14&to=2026-09-14&siteId=7');
        const showing = await screen.findByText(/Showing/);
        expect(showing).toHaveTextContent('University Hospital Discharge Pharmacy');
        expect(showing).not.toHaveTextContent('siteId');
    });

    it('carries a service level through to the server, though the page has no control for it', async () => {
        /* It arrives only by link, from the service-level rows on the
           performance page. Dropping it silently would show a longer list
           than the figure that was clicked. */
        const mocked = renderAt('/projects/uh/deliveries?from=2026-09-14&to=2026-09-14&serviceType=stat');
        await waitFor(() => expect(mocked.calls.some((u) => u.includes('serviceType=stat'))).toBe(true));
        expect(await screen.findByText(/Showing/)).toHaveTextContent('stat');
    });

    it('offers a way back to everything, because a filter arrived by link is easy to miss', async () => {
        renderAt('/projects/uh/deliveries?from=2026-09-01&to=2026-09-30&status=failed');
        expect(await screen.findByRole('button', { name: /Show everything for today/ })).toBeInTheDocument();
    });

    it('says nothing about filters when none are applied', async () => {
        renderPortal();
        await screen.findByRole('heading', { name: 'Deliveries' });
        expect(screen.queryByText(/^Showing/)).toBeNull();
    });
});
