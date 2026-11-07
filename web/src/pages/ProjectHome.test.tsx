/* Who gets which panel on the project landing page.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS PINS IS A BUTTON THE SERVER REFUSES.
 *
 * The flags here are the only thing deciding what a role is offered, and
 * they are one boolean each. Widening one by habit draws somebody a form
 * that 403s when they press it, which reads as a broken product rather than
 * as a permission they do not have -- and narrowing one silently removes a
 * screen somebody does their job from.
 *
 * So each row below is paired with the server's own rule, named in the
 * comment, and access-matrix.test.mjs is where that rule actually lives.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProjectHome } from './ProjectHome';
import { AuthProvider } from '../app/auth';
import { mockFetch } from '../test/setup';

const session = { id: 1, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null };

const project = (role: string) => [{
    id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role,
}];

/* The children all fetch on mount. None of them is what these tests are
   about, so they answer empty and stay quiet. */
const settings = {
    sla: { clockStart: 'receipt', scheduledMinutes: 120, statMinutes: 120, statFromPickupMinutes: 60, adhocMinutes: 240 },
    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
    listRelease: { earliest: '12:00', latest: '14:00' },
    pricing: { afterHoursStart: '20:00', afterHoursEnd: '07:00', dryRunReplacesBase: true },
    dispatch: { phone: '', name: 'Dispatch' },
};

const routes = (role: string) => ({
    'GET /api/session': session,
    'GET /api/me/projects': project(role),
    'GET /api/projects/uh/uh/sites': [],
    'GET /api/projects/uh/uh/imports': [],
    'GET /api/projects/uh/uh/orders*': { orders: [], total: 0 },
    'GET /api/projects/uh/settings': {
        timezone: 'America/Chicago', settings, defaults: settings,
        overridden: [], canManage: role === 'admin', example: [],
    },
    'GET /api/projects/uh/uh/pricing*': { zones: [], zipRates: [] },
});

function renderAs(role: string) {
    mockFetch(routes(role));
    render(
        <MemoryRouter initialEntries={['/projects/uh']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code" element={<ProjectHome />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('the site manager, who is dispatch', () => {
    it('is offered the daily list, because taking it in is the job', async () => {
        /* imports.ts lets `lead` call POST /imports since 7 November. A
           dispatcher who cannot take a list in cannot dispatch, and the
           lists arrive by email for them to upload. */
        renderAs('lead');
        expect(await screen.findByRole('heading', { name: /daily list/i })).toBeInTheDocument();
    });

    it('is not offered the manual order form, which the server refuses', async () => {
        /* POST /orders is UH_STAFF. Wiring this to the import flag would
           have drawn dispatch a form that 403s: creating a STAT by phone is
           billable work and stayed with an administrator. */
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });
        expect(screen.queryByRole('heading', { name: /STAT or ad hoc order/i })).toBeNull();
    });

    it('is kept away from the commercials', async () => {
        /* The manager sees the operation and not what it bills at. */
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });
        for (const name of ['Invoices', 'Driver roster', 'Driver applications']) {
            expect(screen.queryByRole('link', { name })).toBeNull();
        }
    });

    it('keeps the screens it already had', async () => {
        renderAs('lead');
        await screen.findByRole('heading', { name: /daily list/i });
        expect(screen.getByRole('link', { name: 'Drivers record' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /client/i })).toBeInTheDocument();
    });
});

describe('an administrator', () => {
    it('keeps everything, unchanged by widening the import flag', async () => {
        renderAs('admin');
        expect(await screen.findByRole('heading', { name: /daily list/i })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Invoices' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Driver roster' })).toBeInTheDocument();
    });
});

describe('everybody else', () => {
    it('sends a courier to their own run and nowhere near the day\'s addresses', async () => {
        /* Asserted as an ABSENCE, not by catching a find and calling the
           result defined -- that passes whatever happens, which is worse
           than no test. The whole page is a day of patient addresses, so
           the thing that matters is that none of it renders. */
        renderAs('courier');
        await waitFor(() => {
            expect(screen.queryByRole('heading', { name: /daily list/i })).toBeNull();
        });
        expect(screen.queryByRole('link', { name: 'Drivers record' })).toBeNull();
    });

    it('does not offer a pharmacy the landing page at all', async () => {
        /* They are redirected to their own portal, so the daily list panel
           must never render for them. */
        renderAs('pharmacy');
        expect(screen.queryByRole('heading', { name: /daily list/i })).toBeNull();
    });
});
