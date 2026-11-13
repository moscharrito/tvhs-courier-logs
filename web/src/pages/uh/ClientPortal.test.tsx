/* The client portal screen.

   What matters here is what a pharmacist can do with it at a counter: see
   today at a glance, find the one that did not arrive without hunting for it,
   and read the proof for a delivery somebody is asking about. And what they
   are not offered: a search by patient name. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ClientPortal, awayLabel } from './ClientPortal';
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

/* WHAT THE HEADING IS NOW.
 *
 * The page used to be headed "Deliveries" with the counter's name in grey
 * underneath. For an account scoped to ONE pharmacy that is the wrong way
 * round -- a pharmacist opening their own portal should see their pharmacy
 * first -- so the counter's name is the h1 and "Deliveries for <date>" is the
 * subtitle. An account with none or several keeps the generic word, because
 * no single counter is the subject.
 *
 * Nearly every test here waits for the page to settle, so the wait goes
 * through one helper rather than being spelled out thirty times. */
const COUNTER = 'University Hospital Discharge Pharmacy';
const settled = (name = COUNTER) => screen.findByRole('heading', { name });

describe('ClientPortal', () => {
    it('leads with today in four numbers', async () => {
        renderPortal();
        expect(await settled()).toBeInTheDocument();
        const today = screen.getByRole('heading', { name: 'Today' }).closest('.izy-card') as HTMLElement;
        expect(within(today).getByText('12')).toBeInTheDocument();
        expect(within(today).getByText('still out')).toBeInTheDocument();
        expect(within(today).getByText('not delivered')).toBeInTheDocument();
    });

    it('names the pharmacy the account is scoped to, as the heading', async () => {
        /* Stronger than it was: the counter's name is no longer merely
           somewhere on the page, it is what the page is called. */
        renderPortal();
        expect(await settled()).toBeInTheDocument();
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
        await settled();
        const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
        expect(names[0]).toContain('Failed Person');
        expect(names[0]).toContain('could not get access'.replace('could not get access', 'no access'));
    });

    it('says why patient names cannot be searched, rather than silently not working', async () => {
        /* One box now, matching the reference, the pharmacy, the status, the
           service level and the zone. The sentence underneath matters as much
           as the box: a pharmacist who types a patient's name and gets
           nothing will otherwise assume the portal is broken. */
        renderPortal();
        await settled();
        expect(screen.getByLabelText('Search')).toBeInTheDocument();
        expect(screen.queryByLabelText(/patient name/i)).not.toBeInTheDocument();
        expect(screen.getByText(/not searchable/)).toBeInTheDocument();
    });

    it('shows the proof of delivery for one delivery on request', async () => {
        renderPortal();
        await settled();
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
        await settled();
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
        await settled();
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
        await settled();
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
        await settled();
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        expect(await screen.findByRole('link', { name: 'Open the proof of delivery' })).toBeInTheDocument();
    });

    it('tells an unscoped account what is wrong instead of showing an empty page', async () => {
        renderPortal(routes({
            [`GET ${BASE}/summary`]: summary({ pharmacies: [], total: 0, outstanding: 0, delivered: 0, notDelivered: 0, notes: ['No pharmacies are assigned to this account yet. Ask Izy dispatch to set them up.'] }),
            [`GET ${BASE}/orders*`]: list({ pharmacies: [], orders: [], notes: ['No pharmacies are assigned to this account yet. Ask Izy dispatch to set them up.'] }),
        }));
        /* No counter to name, so the generic heading is the right one. */
        await settled('Deliveries');
        expect(screen.getByText(/No pharmacies are assigned to this account yet/)).toBeInTheDocument();
        expect(screen.getByText('Nothing for this day.')).toBeInTheDocument();
    });

    /* ──────────────────────────────── when the range holds more than a page
     *
     * THE CONTRACT MANAGER COULD NOT SEE HIS OWN CONTRACT.
     *
     * This said "Showing the first 500. Narrow the dates to see the rest" --
     * sound advice for a pharmacist looking at today, and useless to the
     * person who oversees nine pharmacies and reconciles a month, because
     * his question IS the month. He was told there was more and never how
     * much. Reported on 12 November 2026.
     *
     * It also said 500 whatever had actually come back, which is the kind of
     * hardcoded figure that is quietly wrong for a year.
     */
    it('says how many the range holds, not just that it was cut short', async () => {
        renderPortal(routes({ [`GET ${BASE}/orders*`]: list({ truncated: true, total: 7812, maxRows: 10000 }) }));
        await settled();
        expect(screen.getByText(/Showing the first 1 of 7,812/)).toBeInTheDocument();
    });

    it('offers to load the lot, and says so in the figure', async () => {
        renderPortal(routes({ [`GET ${BASE}/orders*`]: list({ truncated: true, total: 7812, maxRows: 10000 }) }));
        await settled();
        expect(screen.getByRole('button', { name: 'Show all 7,812' })).toBeInTheDocument();
    });

    it('asks the server for the lot when told to, and stops the screen moving under the reader', async () => {
        /* Several thousand rows must not reload themselves every twenty
           seconds while somebody is reading one. */
        const asked: string[] = [];
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: (url: string) => {
                asked.push(url);
                return asked.length === 1
                    ? list({ truncated: true, total: 7812, maxRows: 10000 })
                    : list({ truncated: false, total: 7812, maxRows: 10000 });
            },
        }));
        await settled();
        fireEvent.click(screen.getByRole('button', { name: 'Show all 7,812' }));
        await settled();

        expect(asked.some((u) => u.includes('limit=10000'))).toBe(true);
        expect(screen.getByText(/Showing all 1\./)).toBeInTheDocument();
        expect(screen.getByText(/Live updating is paused/)).toBeInTheDocument();
    });

    it('still asks for a narrower range when the range is past what a screen serves', async () => {
        /* A browser handed a quarter of a million rows renders nothing and
           the reader concludes the portal is broken, which is where this
           started. So there is a ceiling, and past it the spreadsheet -- the
           one thing with no such limit -- is named rather than left for
           somebody to remember. */
        renderPortal(routes({ [`GET ${BASE}/orders*`]: list({ truncated: true, total: 94000, maxRows: 10000 }) }));
        await settled();
        expect(screen.getByText(/Showing the first 1 of 94,000/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
        expect(screen.getByText(/Narrow the dates .* export to Excel/is)).toBeInTheDocument();
    });

    it('does not leave the row ceiling on the export links', async () => {
        /* A spreadsheet cut to the first page of a screen is the bug this
           whole change is about, pointing the other way. */
        renderPortal(routes({ [`GET ${BASE}/orders*`]: list({ truncated: true, total: 7812, maxRows: 10000 }) }));
        await settled();
        fireEvent.click(screen.getByRole('button', { name: 'Show all 7,812' }));
        await settled();
        for (const name of ['Export to Excel', 'Export with proof of delivery']) {
            const link = screen.getByRole('link', { name });
            expect(link.getAttribute('href')).not.toContain('limit=');
        }
    });

    it('offers the deliveries and their proof in one archive', async () => {
        /* Checking an invoice line against the signature behind it meant
           opening each delivery and downloading its document one at a time.
           University Health asked for it in bulk on 12 November 2026. */
        renderPortal(routes({}));
        await settled();
        const link = screen.getByRole('link', { name: 'Export with proof of delivery' });
        expect(link.getAttribute('href')).toContain('/orders-with-pod.zip');
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
        await settled();
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
        /* Exact, not a substring. While the panel is OPEN the pager under
           its table says "All 2 deliveries", which a /2 deliveries/ regex
           also matches; the summary this test is about is the bare phrase
           the folded heading carries. */
        expect(screen.queryByText('2 deliveries')).toBeNull();
        fireEvent.click(rbg);
        expect(await screen.findByText('2 deliveries')).toBeInTheDocument();
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

    it('pages each pharmacy on its own, grouped (7.8)', async () => {
        /* The gap 7.8 closed: the grouped view rendered every counter whole
           while the single-pharmacy view beside it paged at eight, so a
           contract manager opening Robert B Green got all 241 rows in one
           panel. One page number per table, because nine pharmacies sharing
           one would all turn to page 2 together. */
        const pile = (pharmacy: string, base: number, n: number) => Array.from({ length: n }, (_, i) => order({
            id: base + i, pharmacy, recipientName: `Patient ${base + i}`, reference: `RX-${base + i}`,
        }));
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: list({
                orders: [...pile('Robert B Green Pharmacy', 100, 12), ...pile('University Hospital Discharge Pharmacy', 200, 12)],
            }),
        }));
        await screen.findByRole('button', { name: /Robert B Green Pharmacy/ });

        const pagers = screen.getAllByRole('navigation', { name: 'deliveries pages' });
        const green = pagers[0]!;
        const discharge = pagers[1]!;
        expect(within(green).getByText('Showing 1 to 8 of 12 deliveries')).toBeInTheDocument();
        expect(screen.getByText('Patient 100')).toBeInTheDocument();
        expect(screen.queryByText('Patient 108')).toBeNull();

        fireEvent.click(within(green).getByRole('button', { name: 'Next' }));
        expect(screen.getByText('Patient 108')).toBeInTheDocument();
        /* The other counter did not move with it. */
        expect(within(discharge).getByText('Showing 1 to 8 of 12 deliveries')).toBeInTheDocument();
        expect(screen.getByText('Patient 200')).toBeInTheDocument();
    });

    it('does not group when the account covers one pharmacy', async () => {
        /* A pharmacist at one counter should never see a section header that
           only ever says their own name. */
        renderPortal();
        await settled();
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
        await settled();

        fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'RX-9999' } });
        await waitFor(() => expect(mocked.calls.some((u) => u.includes('q=RX-9999'))).toBe(true));

        fireEvent.click(await screen.findByRole('button', { name: /Show the 8 delivered/ }));
        await waitFor(() => {
            const last = [...mocked.calls].reverse().find((u) => u.includes('/orders?'));
            expect(last).toContain('status=delivered');
            expect(last).not.toContain('q=');
        });
    });

    it('does not offer a nought as something to open', async () => {
        /* A link to no rows teaches somebody the page is unreliable. */
        renderPortal(routes({ [`GET ${BASE}/summary`]: summary({ notDelivered: 0 }) }));
        await settled();
        expect(screen.queryByRole('button', { name: /Show the 0 not delivered/ })).toBeNull();
    });

    it('says the four figures add up, because they did not before', async () => {
        renderPortal();
        expect(await screen.findByText(/add up to what was sent to the courier/)).toBeInTheDocument();
    });

    it('calls the total what it is: what went to the courier, not to "us"', async () => {
        /* "Sent to us" is read on a screen with University Health's own name
           at the top, where the natural reading of "us" is the hospital. It
           is the opposite: the figure counts what the pharmacy handed over.
           Renamed on their own reading of the page, 12 November 2026. */
        renderPortal();
        await settled();
        expect(screen.getByText(/sent to courier/i)).toBeInTheDocument();
        expect(screen.queryByText(/sent to us/i)).toBeNull();
    });
});

