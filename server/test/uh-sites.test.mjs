import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh/sites';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

/** A member of uh with a given project role, for access-control checks. */
async function memberWith(role, username) {
    await admin.post('/api/users').send({ username, name: `Test ${role}`, password: 'member-pass-12', role: 'staff' });
    await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
    const a = srv.agent();
    const res = await a.post('/api/login').send({ username, password: 'member-pass-12' });
    expect(res.status).toBe(200);
    return a;
}

describe('seeded UH pharmacies', () => {
    it('loads the nine pickup locations from the bid table, scoped to the uh project', async () => {
        const res = await admin.get(UH);
        expect(res.status).toBe(200);
        /* NINE ROWS, EIGHT OF THEM PHARMACIES, and the distinction is the
           whole point rather than a detail of the count.

           0041 deleted Business Center III -- an office, not a pharmacy --
           and was right about that: Addendum 1 says seven pick-up
           locations, the eight here each took deliveries on 30 September
           2026, and BC3 was not among the sites University Health's
           Assistant Director read out.

           0056 puts it back as a DESTINATION, because Pavilion dispenses
           their own employees' prescriptions and they are carried to BC3
           for collection. type 'other' and releasesList false keep the
           distinction 0041 drew: nobody collects here, and it must never
           appear in a list of counters that send work. */
        expect(res.body).toHaveLength(9);
        expect(res.body.filter((s) => s.type === 'pharmacy')).toHaveLength(8);

        const byCode = Object.fromEntries(res.body.map((s) => [s.code, s]));
        expect(Object.keys(byCode).sort()).toEqual(['bc3', 'discharge', 'green', 'pavilion', 'southeast', 'southwest', 'tdi', 'vida', 'wheatley']);
        expect(byCode['bc3'], 'a place we deliver to, never collect from').toMatchObject({
            name: 'Business Center III', type: 'other', releasesList: false, status: 'active',
        });

        expect(byCode['pavilion']).toMatchObject({
            name: 'University Health Medical Center Pavilion Pharmacy',
            addressLine: '4647 Medical Drive', city: 'San Antonio', state: 'TX', zip: '78229',
            type: 'pharmacy', status: 'active', releasesList: true,
        });
        expect(byCode['discharge']).toMatchObject({ name: 'University Hospital Discharge Pharmacy', zip: '78229' });
        expect(byCode['discharge'].notes).toMatch(/after-hours returns/i);
        /* THIS GUARD USED TO SAY bc3 MUST NOT EXIST AT ALL, and it was there
           for a reason: open item 6 asked whether Business Center III was a
           pickup location and the answer was no.

           The answer is still no. What changed is that we now DELIVER
           there, so the row exists again (0056) and the guard has to pin
           the thing it was actually protecting rather than the absence it
           used as a proxy: BC3 is never a pharmacy and never releases a
           list, so it can never be mistaken for a counter that sends work. */
        expect(byCode['bc3'].type).not.toBe('pharmacy');
        expect(byCode['bc3'].releasesList).toBe(false);

        // The ZIPs the bid table lists for pickup locations, plus BC3's.
        /* 78249 is Business Center III, the ZIP printed on the solicitation
           as University Health's own procurement address. */
        const pharmacyZips = [...new Set(res.body.filter((s) => s.type === 'pharmacy').map((s) => s.zip))].sort();
        expect(pharmacyZips).toEqual(['78207', '78220', '78223', '78224', '78229', '78237']);
        expect(byCode['bc3'].zip).toBe('78249');
    });

    it('leaves coordinates unset rather than inventing them, pending ticket 1.4', async () => {
        const res = await admin.get(UH);
        expect(res.body.every((s) => s.lat === null && s.lng === null)).toBe(true);
        expect(res.body.every((s) => s.geocodeStatus === 'pending')).toBe(true);
        expect(res.body.every((s) => s.geocodedAt === null)).toBe(true);
    });

    it('exposes a single-line address for geocoding that contains no personal data', async () => {
        const pavilion = (await admin.get(UH)).body.find((s) => s.code === 'pavilion');
        expect(pavilion.fullAddress).toBe('4647 Medical Drive, San Antonio, TX 78229');
    });

    it('seeds sites only for the uh project, and re-running the migration adds no duplicates', async () => {
        const rows = (await sql(`SELECT p.code AS project, COUNT(*) AS n FROM sites s JOIN projects p ON p.id = s.project_id GROUP BY p.code`)).rows.map((r) => ({ ...r }));
        expect(rows).toEqual([{ project: 'uh', n: 9 }]);
    });
});

