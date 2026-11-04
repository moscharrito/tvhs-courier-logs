/* The shadow week's log, on screen.
 *
 * Ticket 5.2. Two things are worth a test rather than a look.
 *
 * A courier must be able to file one and must not see the log. The person at
 * the door is who notices, and a report they cannot file is a report that
 * becomes a shrug; but reviewing is a judgement about the contract.
 *
 * And a clean board must not look like a decision. A green tick on Friday is
 * how a week with nothing open becomes "we are ready" without anybody having
 * said so.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../app/auth';
import { App } from '../../app/App';
import { mockFetch } from '../../test/setup';

const person = (role: string) => ({
    session: { id: 3, username: `u.${role}`, name: `U ${role}`, role: 'staff', route: null },
    projects: [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role }],
});

const open1 = {
    id: 9, serviceDate: '2026-11-24', kind: 'delivery', severity: 'critical',
    orderId: 4182, reference: 'RX-4182',
    expected: 'The board showed it as still on the way.',
    actual: 'The pharmacy had it back and had signed for it.',
    reportedBy: 'ana.courier', reportedAt: '2026-11-24T14:30:00Z',
    status: 'open', resolution: '', resolvedBy: '', resolvedAt: null,
};

const summary = (over = {}) => ({
    days: [{ serviceDate: '2026-11-24', open: 1, resolved: 2, accepted: 0, critical: 1, major: 2, minor: 0 }],
    totals: { open: 1, resolved: 2, accepted: 0 },
    goLive: { openCritical: 1, openTotal: 1, ready: false, why: '1 critical discrepancies are still open. A critical one means a delivery record was wrong or missing.' },
    ...over,
});

function renderAs(role: string, routes: Record<string, unknown> = {}) {
    const p = person(role);
    const mocked = mockFetch({
        'GET /api/session': p.session,
        'GET /api/me/projects': p.projects,
        'GET /api/projects/uh/uh/discrepancies?status=open': [open1],
        'GET /api/projects/uh/uh/discrepancies/summary': summary(),
        ...routes,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/discrepancies']}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('a courier', () => {
    it('can file one, and is told why it matters', async () => {
        const { calls } = renderAs('courier', {
            'POST /api/projects/uh/uh/discrepancies': { status: 201, body: { ...open1, id: 10 } },
        });

        fireEvent.change(await screen.findByLabelText(/What the system said/), { target: { value: 'Board said on the way' } });
        fireEvent.change(screen.getByLabelText(/What actually happened/), { target: { value: 'Pharmacy already had it' } });
        fireEvent.click(screen.getByRole('button', { name: 'File it' }));

        await waitFor(() => expect(calls).toContain('POST /api/projects/uh/uh/discrepancies'));
        expect(await screen.findByText(/nobody was looking/)).toBeInTheDocument();
    });

    it('gets the form already open, because filing is why they came', async () => {
        /* A courier reaches this from "Something not matching what you see?"
           on their run. Making them open a panel first would be a tap
           between a driver at a door and the thing they noticed. */
        renderAs('courier');
        expect(await screen.findByRole('button', { name: /Report one/ })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'File it' })).toBeInTheDocument();
    });

    it('is asked not to type a patient name, and given the right way instead', async () => {
        renderAs('courier');
        expect(await screen.findByLabelText(/Delivery number/)).toBeInTheDocument();
        expect(screen.getByText(/do not type a patient/i)).toBeInTheDocument();
    });

    it('does not see the log or the go-live panel', async () => {
        const { calls } = renderAs('courier');
        expect(await screen.findByRole('heading', { name: 'Report one' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Still open' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Where the week stands' })).not.toBeInTheDocument();
        // And nothing was even asked for.
        expect(calls).not.toContain('GET /api/projects/uh/uh/discrepancies/summary');
    });
});

