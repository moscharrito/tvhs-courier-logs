/* The drivers' record, on screen.
 *
 * This is the first screen in the system somebody is paid from, so what is
 * tested is not that it renders a table. It is that an absent figure renders
 * as absent: the server withholds a total rather than giving a partial one
 * when a rate is unset, and a screen that turned that into $0.00, or into a
 * dash, would undo the whole point of withholding it.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Drivers, money } from './Drivers';
import { DriverRecord } from './DriverRecord';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';

const admin = { id: 1, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null };
const courier = { id: 5, username: 'pay.ada', name: 'Ada Pay', role: 'driver', route: null };
const asAdmin = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];
const asCourier = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];
const asLead = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'lead' }];

const totals = (over = {}) => ({
    delivered: 3, failed: 1, payCents: 1850, rateSet: true,
    basis: 'serviceType',
    lines: {
        stat: { label: 'stat', delivered: 2, rateCents: 700, payCents: 1400 },
        adhoc: { label: 'adhoc', delivered: 1, rateCents: 450, payCents: 450 },
    },
    ...over,
});

/* WHAT AN UNSET RATE ACTUALLY LOOKS LIKE ON THE WIRE.
 *
 * The line is present and priced at nought -- driver-pay.ts builds a line
 * for every service level or zone that was worked and then refuses to turn
 * a zero rate into a zero payment. `rateSet: false` beside a fully priced
 * breakdown cannot happen, and fixtures that said it did let the banner
 * assert against a state the server never sends. */
const unpriced = (over = {}) => totals({
    payCents: null,
    rateSet: false,
    lines: {
        stat: { label: 'stat', delivered: 2, failed: 0, rateCents: 700, payCents: 1400 },
        adhoc: { label: 'adhoc', delivered: 1, failed: 1, rateCents: 0, payCents: null },
    },
    ...over,
});

/* Paid by zone, with stops that landed outside the zone map. There is no
   rate for those and none that can be set. */
const unzoned = (over = {}) => totals({
    payCents: null,
    rateSet: false,
    basis: 'zone',
    lines: {
        'zone-1': { label: 'Zone 1', delivered: 9, failed: 0, rateCents: 650, payCents: 5850 },
        unzoned: { label: 'No zone', delivered: 3, failed: 1, rateCents: 0, payCents: null },
    },
    ...over,
});

