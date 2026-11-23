/* The dialog that splits one counter's list between the drivers standing
   at it.

   IT HAD NO TESTS until 21 November, which is how it shipped showing all
   thirty-five drivers on the contract when dispatch wanted the eleven at
   the counter. These are about WHO IT OFFERS and what it says when it can
   offer nobody -- an empty box with no sentence under it reads as a broken
   screen, and the two reasons it can be empty have different answers. */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ClusterDialog } from './ClusterDialog';
import { mockFetch } from '../../test/setup';

const site = { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' };
const DAY = '2026-11-21';

const driver = (username: string, name: string) => ({
    username, name, homeSiteId: 7, onShift: true,
});

/** The roster read is the call with no `couriers`; the cluster has one. */
function stub(roster: Record<string, unknown>) {
    return mockFetch({
        'GET /api/projects/uh/uh/runs/split*': (url: string) => (
            url.includes('couriers=')
                ? { serviceDate: DAY, site, rounds: [], urgent: [], notes: [] }
                : { serviceDate: DAY, site, rounds: [], urgent: [], notes: [], ...roster }
        ),
    });
}

const open = () => render(
    <ClusterDialog
        projectCode="uh"
        site={site}
        serviceDate={DAY}
        onClose={() => {}}
        onDone={() => {}}
    />,
);

const boxes = () => within(screen.getByRole('dialog'))
    .getAllByRole('checkbox') as HTMLInputElement[];

describe('who it offers', () => {
    it('lists the drivers the server sent and nobody else, every one of them ticked', async () => {
        /* TICKED, ALL OF THEM. Everybody on this list is mapped here and on
           shift, so the usual morning is "all of them" and the dispatcher
           unticks the exceptions. It used to tick only the on-shift ones
           out of a list that also held people who were not. */
        stub({
            drivers: [driver('ana', 'Ana Driver'), driver('ben', 'Ben Driver')],
            unmapped: false,
            restingHere: 0,
        });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.getByText('Ben Driver')).toBeInTheDocument();
        expect(boxes()).toHaveLength(2);
        expect(boxes().every((b) => b.checked)).toBe(true);
        expect(screen.getByRole('button', { name: /Cluster between 2 drivers/ })).toBeInTheDocument();
    });

    it('does not say "on shift" against each name, because they all are', async () => {
        /* The pill was load-bearing when the list held both kinds. Now it
           is the same word thirty times down a column saying nothing. */
        stub({ drivers: [driver('ana', 'Ana Driver')], unmapped: false, restingHere: 0 });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.queryByText('Not on shift')).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /On shift at University Hospital Discharge/ }))
            .toBeInTheDocument();
    });

    it('counts the ones who are mapped here but resting, without listing them', async () => {
        stub({ drivers: [driver('ana', 'Ana Driver')], unmapped: false, restingHere: 4 });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.getByText(/4 more drivers are mapped/)).toBeInTheDocument();
        expect(boxes()).toHaveLength(1);
    });

    it('admits it when the drivers shown are mapped to no pharmacy at all', async () => {
        /* UH's thirty-five drivers were loaded with no home pharmacy. A
           strict reading opens an empty dialog every morning, so the
           unplaced drivers on shift are offered and the screen says what
           they are rather than implying they belong to this counter. */
        stub({
            drivers: [driver('ana', 'Ana Driver'), driver('ben', 'Ben Driver')],
            unmapped: true,
            restingHere: 0,
        });
        open();

        await screen.findByText('Ana Driver');
        await screen.findByText(/None of these drivers has a home pharmacy set/);
    });
});

