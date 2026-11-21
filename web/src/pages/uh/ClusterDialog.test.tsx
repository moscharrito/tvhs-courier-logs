/* The dialog that splits one counter's list between the drivers standing
   at it.

   IT HAD NO TESTS until 21 November, which is how it shipped showing all
   thirty-five drivers on the contract when dispatch wanted the eleven at
   the counter. These are about WHO IT OFFERS and what it says when it can
   offer nobody -- an empty box with no sentence under it reads as a broken
   screen, and the two reasons it can be empty have different answers. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
