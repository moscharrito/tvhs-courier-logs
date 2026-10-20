/* The offline queue (ticket 7.5).
 *
 * The four rules from web/src/lib/outbox.ts, tested here because the phone
 * version is a second implementation of the same promise and a promise kept
 * in one place and broken in the other is worse than not making it.
 *
 * The ordering test is the one that matters. A delivery recorded before its
 * own arrival is a chain of custody that reads backwards, and that is the
 * document this contract is built on.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    EMPTY, MAX_REJECTIONS, REJECTION_TTL_MS,
    drain, enqueue, newId, pendingLabel, prune, signOutQuestion,
    type OutboxEntry, type OutboxState, type SendResult,
} from './outbox';

const NOW = new Date('2026-09-17T15:00:00.000Z').getTime();

const entry = (id: string, label = id): Omit<OutboxEntry, 'attempts'> => ({
    id,
    path: '/api/projects/uh/uh/orders/1/deliver',
    body: { signedName: 'I. Vargas', clientEventId: id },
    label,
    queuedAt: new Date(NOW).toISOString(),
});

const queued = (...ids: string[]): OutboxState =>
    ids.reduce((s, id) => enqueue(s, entry(id)), EMPTY);

const ok = (): SendResult => ({ ok: true });
const offline = (): SendResult => ({ ok: false, refused: false, why: 'no signal' });
const refused = (why = 'That order is not yours.'): SendResult => ({ ok: false, refused: true, why });

describe('in order, one at a time', () => {
    it('sends everything when everything goes', async () => {
        const send = vi.fn(async (_e: OutboxEntry) => ok());
        const out = await drain(queued('a', 'b', 'c'), send, NOW);
        expect(out.sent).toBe(3);
        expect(out.state.queue).toEqual([]);
        expect(send.mock.calls.map((c) => (c as [OutboxEntry])[0].id)).toEqual(['a', 'b', 'c']);
    });

    it('STOPS at the first thing it cannot send, rather than skipping ahead', async () => {
        /* The rule the whole file exists for. Sending c after b failed would
           record a delivery before its own arrival. */
        const send = vi.fn(async (e: OutboxEntry) => (e.id === 'b' ? offline() : ok()));
        const out = await drain(queued('a', 'b', 'c'), send, NOW);

        expect(out.sent).toBe(1);
        expect(out.blocked).toBe(true);
        expect(out.state.queue.map((e) => e.id)).toEqual(['b', 'c']);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('counts the attempt, so a stuck entry is visible', async () => {
        const out = await drain(queued('a'), async () => offline(), NOW);
        expect(out.state.queue[0]!.attempts).toBe(1);
        const again = await drain(out.state, async () => offline(), NOW);
        expect(again.state.queue[0]!.attempts).toBe(2);
    });

    it('picks up where it left off', async () => {
        const first = await drain(queued('a', 'b'), async (e) => (e.id === 'b' ? offline() : ok()), NOW);
        const second = await drain(first.state, async () => ok(), NOW);
        expect(second.sent).toBe(1);
        expect(second.state.queue).toEqual([]);
    });
});

describe('a refusal is not a retry', () => {
    it('moves a refused entry aside instead of trying for ever', async () => {
        /* A 4xx means the server understood and said no. Retrying produces
           the same no in thirty seconds, and for ever, with everything behind
           it stuck. */
        const out = await drain(queued('a'), async () => refused('That order is not yours.'), NOW);
        expect(out.state.queue).toEqual([]);
        expect(out.state.rejected).toHaveLength(1);
        expect(out.state.rejected[0]!.why).toBe('That order is not yours.');
        expect(out.blocked).toBe(false);
    });

    it('lets everything behind a refusal through', async () => {
        /* One refused delivery must not strand an afternoon's work. */
        const send = vi.fn(async (e: OutboxEntry) => (e.id === 'a' ? refused() : ok()));
        const out = await drain(queued('a', 'b', 'c'), send, NOW);
        expect(out.sent).toBe(2);
        expect(out.state.queue).toEqual([]);
        expect(out.state.rejected.map((r) => r.id)).toEqual(['a']);
    });

    it('keeps what the server actually said, for the courier to read', async () => {
        const one = enqueue(EMPTY, entry('a', 'Delivery for Ines Vargas'));
        const out = await drain(one, async () =>
            refused('This stop needs a signature. Left at the door is not offered.'), NOW);
        expect(out.state.rejected[0]!.label).toBe('Delivery for Ines Vargas');
        expect(out.state.rejected[0]!.why).toMatch(/needs a signature/);
    });
});

