/* The replies screen.
 *
 * WHAT MATTERS HERE is not that it renders a list. It is that the three
 * things which would quietly make it useless are held:
 *
 *   the reply we cannot match to a delivery is still on the page -- it is
 *   the one most likely to need somebody to ring back, and the easiest to
 *   drop because it has no order to hang off;
 *
 *   a pharmacy is told why it sees nothing, rather than shown an empty
 *   list that reads as "no patient has ever replied";
 *
 *   Done is reversible, because it is one click and the alternative is a
 *   patient's message that looks dealt with for ever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PatientReplies } from './PatientReplies';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const BASE = '/api/projects/uh/uh/patient-replies';
const session = { id: 4, username: 'lead.one', name: 'Lead One', role: 'staff', route: null };
const asRole = (role) => [{
    id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role,
}];

const order = (over = {}) => ({
    id: 51, reference: 'RX-912345671', patient: 'Wendell Fairbrass',
    serviceDate: '2026-11-27', status: 'delivered',
    pharmacy: 'University Hospital Discharge Pharmacy', ...over,
});

const reply = (over = {}) => ({
    id: 9, phone: '2105559876', body: 'not home till 6', kind: 'message',
    receivedAt: '2026-11-27T22:10:00.000Z', handled: false, handledAt: null, handledBy: '',
    order: order(), ...over,
});

const routes = (over = {}, role = 'lead') => ({
    'GET /api/session': session,
    'GET /api/me/projects': asRole(role),
    [`GET ${BASE}*`]: { replies: [reply()], outstanding: 1, truncated: false },
    ...over,
});

function open(r = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/patient-replies']}>
            <AuthProvider>
                <Routes>
                    <Route path="/projects/:code/patient-replies" element={<PatientReplies />} />
                </Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

const settled = () => screen.findByRole('heading', { name: 'Patient replies' });

describe('reading what a patient said', () => {
    it('puts their words on the page with the delivery they answer', async () => {
        open();
        await settled();
        /* findBy, not getBy: the role decides whether the fetch happens at
           all, and the role arrives with the membership -- so the list is
           always one tick behind the heading. */
        expect(await screen.findByText('not home till 6')).toBeInTheDocument();
        expect(screen.getByText('Wendell Fairbrass')).toBeInTheDocument();
        expect(screen.getByText('210-555-9876')).toBeInTheDocument();
    });

    it('offers the number as something to ring, because that is what happens next', async () => {
        open();
        await settled();
        expect(await screen.findByRole('link', { name: '210-555-9876' }))
            .toHaveAttribute('href', 'tel:2105559876');
    });

    it('keeps a reply it cannot match, and says why there is no delivery on it', async () => {
        /* THE ONE MOST LIKELY TO BE DROPPED and the one most likely to need
           a person: the number matched nothing we ever sent. */
        open(routes({
            [`GET ${BASE}*`]: {
                replies: [reply({ order: null, body: 'who is this' })],
                outstanding: 1, truncated: false,
            },
        }));
        await settled();
        expect(await screen.findByText('who is this')).toBeInTheDocument();
        expect(screen.getByText(/No delivery matches this number/)).toBeInTheDocument();
    });

    it('marks an opt-out as one, since it is not an ordinary message', async () => {
        open(routes({
            [`GET ${BASE}*`]: {
                replies: [reply({ kind: 'stop', body: 'STOP' })], outstanding: 1, truncated: false,
            },
        }));
        await settled();
        expect(await screen.findByText('opted out')).toBeInTheDocument();
    });

    it('says how many are waiting, and says so plainly when none are', async () => {
        open(routes({
            [`GET ${BASE}*`]: { replies: [], outstanding: 0, truncated: false },
        }));
        await settled();
        expect(await screen.findByText(/Nothing is waiting/)).toBeInTheDocument();
    });
});

describe('dealing with one', () => {
    it('marks it done and reloads', async () => {
        const { bodies, calls } = open();
        await settled();
        fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
        await waitFor(() => {
            expect(calls.some((c) => c.includes(`${BASE}/9/handled`))).toBe(true);
        });
        expect(bodies[`POST ${BASE}/9/handled`]).toEqual({ handled: true });
    });

    it('can undo it, and the button says so rather than vanishing', async () => {
        const { bodies } = open(routes({
            [`GET ${BASE}*`]: {
                replies: [reply({ handled: true, handledBy: 'lead.one', handledAt: '2026-11-27T22:30:00.000Z' })],
                outstanding: 0, truncated: false,
            },
        }));
        await settled();
        const button = await screen.findByRole('button', { name: 'Not done after all' });
        fireEvent.click(button);
        await waitFor(() => {
            expect(bodies[`POST ${BASE}/9/handled`]).toEqual({ handled: false });
        });
    });

    it('names who dealt with it, so two dispatchers do not both ring back', async () => {
        open(routes({
            [`GET ${BASE}*`]: {
                replies: [reply({ handled: true, handledBy: 'lead.one', handledAt: '2026-11-27T22:30:00.000Z' })],
                outstanding: 0, truncated: false,
            },
        }));
        await settled();
        expect(await screen.findByText(/Done by lead\.one/)).toBeInTheDocument();
    });
});

describe('which ones are shown', () => {
    it('asks for the outstanding ones and not everything', async () => {
        const { calls } = open();
        await settled();
        expect(calls.some((c) => c === `GET ${BASE}`)).toBe(true);
        expect(calls.some((c) => c.includes('all=1'))).toBe(false);
    });

    it('widens to the handled ones on request', async () => {
        const { calls } = open();
        await settled();
        fireEvent.click(await screen.findByRole('button', { name: 'Show the handled ones too' }));
        await waitFor(() => {
            expect(calls.some((c) => c.includes('all=1'))).toBe(true);
        });
    });
});

describe('who is allowed to look', () => {
    it('tells a pharmacy why it sees nothing, rather than showing an empty list', async () => {
        /* AN EMPTY LIST WOULD BE A LIE. It reads as "no patient has ever
           replied", which is the opposite of what is true, and a counter
           would stop asking. */
        open(routes({}, 'pharmacy'));
        await settled();
        expect(screen.getByText(/Only dispatch reads these/)).toBeInTheDocument();
        expect(screen.queryByText('not home till 6')).toBeNull();
    });

    it('does not even ask the server when the account may not read them', async () => {
        const { calls } = open(routes({}, 'pharmacy'));
        await settled();
        expect(calls.some((c) => c.includes('/patient-replies'))).toBe(false);
    });
});