describe('a dispatcher', () => {
    it('sees what is open, worst first, with both sides of it', async () => {
        renderAs('admin');
        expect(await screen.findByRole('heading', { name: 'Still open' })).toBeInTheDocument();
        expect(screen.getByText('critical')).toBeInTheDocument();
        expect(screen.getByText(/The board showed it as still on the way/)).toBeInTheDocument();
        expect(screen.getByText(/had it back and had signed for it/)).toBeInTheDocument();
        expect(screen.getByText('RX-4182', { exact: false })).toBeInTheDocument();
    });

    it('gets the form folded, because reading is why they came', async () => {
        /* Same screen, opposite job. Dispatch opens this to read what was
           filed, so the week's state is the first thing on the page and the
           reporting form is one row they can open if they need it. */
        renderAs('admin', { 'GET /api/projects/uh/uh/discrepancies/summary': summary() });
        expect(await screen.findByRole('button', { name: /Report one/ })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: 'File it' })).not.toBeInTheDocument();
        // And what they did come for is there without a click.
        expect(screen.getByText('Where the week stands')).toBeInTheDocument();
    });

    it('closes one as changed or as not needing a change', async () => {
        renderAs('admin');
        expect(await screen.findByRole('button', { name: 'Something was changed' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Nothing needs changing' })).toBeInTheDocument();
    });

    it('asks for the sentence in a real field, not a window.prompt', async () => {
        /* window.prompt is unstyled, unlabelled, cannot be validated, and is
           blocked outright in some browsers and embedded webviews, where the
           button threw and did nothing. The sentence is what somebody reads
           back at the end of the shadow week. Found by walking
           docs/day-rehearsal.md. */
        const prompt = vi.spyOn(window, 'prompt');
        const { calls, bodies } = renderAs('admin', {
            'PATCH /api/projects/uh/uh/discrepancies/9': { ...open1, status: 'resolved' },
        });

        fireEvent.click(await screen.findByRole('button', { name: 'Something was changed' }));
        expect(prompt).not.toHaveBeenCalled();

        const field = await screen.findByLabelText(/What was changed/);
        fireEvent.change(field, { target: { value: 'Run sheet count corrected at pickup.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Close as changed' }));

        await waitFor(() => expect(calls).toContain('PATCH /api/projects/uh/uh/discrepancies/9'));
        expect(bodies['PATCH /api/projects/uh/uh/discrepancies/9']).toMatchObject({
            status: 'resolved', resolution: 'Run sheet count corrected at pickup.',
        });
    });

    it('lets somebody back out without closing anything', async () => {
        const { calls } = renderAs('admin');
        fireEvent.click(await screen.findByRole('button', { name: 'Nothing needs changing' }));
        expect(await screen.findByLabelText(/Why does nothing need changing/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByLabelText(/Why does nothing need changing/)).not.toBeInTheDocument();
        expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
    });
});

describe('narrowing the log', () => {
    /* It asked for `?status=open` and showed every open dispute on the
       contract. Across nine counters that is a list nobody can act on: the
       question somebody has is "what is outstanding at Wheatley for
       Tuesday". */

    const sites = [
        { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
        { id: 9, code: 'green', name: 'University Health Robert B. Green Pharmacy' },
    ];
    const withSites = (over = {}) => ({
        'GET /api/projects/uh/uh/sites': sites,
        ...over,
    });

    it('asks for everything until somebody narrows it', async () => {
        /* A log that defaulted to today would hide an open dispute from
           last week, which is the one most worth chasing. */
        const { calls } = renderAs('admin', withSites());
        await screen.findByRole('heading', { name: 'Still open' });
        expect(calls).toContain('GET /api/projects/uh/uh/discrepancies?status=open');
    });

    it('asks the server for one pharmacy rather than sifting here', async () => {
        /* THE WHOLE POINT. The endpoint caps at 500 rows, so a filter
           applied in the browser could never reach a dispute past that
           edge -- which is exactly the old one being hunted for. */
        const { calls } = renderAs('admin', withSites({
            'GET /api/projects/uh/uh/discrepancies?status=open&siteId=9': [],
        }));
        await screen.findByRole('heading', { name: 'Still open' });

        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '9' } });
        await waitFor(() => {
            expect(calls).toContain('GET /api/projects/uh/uh/discrepancies?status=open&siteId=9');
        });
    });

    it('asks for one day the same way', async () => {
        const { calls } = renderAs('admin', withSites({
            'GET /api/projects/uh/uh/discrepancies?status=open&serviceDate=2026-11-24': [open1],
        }));
        await screen.findByRole('heading', { name: 'Still open' });

        fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-11-24' } });
        await waitFor(() => {
            expect(calls).toContain('GET /api/projects/uh/uh/discrepancies?status=open&serviceDate=2026-11-24');
        });
    });

    it('says which empty it is, because the two mean opposite things', async () => {
        /* "Nothing open" under a filter hiding four disputes is the wrong
           thing to tell somebody deciding whether to go live. */
        renderAs('admin', withSites({
            'GET /api/projects/uh/uh/discrepancies?status=open&siteId=9': [],
        }));
        await screen.findByRole('heading', { name: 'Still open' });

        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '9' } });
        expect(await screen.findByText('Nothing open for that day and pharmacy.')).toBeInTheDocument();
    });

    it('offers a way back to everything once something is narrowed', async () => {
        const { calls } = renderAs('admin', withSites({
            'GET /api/projects/uh/uh/discrepancies?status=open&siteId=9': [],
        }));
        await screen.findByRole('heading', { name: 'Still open' });
        expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '9' } });
        const clear = await screen.findByRole('button', { name: 'Clear' });
        const before = calls.length;
        fireEvent.click(clear);

        await waitFor(() => {
            expect(calls.slice(before)).toContain('GET /api/projects/uh/uh/discrepancies?status=open');
        });
    });
});

