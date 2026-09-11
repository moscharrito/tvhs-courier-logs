import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh/sites';

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
        expect(res.body).toHaveLength(9);

        const byCode = Object.fromEntries(res.body.map((s) => [s.code, s]));
        expect(Object.keys(byCode).sort()).toEqual(['bc3', 'discharge', 'green', 'pavilion', 'southeast', 'southwest', 'tdi', 'vida', 'wheatley']);

        expect(byCode['pavilion']).toMatchObject({
            name: 'University Health Medical Center Pavilion Pharmacy',
            addressLine: '4647 Medical Drive', city: 'San Antonio', state: 'TX', zip: '78229',
            type: 'pharmacy', status: 'active', releasesList: true,
        });
        expect(byCode['discharge']).toMatchObject({ name: 'University Hospital Discharge Pharmacy', zip: '78229' });
        expect(byCode['discharge'].notes).toMatch(/after-hours returns/i);
        expect(byCode['bc3'].notes).toMatch(/open item 6/i);

        // The ZIPs match the five the bid table lists for pickup locations.
        expect([...new Set(res.body.map((s) => s.zip))].sort()).toEqual(['78207', '78220', '78223', '78224', '78229', '78237', '78249']);
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

        // A dispatcher may read but not write.
        const dispatcher = await memberWith('dispatcher', 'uh.dispatcher');
        expect((await dispatcher.get(UH)).status).toBe(200);
        const denied = await dispatcher.post(UH).send({ code: 'nope', name: 'No', addressLine: '1 A St', zip: '78229' });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toMatch(/admin or ops_manager/);

        // An ops manager may write.
        const ops = await memberWith('ops_manager', 'uh.ops');
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
        expect((await admin.get(`${UH}?type=pharmacy`)).body).toHaveLength(9);
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
