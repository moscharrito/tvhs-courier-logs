/* Today's run on a courier's phone.

   The assertion that matters most is the map link: it carries the address
   and never the patient's name, because that URL leaves the application into
   a third party's servers and the phone's own history. */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MyRun, mapsUrl } from './MyRun';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };

const sla = (over = {}) => ({ state: 'open', minutesToDue: 45, onTime: null, measuredAt: null, measuredFrom: null, ...over });

const stop = (over = {}) => ({
    sequence: 1, orderId: 21, externalRef: 'RX-1', serviceType: 'stat',
    recipientName: 'Ines Vargas', address: '1100 Broadway St, Apt 4B',
    city: 'San Antonio', zip: '78215', zone: 1, status: 'assigned',
    dueAt: '2026-09-14T19:00:00.000Z', sla: sla(), ...over,
});

const mine = (over = {}) => ({
    serviceDate: '2026-09-14',
    timezone: 'America/Chicago',
    courierUsername: 'ada.courier',
    runs: [{
        id: 10, courierUsername: 'ada.courier', serviceDate: '2026-09-14',
        label: 'Noon wave', status: 'started', startedAt: null,
        stops: [
            stop(),
            stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra', address: '4502 Medical Dr', zip: '78229', sla: sla({ state: 'due_soon', minutesToDue: 12 }) }),
        ],
    }],
    dispatch: { phone: '(210) 555-0100', name: 'Izy dispatch' },
    ...over,
});

function renderRun(routes: Record<string, unknown>) {
    mockFetch(routes);
    return render(
        <MemoryRouter initialEntries={['/projects/uh/my-run']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/my-run" element={<MyRun />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
}

const base = (over = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/runs/mine': mine(),
    ...over,
});

describe('mapsUrl', () => {
    it('carries the address and never the patient name', () => {
        // The URL leaves this application: it reaches a third party's servers
        // and the phone's own history. The name adds nothing to navigating
        // there and everything to the disclosure.
        const url = mapsUrl({ address: '1100 Broadway St, Apt 4B', city: 'San Antonio', zip: '78215' });
        expect(url).toContain(encodeURIComponent('1100 Broadway St, Apt 4B, San Antonio, 78215'));
        expect(url).not.toMatch(/Ines|Vargas/);
        expect(url.startsWith('https://www.google.com/maps/search/')).toBe(true);
    });

    it('copes with a missing city or ZIP', () => {
        expect(mapsUrl({ address: '1100 Broadway St', city: '', zip: '' })).toContain(encodeURIComponent('1100 Broadway St'));
    });
});

describe('MyRun', () => {
    it('leads with the next stop, not with a list to scroll', async () => {
        renderRun(base());
        expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
        const next = screen.getByLabelText('Next stop');
        expect(within(next).getByText('Next: stop 1')).toBeInTheDocument();
        expect(within(next).getByText('Ines Vargas')).toBeInTheDocument();
        expect(within(next).getByText('45 min left')).toBeInTheDocument();
    });

    it('puts no patient name in any link that leaves the app', async () => {
        renderRun(base());
        await screen.findByRole('heading', { name: 'Today' });
        const external = [...document.querySelectorAll('a[href^="http"]')].map((a) => a.getAttribute('href') ?? '');
        expect(external.length).toBeGreaterThan(0);
        for (const href of external) {
            expect(href).not.toMatch(/Ines|Vargas|Marcus|Ibarra/i);
        }
    });

    it('dials dispatch in one tap', async () => {
        renderRun(base());
        const call = await screen.findByRole('link', { name: /Call Izy dispatch/ });
        // Stripped to digits so the phone dialler accepts it.
        expect(call).toHaveAttribute('href', 'tel:2105550100');
    });

    it('hides the call button rather than offering a number nobody set', async () => {
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': mine({ dispatch: { phone: '', name: 'Dispatch' } }) }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
        expect(screen.getByText(/No dispatch number is set/)).toBeInTheDocument();
        // And says who can fix it, since the courier reading it cannot.
        expect(screen.getByText(/An administrator adds one/)).toBeInTheDocument();
    });

    it('counts progress and moves the next stop along', async () => {
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{
                    ...mine().runs[0],
                    stops: [stop({ status: 'delivered' }), stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra' })],
                }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.getByText(/1 of 2 done/)).toBeInTheDocument();
        const next = screen.getByLabelText('Next stop');
        expect(within(next).getByText('Marcus Ibarra')).toBeInTheDocument();
    });

    it('says there is nothing to do rather than showing an empty page', async () => {
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': mine({ runs: [] }) }));
        expect(await screen.findByText('No stops assigned to you today.')).toBeInTheDocument();
    });

    it('says it cannot reach dispatch, instead of implying there is no work', async () => {
        // A courier in a basement with no signal must not read an empty
        // screen as "you are finished for the day".
        renderRun(base({ 'GET /api/projects/uh/uh/runs/mine': { status: 503, body: { error: 'Service unavailable' } } }));
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByText('No stops assigned to you today.')).not.toBeInTheDocument();
    });

    it('marks completed stops without hiding them', async () => {
        renderRun(base({
            'GET /api/projects/uh/uh/runs/mine': mine({
                runs: [{ ...mine().runs[0], stops: [stop({ status: 'delivered' }), stop({ sequence: 2, orderId: 22, recipientName: 'Marcus Ibarra' })] }],
            }),
        }));
        await screen.findByRole('heading', { name: 'Today' });
        const list = screen.getByRole('list');
        expect(within(list).getByText('delivered')).toBeInTheDocument();
        expect(within(list).getByText('Ines Vargas')).toBeInTheDocument();
    });

    it('offers PIN setup once, and stops offering once the phone is set up', async () => {
        /* Ticket 5.4. Without a prompt nobody discovers the PIN exists, which
           is exactly what happened between tickets 2.3 and 5.4: a complete,
           tested enrolment API that no screen ever mentioned. */
        renderRun(base({ 'GET /api/login/device': { enrolled: false } }));
        expect(await screen.findByText(/a PIN signs you in instead of your password/i)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Set up this phone' })).toBeInTheDocument();
    });

    it('says nothing about PINs on a phone that is already set up', async () => {
        renderRun(base({ 'GET /api/login/device': { enrolled: true, name: 'Mohammed', username: 'mohammed', hasPin: true, label: 'phone' } }));
        await screen.findByRole('heading', { name: 'Today' });
        expect(screen.queryByText(/a PIN signs you in instead/i)).not.toBeInTheDocument();
    });
});