const everyone = (over = {}) => ({
    from: '2026-10-01', to: '2026-10-31', timezone: 'America/Chicago', currency: 'USD',
    rateSet: true,
    /* Null is the whole contract, which is what the screen must open on.
       A fixture that left this out would let the banner tests pass against
       `undefined` and prove nothing. */
    siteId: null,
    drivers: [
        { username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...totals() },
        { username: 'pay.bo', name: 'Bo Pay', daysWorked: 0, delivered: 0, failed: 0, payCents: 0, rateSet: true, basis: 'serviceType', lines: {} },
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
        'GET /api/projects/uh/uh/sites': [
            { id: 6, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
            { id: 7, code: 'green', name: 'University Health Robert B. Green Pharmacy' },
        ],
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
                totals: unpriced(),
                drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...unpriced() }],
            }),
        });
        const warned = await screen.findByText(/rate is not set/i);
        expect(warned).toHaveTextContent(/delivery counts are complete/i);
    });

    it('shows no money at all when a rate is missing, not a zero', async () => {
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({
                rateSet: false,
                totals: unpriced(),
                drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...unpriced() }],
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

/* THE SITE MANAGER'S VIEW (ticket 7.20).
 *
 * One site manager replaced eight per-counter leads. They dispatch, handle
 * what comes back and talk to drivers on site, so they read this page -- but
 * what a driver is paid is commercial and is not theirs.
 *
 * The server strips the pay fields; this screen reads the DATA rather than
 * the role, because a component that re-decides who may see money is a
 * second copy of the rule and the copy that drifts is the one that shows it.
 */
/* THE PHARMACY WARNING, ASKED FOR BY ITS WORDS.
 *
 * `getByRole('status')` is not specific enough here: this screen has a
 * SECOND status banner, the one that appears when a per-delivery rate is
 * unset. Every fixture below sets `rateSet: true`, so a role query happens
 * to find the right element today -- and would quietly start asserting
 * about the rate notice the moment somebody wrote a `rateSet: false`
 * fixture. Confirmed on the live site, where both can be on screen at
 * once. Asking for the sentence that only this banner contains cannot
 * drift that way. */
const pharmacyWarning = () => screen.queryByText(/across every pharmacy/);

describe('narrowed to one pharmacy', () => {
    /* The filter is useful -- a site manager wants to know who carried their
       counter -- and it is the easiest way to make the one screen somebody is
       paid from show a confident wrong number. Pay here is per delivery, so
       one pharmacy's figure is REAL, CORRECT, and not what anybody is owed.

       So every test below is about the number being impossible to mistake for
       a payment run, and the filter being asked of the server rather than
       applied to rows already fetched. */

    it('opens on the whole contract', async () => {
        const mocked = renderDrivers();
        await screen.findByRole('heading', { name: 'Drivers' });
        expect((screen.getByLabelText('Pharmacy') as HTMLSelectElement).value).toBe('');
        expect(mocked.calls.some((c) => c.includes('/uh/drivers?') && c.includes('siteId='))).toBe(false);
        expect(pharmacyWarning()).not.toBeInTheDocument();
    });

    it('asks the server for the one pharmacy', async () => {
        const mocked = renderDrivers();
        await screen.findByRole('heading', { name: 'Drivers' });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        await waitFor(() => {
            expect(mocked.calls.some((c) => c.includes('/uh/drivers?') && c.includes('siteId=7'))).toBe(true);
        });
    });

    it('says in as many words that a filtered total is not a payment run', async () => {
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({ siteId: 7 }),
        });
        await screen.findByRole('heading', { name: 'Drivers' });
        const banner = (await screen.findByText(/across every pharmacy/)).closest('.izy-alert') as HTMLElement;
        expect(banner).toHaveTextContent(/Robert B\. Green Pharmacy only/);
        expect(banner).toHaveTextContent(/pay figures/);
    });

    it('stops calling the figure a disbursement while it is a slice', async () => {
        /* The tile is what gets read when the banner above it does not.
           "To disburse" under one counter is a sentence that is false. */
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({ siteId: 7 }),
        });
        await screen.findByRole('heading', { name: 'Drivers' });
        expect(screen.getByText('for this pharmacy')).toBeInTheDocument();
        expect(screen.queryByText('to disburse')).not.toBeInTheDocument();
    });

    it('calls it a disbursement again once the filter is off', async () => {
        renderDrivers();
        await screen.findByRole('heading', { name: 'Drivers' });
        expect(screen.getByText('to disburse')).toBeInTheDocument();
        expect(screen.queryByText('for this pharmacy')).not.toBeInTheDocument();
    });

    it('takes the warning from the server answer, not from the URL', async () => {
        /* If the banner were driven by the select, a request that failed or
           came back unfiltered would still be captioned as one pharmacy --
           or worse, filtered numbers would render with no caption at all. */
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({ siteId: null }),
        });
        await screen.findByRole('heading', { name: 'Drivers' });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        await waitFor(() => {
            expect(pharmacyWarning()).not.toBeInTheDocument();
        });
        expect(screen.getByText('to disburse')).toBeInTheDocument();
    });

    it('does not caption a full payment run as one pharmacy when the field is missing', async () => {
        /* FOUND IN A BROWSER, NOT HERE, which is why it is here now.
           The check was `siteId !== null`, and a server that predates this
           filter sends no siteId at all -- so `undefined` passed it and the
           page captioned a complete, correct payment run as a slice and
           renamed the disbursement total. Every fixture above sets the
           field, so every fixture agreed with itself and none of them could
           see it. This one deletes it, the way a deploy mid-rollout does. */
        const { siteId: _omitted, ...withoutTheField } = everyone();
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': withoutTheField,
        });
        await screen.findByRole('heading', { name: 'Drivers' });
        expect(pharmacyWarning()).not.toBeInTheDocument();
        expect(screen.getByText('to disburse')).toBeInTheDocument();
        expect(screen.queryByText(/pharmacy undefined/)).not.toBeInTheDocument();
    });

    it('treats a nought or a junk pharmacy as the whole contract', async () => {
        /* The safe direction to be wrong in: show the real payment run with
           no caption, never hide a caption that was needed. */
        for (const odd of [0, -2, 'green']) {
            const { unmount } = render(<div />);
            unmount();
            renderDrivers({
                'GET /api/projects/uh/uh/drivers*': everyone({ siteId: odd }),
            });
            expect(await screen.findByText('to disburse')).toBeInTheDocument();
            screen.getAllByRole('heading', { name: 'Drivers' });
            cleanup();
        }
    });

    it('is not confused with the unset-rate notice when both are on screen', async () => {
        /* Both banners together is a real state -- it was on the live site
           while this was being checked: a pharmacy filter on, and a driver
           whose service level has no rate. The pharmacy warning has to be
           the one that follows the filter, and the rate notice has to stay
           put regardless. */
        renderDrivers({
            'GET /api/projects/uh/uh/drivers*': everyone({
                siteId: 7,
                rateSet: false,
                totals: unpriced(),
            }),
        });
        await screen.findByRole('heading', { name: 'Drivers' });
        expect(screen.getByText(/No pay is shown because the per-delivery rate/)).toBeInTheDocument();
        expect(pharmacyWarning()).toBeInTheDocument();
        expect(screen.getByText('for this pharmacy')).toBeInTheDocument();
        expect(screen.getByText('rate not set')).toBeInTheDocument();
    });

    it('sends the workbook the same pharmacy the screen is showing', async () => {
        renderDrivers();
        await screen.findByRole('heading', { name: 'Drivers' });
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        await waitFor(() => {
            const href = screen.getByRole('link', { name: 'Export to Excel' }).getAttribute('href');
            expect(href).toContain('siteId=7');
        });
    });
});

