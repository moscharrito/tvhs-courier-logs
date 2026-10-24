/* The page somebody reads before doing something irreversible.
 *
 * The server's half is covered in server/test/mail-queue.test.mjs, including
 * the load-bearing property: a row the preview calls `would send` is a row
 * dispatch sends. What matters here is that the screen leads with the
 * consequence rather than making somebody add up four figures to find it,
 * and that it does not quietly imply a queue is harmless when it is not.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MailQueue } from './MailQueue';
import { mockFetch } from '../test/setup';

const ROUTE = 'GET /api/mail-queue*';

const row = (over = {}) => ({
    id: 1,
    kind: 'delivery.completed',
    orderId: 41,
    username: 'uh.discharge',
    email: 'counter@example.invalid',
    createdAt: '2026-10-21T14:05:00.000Z',
    body: 'Order 41 was delivered at 14:05.',
    outcome: 'would send',
    inNextBatch: true,
    ...over,
});

const queue = (over = {}) => ({
    total: 1,
    wouldSend: 1,
    noAddress: 0,
    suppressed: 0,
    batch: 25,
    oldest: '2026-10-21T14:05:00.000Z',
    rows: [row()],
    partial: false,
    ...over,
});

function show(body: unknown) {
    const mock = mockFetch({ [ROUTE]: body });
    render(<MailQueue />);
    return mock;
}

describe('the number somebody came for', () => {
    it('says in words how many emails releasing the queue would send', async () => {
        /* NOT four figures to add up. The thing this decides -- granting an
           IAM permission -- cannot be undone, and an email cannot be
           recalled. */
        show(queue({ total: 3, wouldSend: 2, noAddress: 1, rows: [row(), row({ id: 2 }), row({ id: 3, email: '', outcome: 'no address' })] }));
        const note = await screen.findByRole('status');
        expect(note).toHaveTextContent('Releasing this queue would send 2 emails');
        expect(note).toHaveTextContent(/cannot be recalled/);
    });

    it('gets the singular right, because "1 emails" reads like a bug', async () => {
        show(queue());
        expect(await screen.findByRole('status')).toHaveTextContent('would send 1 email.');
    });

    it('says plainly when an empty queue is empty', async () => {
        show(queue({ total: 0, wouldSend: 0, oldest: null, rows: [] }));
        const note = await screen.findByRole('status');
        expect(note).toHaveTextContent(/Nothing here would be emailed/);
        expect(note).toHaveTextContent(/queue is empty/);
    });

    it('distinguishes a queue with nothing sendable from an empty one', async () => {
        /* Both are safe, and they are safe for different reasons. "Empty"
           over four rows that are about to be closed unsent would be a
           sentence somebody later finds out was wrong. */
        show(queue({
            total: 2, wouldSend: 0, noAddress: 1, suppressed: 1,
            rows: [row({ email: '', outcome: 'no address' }), row({ id: 2, outcome: 'suppressed' })],
        }));
        const note = await screen.findByRole('status');
        expect(note).toHaveTextContent(/Nothing here would be emailed/);
        expect(note).not.toHaveTextContent(/queue is empty/);
        expect(note).toHaveTextContent(/nowhere to go or is suppressed/);
    });
});

describe('what is in it', () => {
    it('shows the account, the address, the order and what the email says', async () => {
        /* The body especially: an order number alone does not tell anybody
           whether this is a dry run, which is the actual question. */
        show(queue());
        expect(await screen.findByText('uh.discharge')).toBeInTheDocument();
        expect(screen.getByText('counter@example.invalid')).toBeInTheDocument();
        expect(screen.getByText('41')).toBeInTheDocument();
        expect(screen.getByText('Order 41 was delivered at 14:05.')).toBeInTheDocument();
        /* By the pill, because "would send" is also the label under the
           count at the top of the page. */
        expect(screen.getByText('would send', { selector: '.izy-pill' })).toBeInTheDocument();
    });

    it('says an account has no address rather than showing a blank cell', async () => {
        show(queue({ wouldSend: 0, noAddress: 1, rows: [row({ email: '', outcome: 'no address' })] }));
        expect(await screen.findByText(/none on the account/)).toBeInTheDocument();
    });

    it('marks the rows the next sweep will touch when the queue is deeper than one batch', async () => {
        /* dispatch takes `ORDER BY id LIMIT batch`, so a deep queue has a
           head and a tail and anything behind a row that keeps failing waits
           for it. */
        show(queue({ total: 30, wouldSend: 30, rows: [row(), row({ id: 2, inNextBatch: false })] }));
        expect(await screen.findAllByText('next')).toHaveLength(1);
    });

    it('does not mark anything when every row is in the next batch anyway', async () => {
        /* Marking all of them "next" is noise, and noise teaches somebody to
           ignore the mark on the day it means something. */
        const small = queue();
        expect(small.total).toBeLessThan(small.batch);
        show(small);
        await screen.findByText('uh.discharge');
        expect(screen.queryByText('next')).toBeNull();
    });

    it('says the queue is deeper than the page when it is', async () => {
        show(queue({ total: 400, wouldSend: 400, rows: [row()], partial: true }));
        expect(await screen.findByText(/only the first 1 of 400 are listed/)).toBeInTheDocument();
    });

    it('says how long the oldest has been waiting', async () => {
        show(queue());
        expect(await screen.findByText(/oldest has been waiting since/)).toBeInTheDocument();
    });
});

describe('when it cannot be read', () => {
    it('shows the refusal rather than an empty table that looks like good news', async () => {
        /* AN EMPTY QUEUE AND A FAILED REQUEST MUST NOT LOOK ALIKE. One means
           nothing is about to be sent; the other means nobody knows. */
        show({ status: 403, body: { error: 'Admin access required' } });
        expect(await screen.findByRole('alert')).toHaveTextContent(/Admin access required/);
        expect(screen.queryByRole('status')).toBeNull();
    });
});