describe('when it can offer nobody', () => {
    it('says they are resting when this counter has drivers who have not started', async () => {
        stub({ drivers: [], unmapped: false, restingHere: 6 });
        open();

        /* findByText, not findByRole('status'): the three-dot loader is
           also a status and it has no text, so a role query resolves on
           the spinner and passes on an empty string. */
        const said = await screen.findByText(/Nobody mapped to .* has started a shift yet/);
        expect(said).toHaveTextContent(/6 drivers are mapped here and resting/);
    });

    it('says nobody is mapped here at all when nobody is', async () => {
        /* A different problem with a different fix: this one is "go and set
           the home pharmacies", not "wait for somebody to clock on". */
        stub({ drivers: [], unmapped: false, restingHere: 0 });
        open();

        await screen.findByText(/No driver is mapped to .* and on shift/);
    });

    it('will not let anybody press Cluster with nobody ticked', async () => {
        stub({ drivers: [], unmapped: false, restingHere: 0 });
        open();

        await screen.findByText(/No driver is mapped to/);
        expect(screen.getByRole('button', { name: /^Cluster between/ })).toBeDisabled();
    });
});

describe('what it asks the server', () => {
    it('clusters between exactly the names still ticked', async () => {
        /* Unticking is the dispatcher's judgement -- one driver is slow
           today, one is already out on a STAT. The request has to carry
           that, and not the roster it started from. */
        const { calls } = stub({
            drivers: [driver('ana', 'Ana Driver'), driver('ben', 'Ben Driver')],
            unmapped: false,
            restingHere: 0,
        });
        open();

        await screen.findByText('Ben Driver');
        const ben = screen.getByText('Ben Driver').closest('label')!;
        fireEvent.click(within(ben).getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between 1 driver/ }));

        await vi.waitFor(() => {
            expect(calls.some((c) => c.includes('couriers=ana') && !c.includes('ben'))).toBe(true);
        });
    });
});

/* ─────────────────── which rounds are in driving order (21 November)
 *
 * Nearest-neighbour refuses rather than degrades: one stop without
 * coordinates sends its whole round back to deadline order. So two rounds
 * from the same split can differ, and the screen has to say so per round. A
 * banner at the top claiming "driving order" while one driver gets a zig-zag
 * is how a dispatcher stops believing the number.
 */
describe('the order each round is driven in', () => {
    const round = (over: Record<string, unknown> = {}) => ({
        orderIds: [1, 2, 3],
        stops: 3,
        ordering: 'nearest',
        driveMiles: 12.4,
        zips: ['78207'],
        siteIds: [7],
        earliestDueAt: null,
        spreadMiles: 2.1,
        stretched: false,
        courier: { username: 'ana', name: 'Ana Driver', why: 'home' },
        ...over,
    });

    const clusterInto = (rounds: unknown[]) => mockFetch({
        'GET /api/projects/uh/uh/runs/split*': (url: string) => (
            url.includes('couriers=')
                ? { serviceDate: DAY, site, rounds, urgent: [], notes: [] }
                : {
                    serviceDate: DAY,
                    site,
                    rounds: [],
                    urgent: [],
                    notes: [],
                    drivers: [driver('ana', 'Ana Driver'), driver('ben', 'Ben Driver')],
                    unmapped: false,
                    restingHere: 0,
                }
        ),
    });

    const clusterNow = async () => {
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));
    };

    it('shows the miles on a round that is in driving order', async () => {
        clusterInto([round()]);
        await clusterNow();

        await screen.findByText('Driving');
        expect(screen.getByText(/12\.4 mi/)).toBeInTheDocument();
    });

    it('says so plainly on a round that fell back to deadline order', async () => {
        clusterInto([round({ ordering: 'due', driveMiles: null })]);
        await clusterNow();

        await screen.findByText('By deadline');
        expect(screen.queryByText('Driving')).not.toBeInTheDocument();
    });

    it('labels each round on its own, because they can differ', async () => {
        clusterInto([
            round({ courier: { username: 'ana', name: 'Ana Driver', why: 'home' } }),
            round({
                ordering: 'due',
                driveMiles: null,
                courier: { username: 'ben', name: 'Ben Driver', why: 'home' },
            }),
        ]);
        await clusterNow();

        const ana = (await screen.findByText('Ana Driver', { selector: 'td' })).closest('tr')!;
        const ben = screen.getByText('Ben Driver', { selector: 'td' }).closest('tr')!;
        expect(within(ana).getByText('Driving')).toBeInTheDocument();
        expect(within(ben).getByText('By deadline')).toBeInTheDocument();
    });
});

