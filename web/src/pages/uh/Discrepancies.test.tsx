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
        renderAs('dispatcher');
        expect(await screen.findByRole('heading', { name: 'Still open' })).toBeInTheDocument();
        expect(screen.getByText('critical')).toBeInTheDocument();
        expect(screen.getByText(/The board showed it as still on the way/)).toBeInTheDocument();
        expect(screen.getByText(/had it back and had signed for it/)).toBeInTheDocument();
        expect(screen.getByText('RX-4182', { exact: false })).toBeInTheDocument();
    });

    it('closes one as changed or as not needing a change', async () => {
        renderAs('dispatcher');
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
        const { calls, bodies } = renderAs('dispatcher', {
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
        const { calls } = renderAs('dispatcher');
        fireEvent.click(await screen.findByRole('button', { name: 'Nothing needs changing' }));
        expect(await screen.findByLabelText(/Why does nothing need changing/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByLabelText(/Why does nothing need changing/)).not.toBeInTheDocument();
        expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
    });
});

describe('the go-live panel', () => {
    it('says what is in the way while anything is open', async () => {
        renderAs('dispatcher');
        expect(await screen.findByText(/critical one means a delivery record was wrong/)).toBeInTheDocument();
    });

    it('does not look like a decision when the board is clean', async () => {
        /* The failure this guards against is a green tick on Friday becoming
           the sign-off that nobody actually gave. */
        renderAs('dispatcher', {
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