describe('the drivers record without the money', () => {
    const noMoney = {
        from: '2026-11-02', to: '2026-11-02', timezone: 'America/Chicago',
        drivers: [{
            username: 'pay.ada', name: 'Ada Pay', daysWorked: 1,
            delivered: 3, failed: 2, rateSet: true, basis: 'serviceType', lines: {},
        }],
        totals: { delivered: 3, failed: 2, rateSet: true, basis: 'serviceType', lines: {} },
    };

    it('shows who delivered what', async () => {
        renderDrivers({ 'GET /api/projects/uh/uh/drivers*': noMoney });
        expect(await screen.findByText('Ada Pay')).toBeInTheDocument();
        /* Scoped to the row: "3" is also the delivered total in the summary
           above, and an unscoped match finds both. */
        const row = screen.getByText('Ada Pay').closest('tr')!;
        /* Delivered, scoped to the row: the same figure is in the summary
           above, so an unscoped match finds both. */
        expect(within(row).getByText('3')).toBeInTheDocument();
    });

    it('has no Pay column and no figure to disburse', async () => {
        renderDrivers({ 'GET /api/projects/uh/uh/drivers*': noMoney });
        await screen.findByText('Ada Pay');
        expect(screen.queryByRole('columnheader', { name: 'Pay' })).not.toBeInTheDocument();
        expect(screen.queryByText('to disburse')).not.toBeInTheDocument();
        /* And nothing that looks like money got rendered anyway. */
        expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    });
});

