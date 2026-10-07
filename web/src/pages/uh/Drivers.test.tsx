/* The drivers' record, on screen.
 *
 * This is the first screen in the system somebody is paid from, so what is
 * tested is not that it renders a table. It is that an absent figure renders
 * as absent: the server withholds a total rather than giving a partial one
 * when a rate is unset, and a screen that turned that into $0.00, or into a
 * dash, would undo the whole point of withholding it.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Drivers, money } from './Drivers';
import { DriverRecord } from './DriverRecord';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const admin = { id: 1, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null };
const courier = { id: 5, username: 'pay.ada', name: 'Ada Pay', role: 'driver', route: null };
const asAdmin = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];
const asCourier = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];

const totals = (over = {}) => ({
    delivered: 3, failed: 1, payCents: 1850, rateSet: true,
    byServiceType: { stat: { delivered: 2, rateCents: 700, payCents: 1400 }, adhoc: { delivered: 1, rateCents: 450, payCents: 450 } },
    ...over,
});

const everyone = (over = {}) => ({
    from: '2026-10-01', to: '2026-10-31', timezone: 'America/Chicago', currency: 'USD',
    rateSet: true,
    drivers: [
        { username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...totals() },
        { username: 'pay.bo', name: 'Bo Pay', daysWorked: 0, delivered: 0, failed: 0, payCents: 0, rateSet: true, byServiceType: {} },
    ],
    totals: totals(),
    ...over,
});

const record = (over = {}) => ({
    from: '2026-10-01', to: '2026-10-31', timezone: 'America/Chicago', currency: 'USD',
    username: 'pay.ada', name: 'Ada Pay', grouping: 'day',
    periods: [{
        period: '2026-10-14',
        ...totals(),
        pharmacies: [
            { name: 'University Hospital Discharge Pharmacy', delivered: 2, failed: 1 },
            { name: 'Robert B. Green Pharmacy', delivered: 1, failed: 0 },
        ],
    }],
    totals: totals(),
    ...over,
});

function renderDrivers(over = {}) {
    const mocked = mockFetch({
        'GET /api/session': admin,
        'GET /api/me/projects': asAdmin,
        'GET /api/projects/uh/uh/drivers*': everyone(),
        ...over,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/drivers']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/drivers" element={<Drivers />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

function renderMine(over = {}) {
    const mocked = mockFetch({
        'GET /api/session': courier,
        'GET /api/me/projects': asCourier,
        'GET /api/projects/uh/uh/drivers/me*': record(),
        ...over,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/my-deliveries']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/my-deliveries" element={<DriverRecord mine />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('money', () => {
    it('never renders a missing rate as nought', () => {
        /* THE WHOLE POINT. $0.00 beside 241 deliveries looks like an answer
           and somebody quotes it at a courier. */
        expect(money(null, 'USD')).toBe('rate not set');
        expect(money(null, 'USD')).not.toMatch(/0/);
    });

    it('renders real money as money', () => {
        expect(money(1850, 'USD')).toBe('$18.50');
        expect(money(0, 'USD')).toBe('$0.00');
    });
});

describe('every driver', () => {
    it('lists them with what they delivered and what it comes to', async () => {
        renderDrivers();
        expect(await screen.findByRole('link', { name: 'Ada Pay' })).toBeInTheDocument();
        /* Twice on purpose: once as the contract total at the top and once on
           Ada's row, because this fixture has one driver with any work. */
        expect(screen.getAllByText('$18.50').length).toBeGreaterThanOrEqual(1);
    });

    it('keeps a driver who delivered nothing, so the list matches the roster', async () => {
        /* A payment run that silently omitted somebody is a run nobody can
           check. */
        renderDrivers();
        expect(await screen.findByRole('link', { name: 'Bo Pay' })).toBeInTheDocument();
    });

    it('says once, at the top, that the rates are missing', async () => {
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({
                rateSet: false,
                totals: totals({ payCents: null, rateSet: false }),
                drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...totals({ payCents: null, rateSet: false }) }],
            }),
        });
        const warned = await screen.findByText(/rates are not set/i);
        expect(warned).toHaveTextContent(/counts below are complete/i);
    });

    it('shows no money at all when a rate is missing, not a zero', async () => {
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({
                rateSet: false,
                totals: totals({ payCents: null, rateSet: false }),
                drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...totals({ payCents: null, rateSet: false }) }],
            }),
        });
        await screen.findByRole('link', { name: 'Ada Pay' });
        expect(screen.queryByText('$0.00')).toBeNull();
        expect(screen.getAllByText(/rate not set/i).length).toBeGreaterThan(0);
    });

    it('names no patient, because a pay record is sent to a bookkeeper', async () => {
        renderDrivers();
        await screen.findByRole('link', { name: 'Ada Pay' });
        expect(document.body.textContent).not.toMatch(/patient/i);
    });
});

describe('a courier reading their own', () => {
    it('asks the server for /me rather than for a username', async () => {
        /* The route is the authorization. A page that built the URL from
           anything the reader influences would be one mistake away from a
           courier reading another courier's round. */
        const mocked = renderMine();
        await screen.findByRole('heading', { name: 'Your deliveries' });
        expect(mocked.calls.some((c) => c.includes('/uh/drivers/me'))).toBe(true);
        expect(mocked.calls.some((c) => /\/uh\/drivers\/(?!me)/.test(c))).toBe(false);
    });

    it('shows the pharmacies the work was for', async () => {
        renderMine();
        expect(await screen.findByText('University Hospital Discharge Pharmacy')).toBeInTheDocument();
    });

    it('calls the money earned rather than to disburse', async () => {
        renderMine();
        expect(await screen.findByText('earned')).toBeInTheDocument();
    });

    it('offers no way back to a list of other drivers', async () => {
        renderMine();
        await screen.findByRole('heading', { name: 'Your deliveries' });
        expect(screen.queryByRole('link', { name: /all drivers/i })).toBeNull();
    });
});