describe('the link to sending a list', () => {
    it('is not offered until the contract has switched it on', async () => {
        /* Off is the default, and a link to a page the server would refuse is
           worse than no link: a pharmacist who follows it and is turned away
           learns that the portal is unreliable. */
        renderPortal();
        await settled();
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

/* ────────────────────────────── an account with no counter of its own
 *
 * The contract manager and the billing staff oversee nine pharmacies and
 * dispense at none. Two panels on this page belong to a counter: sending
 * tomorrow's list, and the receipt for the lists already handed over. On
 * their screen the first is a question with no answer -- whose list, from
 * which counter? -- and the second is nine pharmacies' paperwork in one
 * pile. University Health asked for both off on 12 November 2026, having
 * looked at the page.
 *
 * The flag comes from the server and grants nothing. A counter that does
 * not send it is a counter, which is the safe direction: an older server
 * leaves this screen exactly as it was.
 */
describe('a portal that oversees the contract', () => {
    const overseer = (over = {}) => routes({
        [`GET ${BASE}/summary`]: summary({
            canUploadList: true, overseesContract: true, ...over,
        }),
    });

    it('is not offered a list to send, because it has no counter to send one from', async () => {
        renderPortal(overseer());
        await settled();
        expect(screen.queryByRole('link', { name: /Send a list/i })).toBeNull();
    });

    it("is not shown the lists handed over, which are a counter's own receipt", async () => {
        renderPortal(overseer());
        await settled();
        expect(screen.queryByText(/Lists handed over/i)).toBeNull();
    });

    it('keeps them for a counter, which is what they are for', async () => {
        /* The half of this that would be easy to break and hard to notice:
           a pharmacy that loses the only way it has to send tomorrow's list
           goes back to email and nobody here finds out. */
        renderPortal(routes({ [`GET ${BASE}/summary`]: summary({ canUploadList: true }) }));
        await settled();
        expect(screen.getByRole('link', { name: /Send a list/i })).toBeInTheDocument();
        expect(screen.getByText(/Lists handed over/i)).toBeInTheDocument();
    });

    it('still offers the contract manager the pharmacy logins', async () => {
        /* Kept for him and not for billing, and the difference is the
           membership rather than this screen: billing does not carry the
           capability, so the server reports false and the server refuses
           the page too. */
        renderPortal(overseer({ canResetPortalPasswords: true }));
        await settled();
        expect(screen.getByRole('link', { name: /Pharmacy logins/i })).toBeInTheDocument();
    });

    it('offers billing no pharmacy logins', async () => {
        renderPortal(overseer({ canResetPortalPasswords: false }));
        await settled();
        expect(screen.queryByRole('link', { name: /Pharmacy logins/i })).toBeNull();
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
        await settled();
        expect(screen.queryByText(/^Showing/)).toBeNull();
    });
});

/* ───────────────────────────────────────── how far away it is
 *
 * The server worked this out for a single delivery from the start and no
 * screen ever read it, so "estimated delivery time", which University Health
 * asked for by name, existed only in the JSON. It is on the list now, because
 * a pharmacy watching a dozen deliveries wants to know which is next without
 * opening twelve panels.
 */
describe('the estimate on the list', () => {
    const onItsWay = (eta: unknown) => order({
        status: 'picked_up', arrivedAt: null, deliveredAt: null, receivedBy: '',
        sla: sla({ state: 'due', minutesToDue: 40 }), eta,
    });

    it('says how far away a delivery on the way is', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: list({
                orders: [onItsWay({ minutes: 36, stopsAhead: 2, basis: 'estimated', note: '2 stops ahead of it, at about 12 minutes a stop.' })],
            }),
        }));
        await settled();

        const row = screen.getByText('Ines Vargas').closest('tr') as HTMLElement;
        expect(row).toHaveTextContent('about 35 min away');
        /* The queue position beside the figure, so nobody reads it as a
           routed arrival. It is not one: see modules/uh/eta.ts. */
        expect(row).toHaveTextContent('2 stops ahead');
    });

    it('rounds, because the input is a median times a queue length', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: list({
                orders: [onItsWay({ minutes: 73, stopsAhead: 5, basis: 'estimated', note: '' })],
            }),
        }));
        await settled();
        // "about 73 minutes" claims a precision this has not got.
        const row = screen.getByText('Ines Vargas').closest('tr') as HTMLElement;
        expect(row).toHaveTextContent('about 1 hr 15 min away');
        expect(row).not.toHaveTextContent('73');
    });

    it('never shows it as a clock time, which would read as a promise', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: list({
                orders: [onItsWay({ minutes: 24, stopsAhead: 1, basis: 'estimated', note: '' })],
            }),
        }));
        await settled();
        const row = screen.getByText('Ines Vargas').closest('tr') as HTMLElement;
        expect(row.textContent).not.toMatch(/\d{1,2}:\d{2}\s*(am|pm)?\s*(arriv|eta|away)/i);
    });

    it('stays quiet on the list when there is no figure', async () => {
        /* The refusals are honest and they are not list material: forty rows
           of "not yet collected" is forty lines of why-not. The reason
           belongs on the delivery somebody actually asked about. */
        renderPortal(routes({
            [`GET ${BASE}/orders*`]: list({
                orders: [onItsWay({ minutes: null, stopsAhead: null, basis: 'not_collected', note: 'Not yet collected from the pharmacy.' })],
            }),
        }));
        await settled();
        const row = screen.getByText('Ines Vargas').closest('tr') as HTMLElement;
        expect(row).not.toHaveTextContent('away');
        expect(row).not.toHaveTextContent('Not yet collected');
    });

    it('renders a list from a server too old to send one', async () => {
        /* The field is new on an endpoint the portal already had. A page that
           throws is worse than a page without a column. */
        renderPortal(routes({ [`GET ${BASE}/orders*`]: list({ orders: [onItsWay(undefined)] }) }));
        await settled();
        expect(screen.getByText('Ines Vargas')).toBeInTheDocument();
    });

    it('gives the reason on the delivery somebody opens', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders/21`]: detail({
                status: 'assigned', arrivedAt: null, deliveredAt: null, receivedBy: '',
                eta: { minutes: null, stopsAhead: null, basis: 'not_collected', note: 'Not yet collected from the pharmacy.' },
            }),
        }));
        await settled();
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        const proof = await screen.findByRole('region', { name: /Proof of delivery for Ines Vargas/ });
        expect(proof).toHaveTextContent('How far away');
        /* Here the refusal IS the answer: a pharmacist who opened one
           delivery to ask when it arrives is better served by the reason
           than by a blank row. */
        expect(proof).toHaveTextContent('Not yet collected from the pharmacy');
        expect(proof).toHaveTextContent('no estimate');
    });

    it('shows the figure and its basis on the delivery somebody opens', async () => {
        renderPortal(routes({
            [`GET ${BASE}/orders/21`]: detail({
                status: 'picked_up', arrivedAt: null, deliveredAt: null, receivedBy: '',
                eta: { minutes: 36, stopsAhead: 2, basis: 'estimated', note: '2 stops ahead of it, at about 12 minutes a stop.' },
            }),
        }));
        await settled();
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));

        const proof = await screen.findByRole('region', { name: /Proof of delivery for Ines Vargas/ });
        expect(proof).toHaveTextContent('about 35 min');
        expect(proof).toHaveTextContent('at about 12 minutes a stop');
    });
});

describe('awayLabel', () => {
    it('leaves a short wait alone and rounds a long one', () => {
        expect(awayLabel(7)).toBe('about 7 min');
        expect(awayLabel(15)).toBe('about 15 min');
        expect(awayLabel(36)).toBe('about 35 min');
        expect(awayLabel(60)).toBe('about 1 hr');
        expect(awayLabel(73)).toBe('about 1 hr 15 min');
        expect(awayLabel(145)).toBe('about 2 hr 25 min');
    });
});

/* ───────────────────────────────────────────── proof that it came back
 *
 * A pharmacy's question about a failed delivery is "where is my
 * medication", not "show me the door". The courier photographs the signed
 * part 3 at the counter on every return, and until now no screen showed it
 * to the people whose medication it was.
 */
describe('the proof of return', () => {
    const openProof = async (over: Record<string, unknown>) => {
        renderPortal(routes({
            [`GET ${BASE}/orders/21`]: detail({
                status: 'failed', deliveredAt: null, receivedBy: '',
                failureReason: 'nobody_home', ...over,
            }),
        }));
        await settled();
        fireEvent.click(screen.getByRole('button', { name: 'Proof' }));
        return screen.findByRole('region', { name: /Proof of delivery for Ines Vargas/ });
    };

    it('shows the signed sheet when there is one', async () => {
        const proof = await openProof({ returnForm: { available: true, reason: '' } });
        expect(proof).toHaveTextContent('The signed sheet for the return attempt');
        const img = screen.getByAltText(/signed return form for Ines Vargas/i);
        expect(img).toHaveAttribute('src', '/api/projects/uh/uh/client/orders/21/return-form');
    });

    it('says the sheet covers other deliveries, because it does', async () => {
        /* One form covers everything handed back together. A pharmacist
           reading it as evidence about this patient alone is reading it
           wrong, so the caption says so. */
        const proof = await openProof({ returnForm: { available: true, reason: '' } });
        expect(proof).toHaveTextContent(/may list other deliveries brought back at the same time/i);
    });

    it('gives the reason instead of a broken image', async () => {
        const proof = await openProof({
            returnForm: {
                available: false,
                reason: 'This came back to a pharmacy, but no photograph of the signed return form was recorded.',
            },
        });
        expect(proof).toHaveTextContent('The signed sheet for the return attempt');
        expect(proof).toHaveTextContent(/no photograph of the signed return form/i);
        expect(screen.queryByAltText(/signed return form/i)).toBeNull();
    });

    it('says nothing at all about a delivery that never came back', async () => {
        /* A return is a custody fact and never an outcome. A delivery that
           arrived has no return form, and the panel must not imply one is
           missing. */
        const proof = await openProof({ returnForm: { available: false, reason: '' } });
        expect(proof).not.toHaveTextContent('The signed sheet for the return attempt');
    });

    it('renders against a server too old to send the field', async () => {
        const proof = await openProof({});
        expect(proof).not.toHaveTextContent('The signed sheet for the return attempt');
        expect(proof).toHaveTextContent('Ines Vargas');
    });
});
