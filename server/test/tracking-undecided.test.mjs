/* Ticket 6.6: what happens before anybody has decided how long a courier's
 * track is kept.
 *
 * Its own file because startServer() may be called once per file, and this
 * needs a server booted WITHOUT the retention decision in the environment.
 *
 * The behaviour is the opposite of how this system treats every other
 * undecided retention period. Everywhere else the risk is deleting evidence
 * too early, so undecided means keep. A breadcrumb trail of an identified
 * employee runs the other way: collecting it with no agreed expiry is itself
 * the harm, so nothing is collected at all.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';

let srv;
let nod;

beforeAll(async () => {
    delete process.env.RETENTION_LOCATION_TRACE_DAYS;
    srv = await startServer();
    const admin = await srv.login('admin');
    await admin.post('/api/users').send({ username: 'nod.track', name: 'Nod', password: 'track-pass-1', role: 'driver' });
    await admin.put('/api/users/nod.track/memberships/uh').send({ role: 'courier', settings: {} });
    nod = srv.agent();
    await nod.post('/api/login').send({ username: 'nod.track', password: 'track-pass-1' });
    await nod.post(`${UH}/shifts/start`).send({});
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('no decision, no collection', () => {
    it('refuses every point, from a courier who is properly on shift', async () => {
        const res = await nod.post(`${UH}/tracking`).send({
            fixes: [{ at: new Date().toISOString(), lat: 29.42, lng: -98.49 }],
        });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('tracking.retentionUndecided');
        expect(res.body.error).toMatch(/how long/i);
    });

    it('leaves the table empty rather than nearly empty', async () => {
        const rows = await srv.core.client.execute({ sql: 'SELECT COUNT(*) AS n FROM shift_positions' });
        expect(Number(rows.rows[0].n), 'not one point').toBe(0);
    });

    it('still lets the board answer, with nothing to draw', async () => {
        /* The live board is not gated on the decision: it reads what is
           there, and what is there is nothing. A dispatcher opening it sees
           couriers on shift with no positions, which is the truth. */
        const admin = await srv.login('admin');
        const res = await admin.get(`${UH}/tracking/live`);
        expect(res.status).toBe(200);
        expect(res.body.couriers.every((c) => c.position === null)).toBe(true);
    });
});
