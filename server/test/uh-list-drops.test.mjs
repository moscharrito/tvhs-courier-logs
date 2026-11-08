/* The drop box: a file a pharmacy hands over, and nothing else yet.
 *
 * The property behind every test here: NOTHING IS PARSED AND NOTHING IS
 * CREATED. A pharmacy can hand over a layout the importer would refuse --
 * which is the point, because BC3 has no ZIP column and TDI arrives with no
 * header row -- and no delivery, no board row and no SLA clock comes of it
 * until dispatch imports it the normal way.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const DROPS = `${UH}/list-drops`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let srv;
let admin;
let discharge;
let green;
let today;

/** Every PUT the server sent to the bucket, so the bytes can be checked. */
let puts = [];

beforeAll(async () => {
    srv = await startServer({
        FILES_ENABLED: 'true',
        S3_BUCKET: 'izy-pod-test',
        S3_REGION: 'us-east-2',
        S3_ACCESS_KEY_ID: 'AKIATESTONLY',
        S3_SECRET_ACCESS_KEY: 'test-secret-not-a-real-key',
        S3_KMS_KEY_ID: 'arn:aws:kms:us-east-2:1:key/abc',
    });
    admin = await srv.login('admin');

    /* The bucket is not real. The presigning is, so what is stubbed is the
       one hop that would leave this machine -- and stubbing it is also how
       the bytes we send get inspected. */
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url, init = {}) => {
        if (init.method === 'PUT' && String(url).includes('amazonaws.com')) {
            puts.push({ url: String(url), contentType: init.headers?.['Content-Type'], body: init.body });
            return new Response('', { status: 200 });
        }
        return realFetch(url, init);
    });

    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    await admin.post('/api/users').send({
        username: 'drop.pharmacist', name: 'Discharge Pharmacist', password: 'drop-pass-1', role: 'staff',
    });
    await admin.put('/api/users/drop.pharmacist/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: [discharge.id] },
    });

    await admin.post('/api/users').send({
        username: 'drop.dispatch', name: 'Dispatch Team', password: 'drop-pass-2', role: 'staff',
    });
    await admin.put('/api/users/drop.dispatch/memberships/uh').send({
        role: 'lead', settings: { siteIds: [discharge.id, green.id] },
    });
});
afterAll(async () => { vi.unstubAllGlobals(); await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

const agentFor = async (username, password) => {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password })).status).toBe(200);
    return a;
};

/** Hand a file over the way a browser does: raw body, filename in a header. */
const hand = (agent, options, bytes = Buffer.from('a,b,c\n1,2,3\n'), type = 'text/csv', filename = 'monday.csv') =>
    agent
        .post(`${DROPS}?options=${encodeURIComponent(JSON.stringify(options))}`)
        .set('Content-Type', type)
        .set('X-Upload-Filename', filename)
        .send(bytes);