/* ──────────────────── the spreadsheet each driver gets (21 November)
 *
 * The link used to point at /runs/export.xlsx -- the runs REGISTER --
 * filtered to that courier and that day. The right filter on the wrong
 * file: it downloaded, it was called runs-<date>.xlsx whoever it was for,
 * and it held run metadata with a COUNT of stops rather than the stops. It
 * now points at the run's own manifest, which means it cannot be offered
 * until the run exists.
 */
describe('the spreadsheet each driver gets', () => {
    const round = (over: Record<string, unknown> = {}) => ({
        orderIds: [1, 2, 3],
        stops: 3,
        ordering: 'nearest',
        driveMiles: 12.4,
        zips: ['78207'],
        siteIds: [7],
        earliestDueAt: null,
        spreadMiles: 2.1,
        stretched: false,
        courier: { username: 'ana', name: 'Ana Driver', why: 'home' },
        ...over,
    });

    const ready = (runs: Array<{ id: number; courierUsername: string }>) => mockFetch({
        'GET /api/projects/uh/uh/runs/split*': (url: string) => (
            url.includes('couriers=')
                ? { serviceDate: DAY, site, rounds: [round()], urgent: [], notes: [] }
                : {
                    serviceDate: DAY,
                    site,
                    rounds: [],
                    urgent: [],
                    notes: [],
                    drivers: [driver('ana', 'Ana Driver')],
                    unmapped: false,
                    restingHere: 0,
                }
        ),
        'POST /api/projects/uh/uh/runs/split/apply': { runs, rejected: [] },
    });

    const clusterThenAssign = async () => {
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));
        await screen.findByText('Driving');
        fireEvent.click(screen.getByRole('button', { name: /^Assign/ }));
    };

    it('links to that run\u2019s own manifest once the run exists', async () => {
        ready([{ id: 41, courierUsername: 'ana' }]);
        await clusterThenAssign();

        const link = await screen.findByRole('link', { name: /Excel/ });
        expect(link).toHaveAttribute('href', '/api/projects/uh/uh/runs/41/manifest.xlsx');
    });

    it('offers nothing to download before Assign', async () => {
        /* No run, no manifest. An Excel link that 404s is worse than no
           link, because the dispatcher has to open the file to find out. */
        ready([{ id: 41, courierUsername: 'ana' }]);
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));

        await screen.findByText('Driving');
        expect(screen.queryByRole('link', { name: /Excel/ })).not.toBeInTheDocument();
    });

    it('offers nothing for a driver the server did not come back with', async () => {
        /* A round can be rejected on apply -- an order moved underneath it.
           Keying the link on what the server created rather than on what is
           drawn means a driver with no run gets no link rather than a link
           to somebody else\u2019s. */
        ready([{ id: 41, courierUsername: 'someone.else' }]);
        await clusterThenAssign();

        await screen.findByText('Assigned');
        expect(screen.queryByRole('link', { name: /Excel/ })).not.toBeInTheDocument();
    });
});

/* ───────────── it does not repeat its own table back (21 November)
 *
 * The server sends five or six sentences with every split and they used to
 * stack above the table as yellow banners. Read against the rows beneath
 * them, each one restates a column: the stop range is the Stops column,
 * the 10-mile warning is Width and its Wide pill, "a driver from another
 * pharmacy" is the Another counter pill, "in deadline order" is Order, and
 * the STAT sentence is printed again word for word in the alert below the
 * table. Six banners saying what the next six rows show is a wall, and a
 * wall gets scrolled past on the morning one of them matters.
 *
 * Pinned, because `notes` is still on the response and putting a .map back
 * is a one-line change that looks like an improvement.
 */
