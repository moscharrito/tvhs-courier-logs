/* Onboarding that is running out (ticket 8.4).
 *
 * The screen has one job beyond listing rows, and it is the thing worth
 * testing: it must not let somebody believe the system has acted. Clearance
 * is checked at approval and never again, so a red row here means a courier
 * is carrying medication today without current insurance, not that anybody
 * stopped them.
 *
 * And the couriers with no onboarding record at all have to be on screen.
 * They are the ones a report built from the applications table would show as
 * fine, because there is no row to find anything wrong in.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../app/auth';
import { App } from '../../app/App';
import { mockFetch } from '../../test/setup';
import type { StandingReport } from './Standing';

const session = { id: 3, username: 'u.admin', name: 'U Admin', role: 'staff', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];

const clear: StandingReport = {
    on: '2026-09-17',
    horizonDays: 30,
    lapsed: [],
    soon: [],
    neverOnboarded: [],
    clearCount: 4,
    why: 'Every courier’s onboarding is current, with nothing expiring in the next 30 days.',
};

const trouble: StandingReport = {
    on: '2026-09-17',
    horizonDays: 30,
    lapsed: [{
        username: 'ana.courier', name: 'Ana Ruiz', applicationId: 41,
        lapsed: [{ kind: 'insurance', expiresAt: '2026-08-31', daysLeft: -17 }],
        soon: [{ kind: 'drivers_licence', expiresAt: '2026-10-02', daysLeft: 15 }],
        missing: [], neverOnboarded: false,
    }],
    soon: [{
        username: 'bo.courier', name: 'Bo Adeyemi', applicationId: 42,
        lapsed: [],
        soon: [{ kind: 'hipaa_training', expiresAt: '2026-09-25', daysLeft: 8 }],
        missing: ['background_check'], neverOnboarded: false,
    }],
    neverOnboarded: [{
        username: 'sim.courier.1', name: 'Sim Courier 1', applicationId: null,
        lapsed: [], soon: [], missing: [], neverOnboarded: true,
    }],
    clearCount: 2,
    why: '1 courier is working with something that has already expired; 1 has something expiring within 30 days; 1 holds a courier membership with no onboarding record at all.',
};

const emptyQueue = { applications: [] };

function renderPage(report: StandingReport, extra: Record<string, unknown> = {}) {
    const mocked = mockFetch({
        'GET /api/session': session,
        'GET /api/me/projects': projects,
        'GET /api/projects/uh/driver-applications?status=submitted': emptyQueue,
        'GET /api/projects/uh/driver-applications/standing?withinDays=30': report,
        ...extra,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/applications']}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('the warning that matters', () => {
    it('says outright that nothing here stopped anybody working', async () => {
        /* The point of the whole screen. Somebody who reads three lapsed
           couriers and assumes the system handled it is worse off than
           somebody who read nothing: they now believe a guarantee that does
           not exist. */
        renderPage(trouble);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Nothing here stops anybody working');
        expect(alert).toHaveTextContent(/still being assigned patient names and addresses today/);
    });

    it('does not cry wolf when everything is current', async () => {
        renderPage(clear);
        expect(await screen.findByText(/Every courier’s onboarding is current/)).toBeInTheDocument();
        expect(screen.queryByText(/Nothing here stops anybody working/)).not.toBeInTheDocument();
    });
});

describe('the three conversations', () => {
    it('separates expired from expiring, in words rather than a day count', async () => {
        renderPage(trouble);
        await screen.findByText('Ana Ruiz');

        const lapsedRow = screen.getByText('Ana Ruiz').closest('tr')!;
        expect(lapsedRow).toHaveTextContent('Insurance');
        expect(lapsedRow).toHaveTextContent('expired 17 days ago, on 2026-08-31');

        const soonRow = screen.getByText('Bo Adeyemi').closest('tr')!;
        expect(soonRow).toHaveTextContent('HIPAA training');
        expect(soonRow).toHaveTextContent('8 days left, until 2026-09-25');
    });

    it('shows a lapsed courier’s other expiry without listing them twice', async () => {
        /* Ana has an expired insurance and a licence due in a fortnight. She
           is one row, in the loudest list, and the licence still has to be
           visible or somebody renews one thing and closes the screen. */
        renderPage(trouble);
        const row = (await screen.findByText('Ana Ruiz')).closest('tr')!;
        expect(row).toHaveTextContent(/and soon: Driving licence/);
        /* And she is not also in the expiring list. */
        expect(screen.getAllByText('Ana Ruiz')).toHaveLength(1);
    });

    it('names a check that went back to pending separately from an expiry', async () => {
        renderPage(trouble);
        const row = (await screen.findByText('Bo Adeyemi')).closest('tr')!;
        expect(row).toHaveTextContent(/also not recorded: Background check/);
    });

    it('lists the couriers with no onboarding record at all', async () => {
        /* These are the ones a report built from driver_applications would
           silently count as fine. */
        renderPage(trouble);
        expect(await screen.findByText('Sim Courier 1')).toBeInTheDocument();
        expect(screen.getByText(/no application behind it/)).toBeInTheDocument();
    });

    it('says so when everybody did go through onboarding', async () => {
        renderPage(clear);
        expect(await screen.findByText(/Every courier on this project went through onboarding/)).toBeInTheDocument();
    });
});

describe('the horizon', () => {
    it('asks the server again rather than filtering what it already has', async () => {
        /* The horizon changes which checks count as "soon", and that
           comparison is a date question the server answers in the project's
           timezone. Doing it again in the browser would be a second opinion
           about today. */
        const mocked = renderPage(trouble, {
            'GET /api/projects/uh/driver-applications/standing?withinDays=90': { ...trouble, horizonDays: 90 },
        });
        await screen.findByText('Ana Ruiz');
        fireEvent.change(screen.getByLabelText(/Looking ahead/), { target: { value: '90' } });

        await waitFor(() => {
            expect(mocked.calls).toContain('GET /api/projects/uh/driver-applications/standing?withinDays=90');
        });
        expect(await screen.findByText(/Expiring within 90 days/)).toBeInTheDocument();
    });
});