describe('a pharmacy handing a list over', () => {
    it('is accepted, and creates no deliveries', async () => {
        /* THE WHOLE PROMISE OF THIS FEATURE. If this ever starts creating
           orders, the drop box has become the import route and the reason
           for it has gone. */
        const before = Number((await sql('SELECT COUNT(*) AS n FROM orders')).rows[0].n);

        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const res = await hand(them, { siteId: discharge.id, serviceDate: today });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.id).toBeGreaterThan(0);

        const after = Number((await sql('SELECT COUNT(*) AS n FROM orders')).rows[0].n);
        expect(after, 'no delivery may come of a drop').toBe(before);
        expect(Number((await sql('SELECT COUNT(*) AS n FROM daily_lists')).rows[0].n)).toBe(0);
    });

    it('says plainly that nothing will be delivered from it', async () => {
        /* A pharmacy who has used the import screen reasonably expects
           deliveries to appear. Saying so is cheaper than the phone call. */
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const res = await hand(them, { siteId: discharge.id, serviceDate: today });
        expect(res.body.note).toMatch(/creates no deliveries/i);
    });

    it('puts the bytes in the bucket, with the type it was given', async () => {
        puts = [];
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const bytes = Buffer.from('patient,address\nIne,1 Test St\n');
        expect((await hand(them, { siteId: discharge.id, serviceDate: today }, bytes)).status).toBe(201);

        expect(puts).toHaveLength(1);
        expect(puts[0].contentType).toBe('text/csv');
        expect(Buffer.from(puts[0].body)).toEqual(bytes);
        // The key is ours and carries no patient, only the counter and day.
        expect(puts[0].url).toContain('list-drop');
    });

    it('accepts a spreadsheet the importer could not read', async () => {
        /* BC3 has no ZIP column and TDI has no header row. Under the import
           route those cannot be handed over at all, which is the hole this
           fills -- so a file of nonsense has to be accepted here. */
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const nonsense = Buffer.from('this is not a list at all, it is a sentence');
        const res = await hand(them, { siteId: discharge.id, serviceDate: today }, nonsense, XLSX, 'bc3.xlsx');
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('refuses something that is not a sheet, rather than storing it', async () => {
        /* The download hands this Content-Type back, so an unknown one is a
           file the browser opens wrongly later. */
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const res = await hand(
            them, { siteId: discharge.id, serviceDate: today },
            Buffer.from('%PDF-1.4'), 'application/octet-stream', 'scan.pdf',
        );
        expect(res.status).toBe(415);
        expect(res.body.code).toBe('drop.unsupportedType');
    });

    it('refuses a counter the account is not named on', async () => {
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const res = await hand(them, { siteId: green.id, serviceDate: today });
        expect(res.status).toBe(403);
    });

    it('refuses a service date that is not a date', async () => {
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        expect((await hand(them, { siteId: discharge.id, serviceDate: 'tomorrow' })).status).toBe(400);
    });

    it('is not gated by the portal upload setting', async () => {
        /* THE DECISION THIS FEATURE RESTS ON. listRelease.allowPortalUpload
           is off for this contract and exists because a portal IMPORT
           creates deliveries directly. This creates none: it replaces the
           email attachment, and gating it would leave the drop box off for
           the one contract that emails every list. */
        const off = await admin.patch('/api/projects/uh/settings')
            .send({ listRelease: { allowPortalUpload: false } });
        expect(off.status).toBe(200);

        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        expect((await hand(them, { siteId: discharge.id, serviceDate: today })).status).toBe(201);
        // And the import route is still refused, which is what the setting is for.
        const refused = await them
            .post(`${UH}/imports/preview?options=${encodeURIComponent(JSON.stringify({ siteId: discharge.id, serviceDate: today }))}`)
            .set('Content-Type', 'text/csv')
            .set('X-Upload-Filename', 'x.csv')
            .send(Buffer.from('a\n1\n'));
        expect(refused.status).toBe(403);
    });

    it('keeps no patient in the audit line, only the file and the counter', async () => {
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const res = await hand(them, { siteId: discharge.id, serviceDate: today });
        const rows = await sql(
            `SELECT detail FROM audit_events WHERE action = 'list.drop' AND entity_id = ?`,
            [String(res.body.id)],
        );
        expect(rows.rows).toHaveLength(1);
        const detail = String(rows.rows[0].detail);
        expect(detail).toContain('monday.csv');
        expect(detail).not.toMatch(/patient|recipient/i);
    });
});

describe('the page dispatch reads', () => {
    it('shows every counter to dispatch and only their own to a pharmacy', async () => {
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        await hand(them, { siteId: discharge.id, serviceDate: today });

        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        await hand(dispatch, { siteId: green.id, serviceDate: today }, Buffer.from('x\n1\n'), 'text/csv', 'green.csv');

        const theirs = await them.get(DROPS);
        expect(theirs.status).toBe(200);
        expect(theirs.body.drops.every((d) => d.siteId === discharge.id)).toBe(true);

        const ours = await dispatch.get(DROPS);
        expect(new Set(ours.body.drops.map((d) => d.siteId)).size).toBeGreaterThan(1);
    });

    it('opens on what is outstanding, because that is the question', async () => {
        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        const res = await dispatch.get(DROPS);
        expect(res.body.status).toBe('outstanding');
        expect(res.body.drops.every((d) => d.handled === false)).toBe(true);
    });

    it('narrows by counter, by date and by filename', async () => {
        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');

        const bysite = await dispatch.get(`${DROPS}?siteId=${green.id}`);
        expect(bysite.body.drops.every((d) => d.siteId === green.id)).toBe(true);

        const byDate = await dispatch.get(`${DROPS}?from=1999-01-01&to=1999-01-02`);
        expect(byDate.body.drops).toHaveLength(0);

        const byName = await dispatch.get(`${DROPS}?q=green`);
        expect(byName.body.drops.length).toBeGreaterThan(0);
        expect(byName.body.drops.every((d) => d.filename.includes('green'))).toBe(true);
    });

    it('offers a pharmacy picker it cannot be refused on', async () => {
        /* A picker that offers a counter the server would 403 on is a
           screen that produces an error somebody cannot act on. */
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const res = await them.get(DROPS);
        expect(res.body.pharmacies.map((p) => p.id)).toEqual([discharge.id]);
    });

    it('never hands out the storage key', async () => {
        /* It is ours, and the download is a URL that expires. */
        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        const res = await dispatch.get(DROPS);
        expect(JSON.stringify(res.body)).not.toMatch(/s3_?key|list-drop\//i);
    });
});

describe('downloading one', () => {
    it('redirects to a signed URL and records that it happened', async () => {
        /* A spreadsheet of patients left the building. */
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const made = await hand(them, { siteId: discharge.id, serviceDate: today });

        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        const res = await dispatch.get(`${DROPS}/${made.body.id}/file`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('amazonaws.com');

        const rows = await sql(
            `SELECT username FROM audit_events WHERE action = 'list.drop.download' AND entity_id = ?`,
            [String(made.body.id)],
        );
        expect(rows.rows).toHaveLength(1);
        expect(String(rows.rows[0].username)).toBe('drop.dispatch');
    });

    it('is not found for a counter the account is not named on', async () => {
        /* 404 rather than 403: this is keyed by an id, and a 403 lets
           somebody count another pharmacy's uploads by walking numbers. */
        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        const made = await hand(dispatch, { siteId: green.id, serviceDate: today }, Buffer.from('x\n'), 'text/csv', 'g.csv');

        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        expect((await them.get(`${DROPS}/${made.body.id}/file`)).status).toBe(404);
    });
});

describe('marking one dealt with', () => {
    it('is dispatch pressing a button, and a pharmacy cannot', async () => {
        /* A pharmacy saying "you have handled this" would be reporting on
           our work rather than on theirs. */
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const made = await hand(them, { siteId: discharge.id, serviceDate: today });

        expect((await them.post(`${DROPS}/${made.body.id}/handled`).send({})).status).toBe(403);

        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        const done = await dispatch.post(`${DROPS}/${made.body.id}/handled`).send({});
        expect(done.status).toBe(200);
        expect(done.body.handled).toBe(true);
        expect(done.body.handledBy).toBe('drop.dispatch');
    });

    it('drops off the outstanding list once it is done', async () => {
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const made = await hand(them, { siteId: discharge.id, serviceDate: today });
        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');
        await dispatch.post(`${DROPS}/${made.body.id}/handled`).send({});

        const open = await dispatch.get(DROPS);
        expect(open.body.drops.find((d) => d.id === made.body.id)).toBeUndefined();

        const all = await dispatch.get(`${DROPS}?status=all`);
        expect(all.body.drops.find((d) => d.id === made.body.id)).toBeTruthy();

        const handled = await dispatch.get(`${DROPS}?status=handled`);
        expect(handled.body.drops.find((d) => d.id === made.body.id)).toBeTruthy();
    });

    it('can be undone, because somebody presses the wrong row', async () => {
        const them = await agentFor('drop.pharmacist', 'drop-pass-1');
        const made = await hand(them, { siteId: discharge.id, serviceDate: today });
        const dispatch = await agentFor('drop.dispatch', 'drop-pass-2');

        await dispatch.post(`${DROPS}/${made.body.id}/handled`).send({});
        const back = await dispatch.post(`${DROPS}/${made.body.id}/handled`).send({ handled: false });
        expect(back.status).toBe(200);
        expect(back.body.handled).toBe(false);
        expect(back.body.handledBy).toBe('');
    });
});