describe('what it does with the server\u2019s notes', () => {
    it('draws none of them, however many come back', async () => {
        mockFetch({
            'GET /api/projects/uh/uh/runs/split*': (url: string) => (
                url.includes('couriers=')
                    ? {
                        serviceDate: DAY,
                        site,
                        rounds: [{
                            orderIds: [1], stops: 1, ordering: 'nearest', driveMiles: 3.1,
                            zips: ['78207'], siteIds: [7], earliestDueAt: null,
                            spreadMiles: 1.1, stretched: false,
                            courier: { username: 'ana', name: 'Ana Driver', why: 'home' },
                        }],
                        urgent: [],
                        notes: [
                            'Rounds run from 8 to 19 stops.',
                            '1 round is wider than the 10-mile limit.',
                            '1 run is offered to a driver from another pharmacy.',
                        ],
                    }
                    : {
                        serviceDate: DAY,
                        site,
                        rounds: [],
                        urgent: [],
                        notes: [],
                        drivers: [driver('ana', 'Ana Driver')],
                        unmapped: false,
                        restingHere: 0,
                    }
            ),
        });
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));

        await screen.findByText('Driving');
        expect(screen.queryByText(/Rounds run from 8 to 19 stops/)).not.toBeInTheDocument();
        expect(screen.queryByText(/wider than the 10-mile limit/)).not.toBeInTheDocument();
        expect(screen.queryByText(/from another pharmacy/)).not.toBeInTheDocument();
    });

    it('still says the one thing the table cannot: the STATs held back', async () => {
        /* NOT a note. The STATs are not rows in this table at all, so
           nothing below says they exist, and a dispatcher who closes the
           dialog believing the day is covered has four deliveries with an
           hour on them that nobody is carrying. */
        mockFetch({
            'GET /api/projects/uh/uh/runs/split*': (url: string) => (
                url.includes('couriers=')
                    ? {
                        serviceDate: DAY,
                        site,
                        rounds: [{
                            orderIds: [1], stops: 1, ordering: 'nearest', driveMiles: 3.1,
                            zips: ['78207'], siteIds: [7], earliestDueAt: null,
                            spreadMiles: 1.1, stretched: false,
                            courier: { username: 'ana', name: 'Ana Driver', why: 'home' },
                        }],
                        urgent: [91, 92, 93, 94],
                        notes: [],
                    }
                    : {
                        serviceDate: DAY,
                        site,
                        rounds: [],
                        urgent: [],
                        notes: [],
                        drivers: [driver('ana', 'Ana Driver')],
                        unmapped: false,
                        restingHere: 0,
                    }
            ),
        });
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));

        await screen.findByText(/4 STAT deliveries are not in these rounds/);
    });
});

/* ───────────── the same round as a picture (23 November 2026)
 *
 * Beside the Excel button, which is for the desk. This one is for the
 * handset: a .xlsx reaching an Android phone is a prompt to install
 * something, and a PNG opens in the message it arrived in.
 *
 * The drawing itself is lib/round-image's, and is tested there against the
 * canvas jsdom does not have. What is tested here is the WIRING: that the
 * button is not offered before a run exists, that it reads THAT driver's
 * run rather than the split, that the file is named after the driver, and
 * that a failure lands in the dialog's error strip instead of a console.
 *
 * roundImage is stubbed because jsdom cannot paint -- but only roundImage.
 * saveBlob and roundImageName are the real ones, so the filename assertion
 * below is about the code that ships rather than about the stub.
 */
const draw = vi.hoisted(() => ({ fail: false }));

vi.mock('../../lib/round-image', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../lib/round-image')>();
    return {
        ...real,
        roundImage: async () => {
            if (draw.fail) throw new Error('the canvas would not hand back a picture');
            return new Blob([new Uint8Array(4)], { type: 'image/png' });
        },
    };
});