describe('who may open it at all', () => {
    /* The project page offers a site manager the Drivers record link. This
       guard read `role !== 'admin'`, so following that link landed them on
       "Not available" -- and it read that way because
       ProjectMembership['role'] did not contain 'lead', so `=== 'lead'`
       would not compile. The server has admitted leads since ticket 7.20,
       with the money stripped on the way out. Found by signing in as the
       site manager and clicking every link on the page. */
    it('lets a site manager in, because the server does', async () => {
        renderDrivers({
            'GET /api/me/projects': asLead,
            'GET /api/projects/uh/uh/drivers*': {
                from: '2026-11-02', to: '2026-11-02', timezone: 'America/Chicago',
                drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 1, delivered: 3, failed: 0, rateSet: true, basis: 'serviceType', lines: {} }],
                totals: { delivered: 3, failed: 0, rateSet: true, basis: 'serviceType', lines: {} },
            },
        });
        expect(await screen.findByText('Ada Pay')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Not available' })).not.toBeInTheDocument();
    });

    it('still shows a site manager no money', async () => {
        /* Opening the door must not open the till. The server decides by
           omitting the fields; this asserts the screen renders what it was
           sent and invents nothing. */
        renderDrivers({
            'GET /api/me/projects': asLead,
            'GET /api/projects/uh/uh/drivers*': {
                from: '2026-11-02', to: '2026-11-02', timezone: 'America/Chicago',
                drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 1, delivered: 3, failed: 0, rateSet: true, basis: 'serviceType', lines: {} }],
                totals: { delivered: 3, failed: 0, rateSet: true, basis: 'serviceType', lines: {} },
            },
        });
        await screen.findByText('Ada Pay');
        expect(screen.queryByRole('columnheader', { name: 'Pay' })).not.toBeInTheDocument();
        expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    });

    it('keeps a pharmacy account out', async () => {
        renderDrivers({
            'GET /api/me/projects': [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'pharmacy' }],
        });
        expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
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

/* ────────────────────────────────────── why no pay is shown
 *
 * The banner said "service level" whatever the project paid on, and covered
 * two problems with one sentence: a rate still at zero, which somebody fixes
 * on the settings screen, and a stop outside the zone map, for which no rate
 * exists and none can be set. The second sent people hunting for a field
 * that is not there.
 */
describe('the rate notice', () => {
    const show = (t: Record<string, unknown>) => renderDrivers({
        'GET /api/projects/uh/uh/drivers*': everyone({
            rateSet: false, totals: t,
            drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...t }],
        }),
    });

    it('names the service levels that have no rate, not just that one does not', async () => {
        show(unpriced());
        const warned = await screen.findByText(/No pay is shown because the per-delivery rate/);
        expect(warned).toHaveTextContent('service level');
        // The one that is actually missing, so nobody checks all three.
        expect(warned).toHaveTextContent('adhoc');
        expect(warned).not.toHaveTextContent('zone');
    });

    it('says zone, not service level, when the project pays by zone', async () => {
        /* driver-pay.ts: a reader must never be shown a column headed
           "service level" with zones in it. This banner was doing exactly
           that, and it sends somebody to the wrong half of the rate card. */
        show(unzoned({
            lines: {
                'zone-1': { label: 'Zone 1', delivered: 9, failed: 0, rateCents: 650, payCents: 5850 },
                'zone-3': { label: 'Zone 3', delivered: 2, failed: 0, rateCents: 0, payCents: null },
            },
        }));
        const warned = await screen.findByText(/No pay is shown because the per-delivery rate/);
        expect(warned).toHaveTextContent('every zone worked');
        expect(warned).toHaveTextContent('Zone 3');
        expect(warned).not.toHaveTextContent('service level');
    });

    it('says a stop off the zone map has no rate that anybody can set', async () => {
        show(unzoned());
        /* Four stops: three delivered and one attempted, both paid alike
           since 5 November. */
        const warned = await screen.findByText(/4 deliveries went to a ZIP/);
        expect(warned).toHaveTextContent('no rate for that, nor one that can be set');
        expect(warned).toHaveTextContent('zones 1 to 5');
        // The actionable half: the gap is in the zone list, not the card.
        expect(warned).toHaveTextContent(/add the ZIP to the zone list/i);
    });

    it('says the rate card is fine when the only problem is the zone map', async () => {
        /* The confusing state: every rate set, and still no pay. Somebody
           reading "a rate is not set" here searches the settings screen for
           a field that does not exist. */
        show(unzoned());
        const warned = await screen.findByText(/went to a ZIP/);
        expect(warned).toHaveTextContent('Every rate on the rate card is set');
        expect(screen.queryByText(/No pay is shown because the per-delivery rate/)).toBeNull();
    });

    it('reads as one delivery rather than 1 deliveries', async () => {
        show(unzoned({
            lines: { unzoned: { label: 'No zone', delivered: 1, failed: 0, rateCents: 0, payCents: null } },
        }));
        expect(await screen.findByText(/One delivery went to a ZIP/)).toBeInTheDocument();
    });

    it('says both things when both are true', async () => {
        show(unzoned({
            lines: {
                'zone-3': { label: 'Zone 3', delivered: 2, failed: 0, rateCents: 0, payCents: null },
                unzoned: { label: 'No zone', delivered: 3, failed: 1, rateCents: 0, payCents: null },
            },
        }));
        const missing = await screen.findByText(/No pay is shown because the per-delivery rate/);
        expect(missing).toHaveTextContent('Zone 3');
        expect(screen.getByText(/4 deliveries went to a ZIP/)).toBeInTheDocument();
        /* Not claimed, because it is not true here. */
        expect(document.body.textContent).not.toMatch(/Every rate on the rate card is set/);
    });

    it('stays silent when every rate that was worked is set', async () => {
        renderDrivers();
        await screen.findByRole('link', { name: 'Ada Pay' });
        expect(screen.queryByText(/No pay is shown/)).toBeNull();
        expect(screen.queryByText(/went to a ZIP/)).toBeNull();
    });

    it('tells a site manager nothing about rates, because pay is merely hidden', async () => {
        /* The server strips the money fields for a lead, rateSet included.
           The old banner read `!data.rateSet`, and `!undefined` is true, so
           a site manager was told the rates were unset when in fact they
           were none of their business. Driven by the lines now, which are
           stripped with everything else. */
        renderDrivers({
            'GET /api/me/projects': asLead,
            'GET /api/projects/uh/uh/drivers*': (() => {
                const e = everyone() as Record<string, unknown>;
                delete e['currency']; delete e['rateSet'];
                e['totals'] = { delivered: 3, failed: 1, basis: 'serviceType' };
                e['drivers'] = [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, delivered: 3, failed: 1, basis: 'serviceType' }];
                return e;
            })(),
        });
        await screen.findByRole('link', { name: 'Ada Pay' });
        expect(screen.queryByText(/No pay is shown/)).toBeNull();
        expect(screen.queryByText(/rate is not set/)).toBeNull();
    });
});

