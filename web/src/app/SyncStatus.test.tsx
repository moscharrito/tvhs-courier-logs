/* What a courier is told about the queue.

   The only thing that matters here is that "recorded" and "sent" never look
   the same. A courier who cannot tell them apart will assume sent, and a
   delivery nobody knows about is the failure this whole feature exists to
   prevent. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStatus } from './SyncStatus';
import { enqueue, flush, resetOutboxForTests, rejections } from '../lib/outbox';

const setOnline = (online: boolean) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
};

function fetchReturning(reply: { status: number; body?: unknown } | 'network') {
    const fn = vi.fn(async () => {
        if (reply === 'network') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetOutboxForTests();
    setOnline(true);
});
afterEach(() => { vi.unstubAllGlobals(); });

const queueOne = (label = 'Delivery for Ines Vargas') =>
    enqueue({ url: '/api/projects/uh/uh/orders/1/deliver', body: {}, label, orderId: 1 });

describe('SyncStatus', () => {
    it('says nothing when there is nothing to say', async () => {
        const { container } = render(<SyncStatus />);
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('says what is waiting, and how long it has been waiting', async () => {
        setOnline(false);
        await queueOne();
        render(<SyncStatus />);
        expect(await screen.findByText(/1 thing is saved on this phone and not sent yet/)).toBeInTheDocument();
        expect(screen.getByText(/No signal right now/)).toBeInTheDocument();
    });

    it('offers to try again when there is signal but things are still waiting', async () => {
        setOnline(false);
        await queueOne();
        setOnline(true);
        render(<SyncStatus />);
        await screen.findByRole('button', { name: 'Try now' });

        fetchReturning({ status: 201 });
        fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
        await waitFor(() => expect(screen.queryByText(/saved on this phone/)).not.toBeInTheDocument());
    });

    it('is loud about something the server refused, because only a person can fix it', async () => {
        setOnline(false);
        await queueOne('Delivery for Ines Vargas');
        setOnline(true);
        fetchReturning({ status: 409, body: { error: 'That order was already delivered' } });
        await flush();

        render(<SyncStatus />);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('One thing could not be recorded');
        expect(alert).toHaveTextContent('Delivery for Ines Vargas');
        expect(alert).toHaveTextContent('That order was already delivered');
        expect(alert).toHaveTextContent('Tell dispatch what happened');
    });

    it('lets the courier clear a refusal they have read', async () => {
        setOnline(false);
        await queueOne();
        setOnline(true);
        fetchReturning({ status: 409, body: { error: 'no' } });
        await flush();
        render(<SyncStatus />);

        fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        expect(await rejections()).toHaveLength(0);
    });
});