describe('the picture each driver can be sent', () => {
    const round = (over: Record<string, unknown> = {}) => ({
        orderIds: [1, 2, 3],
        stops: 3,
        ordering: 'nearest',
        driveMiles: 12.4,
        zips: ['78207'],
        siteIds: [7],
        earliestDueAt: null,
        spreadMiles: 2.1,
        stretched: false,
        courier: { username: 'ana', name: 'Ana Driver', why: 'home' },
        ...over,
    });

    const STOPS = [
        { sequence: 1, externalRef: 'RX-1', recipientName: 'A Patient', address: '1 Road', city: 'San Antonio', zip: '78207' },
    ];

    const ready = (over: Record<string, unknown> = {}) => mockFetch({
        'GET /api/projects/uh/uh/runs/split*': (url: string) => (
            url.includes('couriers=')
                ? { serviceDate: DAY, site, rounds: [round()], urgent: [], notes: [] }
                : {
                    serviceDate: DAY,
                    site,
                    rounds: [],
                    urgent: [],
                    notes: [],
                    drivers: [driver('ana', 'Ana Driver')],
                    unmapped: false,
                    restingHere: 0,
                }
        ),
        'POST /api/projects/uh/uh/runs/split/apply': { runs: [{ id: 41, courierUsername: 'ana' }], rejected: [] },
        'GET /api/projects/uh/uh/runs/41': { id: 41, serviceDate: DAY, label: 'Round 1', stops: STOPS },
        ...over,
    });

    const clusterThenAssign = async () => {
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));
        await screen.findByText('Driving');
        fireEvent.click(screen.getByRole('button', { name: /^Assign/ }));
        await screen.findByText('Assigned');
    };

    /* saveBlob is the real one, and jsdom has neither object URLs nor a
       downloader -- a real click on a blob: anchor makes it try to
       navigate and print a stack. The filenames it was asked to save land
       in `saved` instead, which is also what the assertion below reads. */
    let saved: string[] = [];

    beforeEach(() => {
        draw.fail = false;
        saved = [];
        URL.createObjectURL = vi.fn(() => 'blob:round');
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(function record(this: HTMLAnchorElement) { saved.push(this.download); });
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('offers nothing to draw before Assign', async () => {
        /* No run, no stops. The picture is of a round, and before Assign
           there is no round -- only a proposal nobody has accepted. */
        ready();
        open();
        await screen.findByText('Ana Driver');
        fireEvent.click(screen.getByRole('button', { name: /^Cluster between/ }));

        await screen.findByText('Driving');
        expect(screen.queryByRole('button', { name: /Image/ })).not.toBeInTheDocument();
    });

    it('reads that driver\u2019s own run for the stops, not the split', async () => {
        /* The split carries order IDS and counts. It never held a name or
           an address, so a picture drawn from it would have been a page of
           numbers -- and reading the run is also what puts the read in the
           audit log, which a picture of a patient list should be in. */
        const net = ready();
        await clusterThenAssign();

        fireEvent.click(screen.getByRole('button', { name: /Image/ }));
        await waitFor(() => {
            expect(net.calls).toContain('GET /api/projects/uh/uh/runs/41');
        });
    });

    it('names the file after the driver and the day', async () => {
        /* A dispatcher saves one of these per driver into the same folder.
           Three files called round.png are two called round(2).png. */
        ready();
        await clusterThenAssign();

        fireEvent.click(screen.getByRole('button', { name: /Image/ }));
        await waitFor(() => { expect(saved).toEqual(['Ana Driver 2026-11-21 round.png']); });
    });

    it('says so in the dialog when the round cannot be drawn', async () => {
        /* A canvas that will not encode is the one failure here that is
           not the network's, and it has to reach the error strip naming
           the driver: a dispatcher whose download does nothing and says
           nothing presses it four more times and then rings us. */
        draw.fail = true;
        ready();
        await clusterThenAssign();

        fireEvent.click(screen.getByRole('button', { name: /Image/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/Ana Driver/);
    });

    it('offers nothing for a driver the server did not come back with', async () => {
        /* Keyed on what the server created, the same as the Excel link: a
           round rejected on apply gets no button rather than a button that
           draws somebody else's patients. */
        mockFetch({
            'GET /api/projects/uh/uh/runs/split*': (url: string) => (
                url.includes('couriers=')
                    ? { serviceDate: DAY, site, rounds: [round()], urgent: [], notes: [] }
                    : {
                        serviceDate: DAY,
                        site,
                        rounds: [],
                        urgent: [],
                        notes: [],
                        drivers: [driver('ana', 'Ana Driver')],
                        unmapped: false,
                        restingHere: 0,
                    }
            ),
            'POST /api/projects/uh/uh/runs/split/apply': {
                runs: [{ id: 41, courierUsername: 'someone.else' }], rejected: [],
            },
        });
        await clusterThenAssign();

        expect(screen.queryByRole('button', { name: /Image/ })).not.toBeInTheDocument();
    });
});
