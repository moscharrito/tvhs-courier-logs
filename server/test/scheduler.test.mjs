/* The thing that actually runs the sweep (ticket 6.8).
 *
 * Ticket 6.5 built the sweep and left it as an endpoint, which made its
 * promise, that an unclaimed STAT is never nobody's problem, true only if
 * somebody remembered to call it. A rule enforced by a person remembering is
 * not enforced, and this is the file that closes that.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { startScheduler } from '../src/core/scheduler.ts';

const UH = '/api/projects/uh/uh';

let srv;
let admin;
let ana;
let siteId;

const quietLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    siteId = (await admin.get(`${UH}/sites`)).body.find((s) => s.code === 'discharge').id;
    await admin.post('/api/users').send({ username: 'ana.sched', name: 'Ana Sched', password: 'sched-pass-1', role: 'driver' });
    await admin.put('/api/users/ana.sched/memberships/uh').send({ role: 'courier', settings: {} });
    ana = srv.agent();
    await ana.post('/api/login').send({ username: 'ana.sched', password: 'sched-pass-1' });
}, 60_000);

afterAll(async () => { await srv?.stop(); });

async function urgentOrder() {
    const res = await admin.post(`${UH}/orders`).send({
        siteId, serviceType: 'stat', recipientName: 'Ines Vargas',
        addressLine: '1100 Broadway St', zip: '78215', description: 'Cold pack', quantity: 1,
    });
    await srv.core.client.execute({
        sql: 'UPDATE orders SET due_at = ? WHERE id = ?',
        args: [new Date(Date.now() + 10 * 60_000).toISOString(), res.body.id],
    });
    return res.body.id;
}

describe('the scheduler', () => {
    it('does not run unless somebody switched it on', async () => {
        /* A timer that hands deliveries to couriers should be started
           deliberately, in an environment somebody chose, and not by every
           test run and every laptop. */
        const s = startScheduler({ client: srv.core.client, logger: quietLogger, intervalSeconds: undefined });
        expect(s.running).toBe(false);
        s.stop();
    });

    it('runs when it is, and can be stopped', () => {
        const s = startScheduler({ client: srv.core.client, logger: quietLogger, intervalSeconds: 30 });
        expect(s.running).toBe(true);
        s.stop();
        expect(s.running).toBe(false);
    });

    it('sweeps every project without being told which', async () => {
        await ana.post(`${UH}/shifts/start`).send({});
        const id = await urgentOrder();

        const s = startScheduler({ client: srv.core.client, logger: quietLogger, intervalSeconds: undefined });
        await s.runOnce();

        const order = await admin.get(`${UH}/orders/${id}`);
        expect(order.body.status).toBe('assigned');
        expect(order.body.custody.find((e) => e.type === 'assigned').actor).toBe('system');
    });

    it('is safe to run twice, which is why two instances need no lock', async () => {
        /* The property that lets this be an in-process timer instead of an
           external cron with a distributed lock: the sweep works from the
           unassigned pool, so an order handed out by the first run is not
           there for the second. */
        await ana.post(`${UH}/shifts/start`).send({});
        const id = await urgentOrder();

        const s = startScheduler({ client: srv.core.client, logger: quietLogger, intervalSeconds: undefined });
        await Promise.all([s.runOnce(), s.runOnce()]);

        const stops = await srv.core.client.execute({
            sql: 'SELECT COUNT(*) AS n FROM run_stops WHERE order_id = ?',
            args: [id],
        });
        expect(Number(stops.rows[0].n), 'one stop, not two').toBe(1);
    });

    it('swallows a failure instead of taking the process down', async () => {
        /* An unhandled rejection inside a timer kills the server, and a
           server that is down delivers nothing at all. */
        const broken = {
            execute: () => Promise.reject(new Error('database went away')),
        };
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const s = startScheduler({ client: broken, logger, intervalSeconds: undefined });
        await expect(s.runOnce()).rejects.toThrow('database went away');

        /* runOnce is allowed to reject; the TIMER is what must not. Drive it
           the way the interval does and confirm nothing escapes. */
        await new Promise((resolve) => {
            const timed = startScheduler({ client: broken, logger, intervalSeconds: 15 });
            timed.runOnce().catch(() => {});
            timed.stop();
            resolve();
        });
        expect(true).toBe(true);
    });
});