describe('access control', () => {
    it('requires membership of the project, and a manage role to write', async () => {
        expect((await srv.agent().get(UH)).status).toBe(401);

        // A TVHS courier is not a member of uh.
        const north = await srv.login('north');
        expect((await north.get(UH)).status).toBe(403);

        /* A courier reads the pharmacy list, because they collect from those
           addresses, and cannot change it. This used to be a three-way split
           where a dispatcher could read but not write and an ops manager
           could do both; ticket 5.12 merged those two into admin, so the line
           that is left is between running the operation and driving for it. */
        const courier = await memberWith('courier', 'uh.driver');
        expect((await courier.get(UH)).status).toBe(200);
        const denied = await courier.post(UH).send({ code: 'nope', name: 'No', addressLine: '1 A St', zip: '78229' });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toMatch(/Requires project role: admin/);

        // An admin may read and write.
        const ops = await memberWith('admin', 'uh.ops');
        expect((await ops.get(UH)).status).toBe(200);
        const created = await ops.post(UH).send({ code: 'ops.made', name: 'Ops Made', addressLine: '2 B St', zip: '78229' });
        expect(created.status).toBe(201);
        await ops.delete(`${UH}/${created.body.id}`);
    });

    it('cannot reach another project\'s sites through a different :pid', async () => {
        // tvhs has no sites, and a uh site id must not be readable through tvhs.
        const pavilion = (await admin.get(UH)).body.find((s) => s.code === 'pavilion');
        expect((await admin.get('/api/projects/tvhs/uh/sites')).body).toEqual([]);
        expect((await admin.get(`/api/projects/tvhs/uh/sites/${pavilion.id}`)).status).toBe(404);
        expect((await admin.patch(`/api/projects/tvhs/uh/sites/${pavilion.id}`).send({ name: 'Hijacked' })).status).toBe(404);
        expect((await admin.get(`${UH}/${pavilion.id}`)).body.name).toBe('University Health Medical Center Pavilion Pharmacy');
    });
});