describe('the go-live panel', () => {
    it('says what is in the way while anything is open', async () => {
        renderAs('admin');
        expect(await screen.findByText(/critical one means a delivery record was wrong/)).toBeInTheDocument();
    });

    it('does not look like a decision when the board is clean', async () => {
        /* The failure this guards against is a green tick on Friday becoming
           the sign-off that nobody actually gave. */
        renderAs('admin', {
            'GET /api/projects/uh/uh/discrepancies?status=open': [],
            'GET /api/projects/uh/uh/discrepancies/summary': summary({
                totals: { open: 0, resolved: 12, accepted: 3 },
                goLive: { openCritical: 0, openTotal: 0, ready: true, why: 'Nothing is open. That is necessary and not sufficient: somebody still has to decide.' },
            }),
        });

        expect(await screen.findByText(/necessary and not sufficient/)).toBeInTheDocument();
        expect(screen.getByText(/somebody still has to decide/)).toBeInTheDocument();
        expect(screen.getByText('Nothing open.')).toBeInTheDocument();
    });
});

describe('filing one when something is wrong with the form', () => {
    /* GO-LIVE MORNING, 1 NOVEMBER. A courier filled this in, pressed File
       it, and got the words "Invalid request" in a red box. Nothing on the
       screen said which box was wrong and nothing could be done about it. */
    const fill = async (over: Record<string, string> = {}) => {
        const mocked = renderAs('courier');
        await screen.findByRole('heading', { name: 'Discrepancies' });
        fireEvent.change(screen.getByLabelText(/What the system said/), { target: { value: over.expected ?? 'The upload should have finished.' } });
        fireEvent.change(screen.getByLabelText(/What actually happened/), { target: { value: over.actual ?? 'App crashed during upload' } });
        if (over.reference !== undefined) {
            fireEvent.change(screen.getByLabelText(/Delivery number/), { target: { value: over.reference } });
        }
        return mocked;
    };

    it('refuses a delivery number that is not a number, and says so in words', async () => {
        /* THE BUG. `Number('Charlie')` is NaN, JSON.stringify writes NaN as
           null, and the schema answers "orderId: Expected number, received
           null" -- the same shape as the photo upload on 31 October, and
           the same unreadable "Invalid request" at the far end of it.
           Caught here now, and the box is named. */
        const mocked = await fill({ reference: 'Charlie' });
        fireEvent.click(screen.getByRole('button', { name: 'File it' }));

        expect(await screen.findByText(/delivery number has to be a number/i)).toBeInTheDocument();
        /* And nothing was sent: a refusal the server never saw. */
        expect(mocked.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    });

    it('sends nothing for the delivery number when it is left empty', async () => {
        /* Empty is the normal case -- most reports are not about one
           delivery -- and it must be ABSENT from the body rather than null,
           which is what the schema refuses. */
        const mocked = await fill();
        fireEvent.click(screen.getByRole('button', { name: 'File it' }));

        await waitFor(() => expect(mocked.calls.some((c) => c.startsWith('POST'))).toBe(true));
        const sent = mocked.bodies['POST /api/projects/uh/uh/discrepancies'] as Record<string, unknown>;
        expect('orderId' in sent).toBe(false);
    });

    it('shows the field the server named, instead of "Invalid request" alone', async () => {
        const mocked = renderAs('courier', {
            'POST /api/projects/uh/uh/discrepancies': {
                status: 400,
                body: { error: 'Invalid request', details: ['expected: String must contain at least 3 character(s)'] },
            },
        });
        await screen.findByRole('heading', { name: 'Discrepancies' });
        fireEvent.change(screen.getByLabelText(/What the system said/), { target: { value: 'something' } });
        fireEvent.change(screen.getByLabelText(/What actually happened/), { target: { value: 'App crashed during upload' } });
        fireEvent.click(screen.getByRole('button', { name: 'File it' }));

        expect(await screen.findByText(/at least 3 character/i)).toBeInTheDocument();
        expect(mocked.calls.some((c) => c.startsWith('POST'))).toBe(true);
    });
});
