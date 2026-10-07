/* A pharmacy sending us its own list.
 *
 * The screen is the dispatch import screen with the pharmacy list injected
 * and the wording changed, so what is worth testing here is not the upload
 * flow, which ListImport.test.tsx already covers. It is the two things that
 * are specific to a client reading it:
 *
 *   it never asks for GET /sites, which carries every University Health
 *   site's address and contact and is closed to this role on purpose;
 *
 *   it offers only the counters this account is scoped to.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ClientListUpload } from './ClientListUpload';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const session = { id: 9, username: 'uh.uploader', name: 'Discharge Pharmacist', role: 'staff', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'pharmacy' }];
const BASE = '/api/projects/uh/uh';

const summary = (over = {}) => ({
    serviceDate: '2026-11-03', timezone: 'America/Chicago',
    pharmacies: [{ id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' }],
    byStatus: {}, total: 0, outstanding: 0, delivered: 0, notDelivered: 0, cancelled: 0,
    /* A contract that has agreed to take lists this way. The default on the
       server is the other one, and the last block below is about that. */
    canUploadList: true,
    notes: [], ...over,
});

function renderUpload(over: Record<string, unknown> = {}) {
    const mocked = mockFetch({
        'GET /api/session': session,
        'GET /api/me/projects': projects,
        [`GET ${BASE}/client/summary`]: summary(),
        [`GET ${BASE}/imports`]: [],
        ...over,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/send-list']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/send-list" element={<ClientListUpload />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('the pharmacy upload page', () => {
    it('offers the counters this account covers', async () => {
        renderUpload();
        const picker = await screen.findByLabelText(/Pharmacy/);
        expect(picker).toBeInTheDocument();
        expect(await screen.findByRole('option', { name: 'University Hospital Discharge Pharmacy' }))
            .toBeInTheDocument();
    });

    it('never asks for the full site list', async () => {
        /* THE PROPERTY. GET /sites carries every University Health site's
           address and contact details and is closed to the pharmacy role.
           The component it renders loads that list by default, so this pins
           that the injected list suppresses it rather than merely covering
           it up on screen. */
        const mocked = renderUpload();
        await screen.findByLabelText(/Pharmacy/);
        await waitFor(() => expect(mocked.calls.some((c) => c.includes('/client/summary'))).toBe(true));
        expect(mocked.calls.some((c) => c.endsWith(`${BASE}/sites`))).toBe(false);
    });

    it('says the file is not kept, because that is the first thing a pharmacist asks', async () => {
        renderUpload();
        expect(await screen.findByText(/never stored/i)).toBeInTheDocument();
    });

    it('says nothing is created until they have looked at it', async () => {
        /* The review step is why this is not a one-click upload: a list that
           imports silently and wrongly sends medication to a wrong address. */
        renderUpload();
        expect(await screen.findByText(/Nothing is created until you have seen the rows/i)).toBeInTheDocument();
    });

    it('tells them the clock starts on upload, not on the service date', async () => {
        renderUpload();
        expect(await screen.findByText(/clock on each delivery starts when the list reaches us/i))
            .toBeInTheDocument();
    });

    it('does not offer a submit button to an account with no pharmacies', async () => {
        /* A half-finished settings form leaves exactly this. Offering the
           form would be offering something the server refuses. */
        renderUpload({ [`GET ${BASE}/client/summary`]: summary({ pharmacies: [] }) });
        expect(await screen.findByText(/No pharmacies are assigned to this account yet/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Review the file/i })).toBeNull();
    });

    it('offers the way back to the deliveries list', async () => {
        renderUpload();
        expect(await screen.findByRole('link', { name: /Back to deliveries/i })).toBeInTheDocument();
    });
});

/* A route with no link to it is still a route somebody can type, and this one
   is off for every contract until somebody switches it on. The server refuses
   the upload either way; this is about not showing a form that could not
   work. */
describe('a contract that has not switched it on', () => {
    it('says so instead of offering the form', async () => {
        renderUpload({ [`GET ${BASE}/client/summary`]: summary({ canUploadList: false }) });
        expect(await screen.findByText(/by email rather than through the portal/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/Pharmacy/)).toBeNull();
        expect(screen.queryByRole('button', { name: /Review the file/i })).toBeNull();
    });

    it('treats a server that says nothing as not switched on', async () => {
        /* The safe direction. An older server that does not send the field
           has not had the setting turned on. */
        renderUpload({ [`GET ${BASE}/client/summary`]: summary({ canUploadList: undefined }) });
        expect(await screen.findByText(/by email rather than through the portal/i)).toBeInTheDocument();
    });

    it('still lets them back to their deliveries', async () => {
        renderUpload({ [`GET ${BASE}/client/summary`]: summary({ canUploadList: false }) });
        expect(await screen.findByRole('link', { name: /Back to deliveries/i })).toBeInTheDocument();
    });
});