describe('create, update, delete', () => {
    it('validates the body and reports every problem', async () => {
        const res = await admin.post(UH).send({ code: 'Bad Code!', name: '', addressLine: '', zip: 'abc' });
        expect(res.status).toBe(400);
        const text = res.body.details.join('\n');
        expect(text).toMatch(/code/);
        expect(text).toMatch(/name/);
        expect(text).toMatch(/zip/);
    });

    it('creates a site, defaults sensibly, and rejects a duplicate code in the same project', async () => {
        const res = await admin.post(UH).send({ code: 'Palo.Alto', name: 'University Health Palo Alto Hospital', type: 'hospital', addressLine: '1 Palo Alto Way', zip: '78224', notes: 'Opens 2026 to 2027' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            code: 'palo.alto', type: 'hospital', city: 'San Antonio', state: 'TX', zip: '78224',
            status: 'active', releasesList: true, lat: null, lng: null, geocodeStatus: 'pending',
        });

        const dup = await admin.post(UH).send({ code: 'palo.alto', name: 'Again', addressLine: '1 Palo Alto Way', zip: '78224' });
        expect(dup.status).toBe(409);

        // Same code in another project is fine.
        const other = await admin.post('/api/projects/tvhs/uh/sites').send({ code: 'palo.alto', name: 'Different project', addressLine: '1 Elsewhere', zip: '37130' });
        expect(other.status).toBe(201);
        await admin.delete(`/api/projects/tvhs/uh/sites/${other.body.id}`);
    });

    it('updates fields, and marks hand-entered coordinates as manual', async () => {
        const site = (await admin.get(UH)).body.find((s) => s.code === 'palo.alto');
        const res = await admin.patch(`${UH}/${site.id}`).send({ name: 'Palo Alto Hospital', status: 'inactive', releasesList: false });
        expect(res.body).toMatchObject({ name: 'Palo Alto Hospital', status: 'inactive', releasesList: false });

        const located = await admin.patch(`${UH}/${site.id}`).send({ lat: 29.3568, lng: -98.5461 });
        expect(located.body).toMatchObject({ lat: 29.3568, lng: -98.5461, geocodeStatus: 'manual' });
        expect(located.body.geocodedAt).toBeTruthy();

        expect((await admin.patch(`${UH}/${site.id}`).send({})).status).toBe(400);
        expect((await admin.patch(`${UH}/${site.id}`).send({ lat: 29.3 })).status).toBe(400);
        expect((await admin.patch(`${UH}/${site.id}`).send({ lat: 999, lng: 0 })).status).toBe(400);
    });

    it('clears coordinates when the address moves, so a stale point cannot price a zone', async () => {
        const site = (await admin.get(UH)).body.find((s) => s.code === 'palo.alto');
        expect(site.lat).not.toBeNull();
        const res = await admin.patch(`${UH}/${site.id}`).send({ addressLine: '2 New Address Road' });
        expect(res.body).toMatchObject({ addressLine: '2 New Address Road', lat: null, lng: null, geocodeStatus: 'pending' });
        expect(res.body.geocodedAt).toBeNull();
    });

    it('filters by status and type', async () => {
        expect((await admin.get(`${UH}?status=active`)).body).toHaveLength(9);
        expect((await admin.get(`${UH}?status=inactive`)).body.map((s) => s.code)).toEqual(['palo.alto']);
        expect((await admin.get(`${UH}?type=hospital`)).body.map((s) => s.code)).toEqual(['palo.alto']);
        /* STILL EIGHT. A filter for pharmacies must not start returning a
           back office just because we now deliver to one. */
        expect((await admin.get(`${UH}?type=pharmacy`)).body).toHaveLength(8);
        expect((await admin.get(`${UH}?type=other`)).body.map((s) => s.code)).toEqual(['bc3']);
    });

    it('refuses to delete a pharmacy that deliveries point at', async () => {
        /* This endpoint deleted unconditionally. An administrator could have
           removed Robert B. Green mid-contract and left its orders, their
           custody records and the invoices built from them pointing at a site
           id that no longer exists -- a proof of delivery that cannot name
           where the medication was collected from, which is the one thing
           Scope 1.2.8 requires it to carry. Migration 0041 already refused
           this; the live endpoint did not, which is the worse of the two
           places to be missing it. */
        const discharge = (await admin.get(UH)).body.find((s) => s.code === 'discharge');
        const created = await admin.post(ORDERS).send({
            siteId: discharge.id, serviceType: 'adhoc', recipientName: 'Someone',
            addressLine: '1 Guard Street', zip: '78215',
            description: 'Oral solids', quantity: 1, externalRef: 'SITE-GUARD-1',
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);

        const res = await admin.delete(`${UH}/${discharge.id}`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('site.inUse');
        /* Says how many of what, because "it is in use" is a support call. */
        expect(res.body.holding.join(' ')).toMatch(/\d+ deliveries/);
        /* And points at the thing that does work. */
        expect(res.body.error).toMatch(/inactive/);

        /* Still there, and still usable. */
        expect((await admin.get(`${UH}/${discharge.id}`)).status).toBe(200);
    });

    it('deletes a site and 404s afterwards', async () => {
        const site = (await admin.get(UH)).body.find((s) => s.code === 'palo.alto');
        expect((await admin.delete(`${UH}/${site.id}`)).body).toEqual({ ok: true, deleted: 'palo.alto' });
        expect((await admin.get(`${UH}/${site.id}`)).status).toBe(404);
        expect((await admin.get(UH)).body).toHaveLength(9);
        expect((await admin.get(`${UH}/999999`)).status).toBe(404);
        expect((await admin.get(`${UH}/not-a-number`)).status).toBe(404);
    });
});

describe('audit', () => {
    it('records create, update and delete against the uh project', async () => {
        const events = (await sql("SELECT action, entity, entity_id, project_id, username, detail FROM audit_events WHERE entity = 'site' ORDER BY id")).rows.map((r) => ({ ...r }));
        const actions = events.map((e) => e.action);
        expect(actions).toContain('site.create');
        expect(actions).toContain('site.update');
        expect(actions).toContain('site.delete');

        const created = events.find((e) => e.action === 'site.create' && e.entity_id === 'palo.alto');
        expect(created).toMatchObject({ username: 'admin', entity: 'site' });
        const uhProject = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
        expect(created.project_id).toBe(uhProject);
        expect(JSON.parse(created.detail)).toEqual({ name: 'University Health Palo Alto Hospital', type: 'hospital', zip: '78224' });
    });
});