/* ───────────────────────── a priced out-of-zone line is just pay
 *
 * outOfZoneCents gives a stop with no zone a rate. Nothing is withheld
 * after that, so there is nothing to announce: the figure is correct and
 * the breakdown carries its own "No zone" line, which is where somebody
 * checking a payment run looks. What these pin is the arithmetic and the
 * absence of a banner on a correct number.
 */
describe('a paid out-of-zone line', () => {
    const paidOutOfZone = (over = {}) => totals({
        payCents: 11450, rateSet: true, basis: 'zone',
        lines: {
            'zone-1': { label: 'Zone 1', delivered: 9, failed: 0, rateCents: 650, payCents: 5850 },
            unzoned: { label: 'No zone', delivered: 2, failed: 0, rateCents: 2800, payCents: 5600 },
        },
        ...over,
    });

    const show = (t: Record<string, unknown>) => renderDrivers({
        'GET /api/projects/uh/uh/drivers*': everyone({
            totals: t,
            drivers: [{ username: 'pay.ada', name: 'Ada Pay', daysWorked: 12, ...t }],
        }),
    });

    it('pays it and says nothing about it', async () => {
        show(paidOutOfZone());
        await screen.findByRole('link', { name: 'Ada Pay' });
        /* 9 x $6.50 plus 2 x $28.00. The total is the thing to check. */
        expect(screen.getAllByText('$114.50').length).toBeGreaterThan(0);
        expect(screen.queryByText(/No pay is shown/)).toBeNull();
        expect(screen.queryByText(/on no zone/)).toBeNull();
    });

    it('still warns when the rate is set and another band is not', async () => {
        /* A priced out-of-zone line must not silence a real withholding. */
        show(paidOutOfZone({
            payCents: null, rateSet: false,
            lines: {
                'zone-3': { label: 'Zone 3', delivered: 1, failed: 0, rateCents: 0, payCents: null },
                unzoned: { label: 'No zone', delivered: 2, failed: 0, rateCents: 2800, payCents: 5600 },
            },
        }));
        const warned = await screen.findByText(/No pay is shown because the per-delivery rate/);
        expect(warned).toHaveTextContent('Zone 3');
        expect(warned).not.toHaveTextContent('No zone');
    });
});
