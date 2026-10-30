/* Resolving usernames to the names people are called by.
 *
 * On this contract a driver's username IS their email address, so several
 * screens printed one where a name belonged. The server has to supply the
 * name: a client holds the key and not the person.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { namesFor, displayName } from '../src/modules/uh/people.ts';

let srv;
let admin;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    await admin.post('/api/users').send({
        username: 'names.driver@example.invalid', name: 'Named Driver',
        password: 'names-pass-1', role: 'driver',
    });
    await admin.put('/api/users/names.driver@example.invalid/memberships/uh').send({ role: 'courier', settings: {} });
    await admin.post('/api/users').send({ username: 'names.nameless', name: 'x', password: 'names-pass-2', role: 'driver' });
    await srv.core.client.execute({ sql: "UPDATE users SET name = '' WHERE username = 'names.nameless'", args: [] });
}, 60_000);

afterAll(async () => { await srv?.stop(); });

describe('namesFor', () => {
    it('answers with the name for a username that is an address', () => {
        return namesFor(srv.core.client, ['names.driver@example.invalid']).then((m) => {
            expect(m.get('names.driver@example.invalid')).toBe('Named Driver');
        });
    });

    it('leaves out anybody it does not know, rather than throwing', async () => {
        const m = await namesFor(srv.core.client, ['nobody.at.all', 'system', '']);
        expect(m.size).toBe(0);
    });

    it('leaves out an account whose name is blank', async () => {
        /* An empty name is not a name. Absent from the map means the caller
           falls back to the username, which is at least something. */
        const m = await namesFor(srv.core.client, ['names.nameless']);
        expect(m.has('names.nameless')).toBe(false);
    });

    it('asks once for a repeated username', async () => {
        const m = await namesFor(srv.core.client, ['names.driver@example.invalid', 'names.driver@example.invalid']);
        expect(m.size).toBe(1);
    });

    it('answers an empty list without touching the database', async () => {
        const m = await namesFor(srv.core.client, []);
        expect(m.size).toBe(0);
    });
});

describe('displayName', () => {
    it('falls back to the username, never to nothing', () => {
        const m = new Map([['a.known', 'A Known']]);
        expect(displayName('a.known', m)).toBe('A Known');
        expect(displayName('a.stranger', m)).toBe('a.stranger');
        expect(displayName(null, m)).toBeNull();
    });
});

describe('what the order endpoints send', () => {
    it('puts the courier name beside the username on an order', async () => {
        const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
        const made = await admin.post('/api/projects/uh/uh/orders').send({
            siteId: sites[0].id, serviceType: 'adhoc', recipientName: 'Ines Vargas',
            addressLine: '1100 Broadway St', zip: '78215', description: 'Oral solids', quantity: 1,
        });
        expect(made.status, made.text).toBe(201);
        await admin.post(`/api/projects/uh/uh/orders/${made.body.id}/events`)
            .send({ type: 'assigned', courierUsername: 'names.driver@example.invalid' });

        const detail = await admin.get(`/api/projects/uh/uh/orders/${made.body.id}`);
        /* The username is still there: it is the key everything joins on,
           and a rename must not rewrite the row. */
        expect(detail.body.assignedTo).toBe('names.driver@example.invalid');
        expect(detail.body.assignedToName).toBe('Named Driver');

        const list = await admin.get('/api/projects/uh/uh/orders?limit=100');
        const row = list.body.orders.find((o) => o.id === made.body.id);
        expect(row.assignedToName).toBe('Named Driver');
    });
});
