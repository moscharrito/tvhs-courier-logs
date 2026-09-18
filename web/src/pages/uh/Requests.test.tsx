/* Couriers asking for work, on the board (ticket 8.2).
 *
 * What is worth a test here is all about the sweep and about refusals,
 * because those are the two places where a screen can quietly do harm.
 *
 *   1. The sweep previews before it assigns, and the button that assigns
 *      does not exist until somebody has seen what it would do.
 *   2. "Nobody is on shift" is an alert, not a row. It is the case the
 *      sweep cannot fix and the one 6.5 refused to leave silent.
 *   3. The screen says whether the sweep runs on its own, because it does
 *      not, and a button that looks automatic is how a STAT sits there.
 *   4. Losing a race is the server's sentence, not ours.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../app/auth';
import { App } from '../../app/App';
import { mockFetch } from '../../test/setup';

const session = { id: 3, username: 'u.admin', name: 'U Admin', role: 'staff', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];

/* Far enough ahead that the label is stable whenever this runs. */
const inMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString();

const request = (over = {}) => ({
    id: 7, orderId: 4182, status: 'pending',
    requestedAt: new Date().toISOString(), decidedAt: null, decisionReason: '',
    zip: '78229', zone: 2, serviceType: 'stat', dueAt: inMinutes(50),
    courierUsername: 'ana.courier', recipientName: 'Invented Patient',
    ...over,
});

const board = {
    serviceDate: '2026-09-18', generatedAt: new Date().toISOString(), timezone: 'America/Chicago',
    summary: { total: 0, unassigned: 0, assigned: 0, inTransit: 0, delivered: 0, failed: 0, dueSoon: 0, overdue: 0 },
    pool: [], lanes: [], activity: [], couriers: [], idleCouriers: [],
};

function renderBoard(routes: Record<string, unknown> = {}, sweep = { automatic: false, everySeconds: null }) {
    const mocked = mockFetch({
        'GET /api/session': session,
        'GET /api/me/projects': projects,
        'GET /api/projects/uh/uh/board*': board,
        'GET /api/projects/uh/uh/sites': [],
        'GET /api/projects/uh/uh/requests?status=pending': { requests: [request()], sweep },
        ...routes,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/board']}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('the queue', () => {
    it('shows who is waiting and how long the delivery has', async () => {
        renderBoard();
        expect(await screen.findByText('ana.courier')).toBeInTheDocument();
        expect(screen.getByText('Invented Patient')).toBeInTheDocument();
        expect(screen.getByText(/due in 5\d min/)).toBeInTheDocument();
    });

    it('reports losing a race in the server’s words, not ours', async () => {
        /* Two couriers ask for the same stop and the other one is approved
           between this list loading and this click. That is an ordinary
           Tuesday, not an error, and the server says so precisely. */
        renderBoard({
            'POST /api/projects/uh/uh/requests/7/approve': {
                status: 409,
                body: { error: 'Order 4182 was taken by somebody else a moment ago.', code: 'stop.taken' },
            },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('taken by somebody else a moment ago');
    });

    it('says how many other couriers were told they were pipped', async () => {
        renderBoard({
            'POST /api/projects/uh/uh/requests/7/approve': { ok: true, runId: 31, superseded: 2 },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
        expect(await screen.findByText(/2 other couriers were told somebody got there first/)).toBeInTheDocument();
    });

    it('will not send a no without a reason the courier can read', async () => {
        const mocked = renderBoard({ 'POST /api/projects/uh/uh/requests/7/deny': { ok: true } });
        fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
        const why = await screen.findByLabelText(/Why ana\.courier cannot have delivery 4182/);
        expect(why).toBeRequired();
        expect(why).toHaveAttribute('minLength', '3');

        fireEvent.change(why, { target: { value: 'You are already carrying six and two are STATs.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send the no' }));
        await waitFor(() => {
            expect(mocked.bodies['POST /api/projects/uh/uh/requests/7/deny'])
                .toEqual({ reason: 'You are already carrying six and two are STATs.' });
        });
    });
});

describe('the sweep', () => {
    it('says plainly that it does not run on its own', async () => {
        /* SWEEP_INTERVAL_SECONDS is unset in every environment today. A
           dispatcher who assumes otherwise leaves an unclaimed STAT sitting
           there, which is the exact failure ticket 6.5 exists to prevent. */
        renderBoard();
        expect(await screen.findByText(/does not run on its own/)).toBeInTheDocument();
    });

    it('says so the other way when it is switched on', async () => {
        renderBoard({}, { automatic: true, everySeconds: 120 });
        expect(await screen.findByText(/runs on its own every 120 seconds/)).toBeInTheDocument();
    });

    it('previews before it assigns, and offers no way to assign without one', async () => {
        const mocked = renderBoard({
            'POST /api/projects/uh/uh/requests/sweep?dryRun=true': {
                serviceDate: '2026-09-18',
                assigned: [{ orderId: 5001, courierUsername: 'bo.courier', serviceType: 'stat', minutesToDue: 40, runId: null }],
                unassignable: [],
                couriers: [{ courierUsername: 'bo.courier', open: 1 }],
            },
        });
        await screen.findByText('ana.courier');

        /* Nothing that hands out work exists yet. */
        expect(screen.queryByRole('button', { name: /^Hand out/ })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Show me what would be handed out' }));

        expect(await screen.findByText('bo.courier')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Hand out this delivery' })).toBeInTheDocument();
        /* And the preview was a dry run. */
        expect(mocked.calls).toContain('POST /api/projects/uh/uh/requests/sweep?dryRun=true');
        expect(mocked.calls).not.toContain('POST /api/projects/uh/uh/requests/sweep?dryRun=false');
    });

    it('makes nobody on shift an alert rather than a row', async () => {
        /* The case the sweep cannot fix. 6.5: silence here would leave it as
           invisible as it was before the ticket existed. */
        renderBoard({
            'POST /api/projects/uh/uh/requests/sweep?dryRun=true': {
                serviceDate: '2026-09-18',
                assigned: [],
                unassignable: [{ orderId: 5002, serviceType: 'stat', minutesToDue: 12, reason: 'Nobody is on shift.' }],
                couriers: [],
            },
        });
        await screen.findByText('ana.courier');
        fireEvent.click(screen.getByRole('button', { name: 'Show me what would be handed out' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('1 past the point of waiting');
        expect(alert).toHaveTextContent('Nobody is on shift.');
        /* And there is nothing to press, because there is nowhere to send it. */
        expect(screen.queryByRole('button', { name: /^Hand out/ })).not.toBeInTheDocument();
    });

    it('only calls the real thing after the preview', async () => {
        const mocked = renderBoard({
            'POST /api/projects/uh/uh/requests/sweep?dryRun=true': {
                serviceDate: '2026-09-18',
                assigned: [{ orderId: 5001, courierUsername: 'bo.courier', serviceType: 'stat', minutesToDue: 40, runId: null }],
                unassignable: [], couriers: [{ courierUsername: 'bo.courier', open: 1 }],
            },
            'POST /api/projects/uh/uh/requests/sweep?dryRun=false': {
                serviceDate: '2026-09-18',
                assigned: [{ orderId: 5001, courierUsername: 'bo.courier', serviceType: 'stat', minutesToDue: 40, runId: 12 }],
                unassignable: [], couriers: [{ courierUsername: 'bo.courier', open: 2 }],
            },
        });
        await screen.findByText('ana.courier');
        fireEvent.click(screen.getByRole('button', { name: 'Show me what would be handed out' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Hand out this delivery' }));

        expect(await screen.findByText(/1 delivery handed out/)).toBeInTheDocument();
    });
});