describe('the queue is PHI', () => {
    it('deletes an entry the moment it is accepted', async () => {
        const out = await drain(queued('a'), async () => ok(), NOW);
        expect(out.state.queue).toEqual([]);
        expect(JSON.stringify(out.state)).not.toMatch(/Vargas/);
    });

    it('expires a rejection rather than keeping it for ever', () => {
        const old: OutboxState = {
            queue: [],
            rejected: [{ id: 'a', label: 'Delivery for Ines Vargas', why: 'no', at: new Date(NOW - REJECTION_TTL_MS - 1).toISOString() }],
        };
        expect(prune(old, NOW).rejected).toEqual([]);
    });

    it('keeps one that is still worth reading', () => {
        const recent: OutboxState = {
            queue: [],
            rejected: [{ id: 'a', label: 'x', why: 'no', at: new Date(NOW - 60_000).toISOString() }],
        };
        expect(prune(recent, NOW).rejected).toHaveLength(1);
    });

    it('caps how many it will hold', () => {
        const many: OutboxState = {
            queue: [],
            rejected: Array.from({ length: MAX_REJECTIONS + 10 }, (_, i) => ({
                id: `r${i}`, label: 'x', why: 'no', at: new Date(NOW - 1000).toISOString(),
            })),
        };
        expect(prune(many, NOW).rejected).toHaveLength(MAX_REJECTIONS);
    });
});

describe('the phone chooses the id', () => {
    it('sends the same id on every retry, so the server can dedupe', async () => {
        /* This is the whole reason a retry is safe. Without it, a courier in
           a lift shaft records two deliveries. */
        const seen: string[] = [];
        let state = queued('a');
        for (let i = 0; i < 3; i += 1) {
            const out = await drain(state, async (e) => { seen.push(String(e.body['clientEventId'])); return offline(); }, NOW);
            state = out.state;
        }
        expect(new Set(seen).size).toBe(1);
    });

    it('does not collide across a fleet of phones', () => {
        const ids = new Set(Array.from({ length: 2000 }, () => newId()));
        expect(ids.size).toBe(2000);
    });
});

describe('what the courier is told', () => {
    it('says nothing when nothing is waiting', () => {
        expect(pendingLabel(EMPTY)).toBe('');
    });

    it('says it is saved, which is the thing they want to know', () => {
        /* A courier who cannot tell "sent" from "on this phone" assumes sent,
           which is the failure the web shell put the sync banner above the
           fold for. */
        expect(pendingLabel(queued('a'))).toMatch(/saved on this phone/);
        expect(pendingLabel(queued('a', 'b'))).toMatch(/2 things/);
    });
});

describe('asking before a sign-out throws the queue away', () => {
    /** The question, insisting there is one, so the assertions stay readable. */
    function asked(queuedCount: number) {
        const q = signOutQuestion(queuedCount);
        if (q === null) throw new Error(`expected a question for ${queuedCount} queued`);
        return q;
    }

    it('does not ask when there is nothing to lose', () => {
        /* Sign out is also the shared-phone safety action. A dialog in front
           of every one of them trains couriers to tap through it, and that
           habit is what would carry them through the one below. */
        expect(signOutQuestion(0)).toBeNull();
    });

    it('does not ask on a negative count either', () => {
        /* Nothing produces one today. A guard that only reads `=== 0` turns
           a bad count into a dialog a courier cannot explain, in front of
           the one action they need in a hurry. */
        expect(signOutQuestion(-1)).toBeNull();
    });

    it('asks as soon as one record is only on the phone', () => {
        const q = asked(1);
        expect(q.title).toBe('Sign out and lose 1 record?');
        expect(q.confirmLabel).toBe('Sign out, lose it');
    });

    it('puts the count in the title, because that is what is being weighed', () => {
        /* The prose warning above the button already says "4 things are
           still waiting". It gets scrolled past. The number has to be in
           the question itself. */
        expect(asked(4).title).toBe('Sign out and lose 4 records?');
        expect(asked(12).title).toContain('12');
    });

    it('never says "1 records" or "lose them" for a single one', () => {
        /* A courier reads the plural as "more than I thought" and cancels a
           sign-out they needed, or the reverse. */
        expect(asked(1).title).not.toMatch(/1 records/);
        expect(asked(2).title).not.toMatch(/2 record\?/);
        expect(asked(2).confirmLabel).toBe('Sign out, lose them');
    });

    it('says the records cannot be recovered, in the body', () => {
        /* The whole point of asking. "Are you sure?" with no consequence
           named is a dialog people dismiss without reading. */
        expect(asked(3).body).toMatch(/cannot be recovered/);
        expect(asked(3).body).toMatch(/have not reached the office/);
    });

    it('names the destructive outcome on the confirming button', () => {
        /* Confirm puts Cancel first and an accidental tap outside lands on
           it; the other button has to say what it does, because "OK" next
           to a count does not. */
        expect(asked(5).confirmLabel).toMatch(/lose/);
    });
});
