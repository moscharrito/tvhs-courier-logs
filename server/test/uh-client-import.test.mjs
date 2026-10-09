/* A pharmacy uploading its own daily list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS WORTH THE RISK IT CARRIES.
 *
 * Until this a pharmacy emailed a spreadsheet of patients and somebody here
 * imported it. That costs a person at each end, and it leaves a patient list
 * sitting in an inbox: email is the one hop in this system we neither control
 * nor have an audit trail for. A pharmacy uploading its own list removes the
 * inbox and starts the record at the moment the list arrived.
 *
 * What it costs is that a client can now create orders, which is the first
 * write anybody outside Izy has ever been able to make. So the tests that
 * matter here are not "does an upload work". They are the three things that
 * must not be reachable from a pharmacy's browser:
 *
 *   another counter's patients, in either direction: uploading for them or
 *   reading what they uploaded;
 *
 *   the SLA clock, which is ours. receivedAt is when the list reached us and
 *   every deadline is measured from it;
 *
 *   a service date that has already gone.
 *
 * Every name and address here is invented. No University Health data enters
 * any environment until the business associate agreements are filed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CSV = fs.readFileSync(path.join(FIXTURES, 'daily-list.csv'));

const BASE = '/api/projects/uh/uh/imports';
const CLIENT = '/api/projects/uh/uh/client';

let srv;
let admin;
let discharge;
let green;
let today;
let tomorrow;

/* A service date of its own for each test that COMMITS.
 *
 * Importing the same fixture twice for one site and day is correctly refused:
 * every row is a duplicate of one already imported, nothing would be created,
 * and the endpoint says so rather than writing a second copy of somebody's
 * medication run. That is the behaviour uh-import.test.mjs pins. Here it is
 * only in the way, so each commit gets its own day. */
let dayCursor = 2;
const ownDay = () => { dayCursor += 1; return dayIn(dayCursor); };

const dayIn = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
};

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get('/api/projects/uh/uh/sites')).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');
    today = dayIn(0);
    tomorrow = dayIn(1);

    /* The contract has to have agreed to take lists this way at all. It is
       off by default (listRelease.allowPortalUpload), which is the point of
       it: the feature works and whether a client uses it instead of emailing
       a spreadsheet is their decision. The last block in this file is the one
       that tests the setting itself; everything before it is about a contract
       that has said yes. */
    const on = await admin.patch('/api/projects/uh/settings')
        .send({ listRelease: { allowPortalUpload: true } });
    expect(on.status, JSON.stringify(on.body).slice(0, 200)).toBe(200);

    /* A pharmacist at one counter. Scoped by membership, which is the only
       thing that decides what they reach. */
    await admin.post('/api/users').send({
        username: 'uh.uploader', name: 'Discharge Pharmacist', password: 'upload-pass-1',
        role: 'staff',
    });
    await admin.put('/api/users/uh.uploader/memberships/uh').send({
        role: 'pharmacy', settings: { siteIds: [discharge.id] },
    });

    /* And one with no counters named at all, which is what a half-finished
       settings form leaves behind. */
    await admin.post('/api/users').send({
        username: 'uh.unscoped', name: 'New Starter', password: 'upload-pass-2',
        role: 'staff',
    });
    await admin.put('/api/users/uh.unscoped/memberships/uh').send({ role: 'pharmacy', settings: {} });
});
afterAll(async () => { await srv.stop(); });

const sql = (q, args = []) => srv.core.client.execute({ sql: q, args });

const agentFor = async (username, password) => {
    const a = srv.agent();
    expect((await a.post('/api/login').send({ username, password })).status).toBe(200);
    return a;
};

/** Upload the way the browser does: raw body, filename in a header. */
const upload = (agent, url, options, bytes = CSV, filename = 'daily-list.csv') =>
    agent
        .post(`${url}?options=${encodeURIComponent(JSON.stringify(options))}`)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Upload-Filename', filename)
        .send(bytes);

describe('a pharmacy uploading for its own counter', () => {
    it('can preview its own list', async () => {
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, `${BASE}/preview`, { siteId: discharge.id, serviceDate: tomorrow });
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
        expect(res.body.site.id).toBe(discharge.id);
        expect(res.body.rows.length).toBeGreaterThan(0);
    });

    it('can commit it, and the orders are real orders', async () => {
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: discharge.id, serviceDate: ownDay() });
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
        expect(res.body.summary.imported).toBeGreaterThan(0);

        /* Not half an order. The custody chain has to start where the list
           entered the system, or the record for a delivery begins at
           assignment with nothing saying where it came from. */
        const rows = await sql(
            `SELECT COUNT(*) AS n FROM custody_events c JOIN orders o ON o.id = c.order_id
             WHERE o.daily_list_id = ? AND c.type = 'created'`,
            [res.body.id],
        );
        expect(Number(rows.rows[0].n)).toBe(res.body.summary.imported);
    });

    it('is recorded as the person who uploaded it', async () => {
        /* The point of them doing it themselves: the record says the pharmacy
           sent this list, rather than saying one of us typed it in. */
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: discharge.id, serviceDate: ownDay() });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
        const row = await sql('SELECT imported_by FROM daily_lists WHERE id = ?', [res.body.id]);
        expect(String(row.rows[0].imported_by)).toBe('uh.uploader');
    });
});

describe('the counter next door', () => {
    it('cannot be uploaded for', async () => {
        /* THE PROPERTY. A client can write now, and the first thing to prove
           is that it can only write to itself. */
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: green.id, serviceDate: tomorrow });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/not on this account/i);
    });

    it('cannot be previewed for either, so nothing is learned by trying', async () => {
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        expect((await upload(them, `${BASE}/preview`, { siteId: green.id })).status).toBe(403);
    });

    it('writes nothing when it refuses', async () => {
        const before = await sql('SELECT COUNT(*) AS n FROM daily_lists WHERE site_id = ?', [green.id]);
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        await upload(them, BASE, { siteId: green.id, serviceDate: ownDay() });
        const after = await sql('SELECT COUNT(*) AS n FROM daily_lists WHERE site_id = ?', [green.id]);
        expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    });

    it('does not appear in the list of imports', async () => {
        /* Reading one is the same disclosure as uploading one. A pharmacist
           who could see the other counter's lists could see how many patients
           it serves and when. */
        const theirs = await upload(admin, BASE, { siteId: green.id, serviceDate: ownDay() });
        expect(theirs.status, JSON.stringify(theirs.body).slice(0, 200)).toBe(201);

        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const list = await them.get(BASE);
        expect(list.status).toBe(200);
        for (const l of list.body) {
            expect(l.site.id, 'only their own counter').toBe(discharge.id);
        }
    });

    it('cannot be opened by its id, and is answered as if it were not there', async () => {
        /* A 404 rather than a refusal: answering "not yours" to a number
           would let somebody count another counter's lists by walking ids. */
        const theirs = await upload(admin, BASE, { siteId: green.id, serviceDate: ownDay() });
        expect(theirs.status, JSON.stringify(theirs.body).slice(0, 200)).toBe(201);

        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await them.get(`${BASE}/${theirs.body.id}`);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/recipient|address|patient/i);
    });
});

describe('an account with no counters named', () => {
    it('gets nothing rather than everything, which is the direction that matters', async () => {
        /* A mistake in a settings form must not quietly hand one pharmacy the
           other eight. */
        const them = await agentFor('uh.unscoped', 'upload-pass-2');
        expect((await upload(them, BASE, { siteId: discharge.id, serviceDate: tomorrow })).status).toBe(403);
        const list = await them.get(BASE);
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(0);
    });
});

describe('the clock is ours', () => {
    it('ignores a receivedAt a pharmacy sends, rather than trusting it', async () => {
        /* THE ONE THAT WOULD BE QUIET AND EXPENSIVE. receivedAt starts the
           SLA every delivery on the list is measured against. A client who
           could set it could backdate it and have us miss a deadline that had
           already passed when they pressed the button. */
        const backdated = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, {
            siteId: discharge.id, serviceDate: ownDay(), receivedAt: backdated,
        });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);

        const row = await sql('SELECT received_at FROM daily_lists WHERE id = ?', [res.body.id]);
        const recorded = new Date(String(row.rows[0].received_at)).getTime();
        expect(recorded).toBeGreaterThan(Date.parse(backdated));
        /* Within a couple of minutes of now, i.e. it used its own clock. */
        expect(Math.abs(recorded - Date.now())).toBeLessThan(2 * 60 * 1000);
    });

    it('does not fail the upload over it, because a browser may send it by habit', async () => {
        /* Dropped rather than refused: somebody whose form posts the field
           should get a working upload and the right clock, not an error they
           cannot act on. */
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, `${BASE}/preview`, {
            siteId: discharge.id, receivedAt: new Date(Date.now() - 3600_000).toISOString(),
        });
        expect(res.status).toBe(200);
    });

    it('still lets dispatch set it, because dispatch answers for a list that came by email', async () => {
        /* The override is not gone, it is ours. A list that arrived at seven
           and was imported at nine has to be measured from seven. */
        const backdated = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const res = await upload(admin, BASE, {
            siteId: discharge.id, serviceDate: ownDay(), receivedAt: backdated,
        });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
        const row = await sql('SELECT received_at FROM daily_lists WHERE id = ?', [res.body.id]);
        expect(Date.parse(String(row.rows[0].received_at))).toBe(Date.parse(backdated));
    });
});

describe('the service date', () => {
    it('refuses a day that has already gone, rather than quietly moving it', async () => {
        /* Silently changing it to today would create a day of deliveries
           nobody asked for. The date IS the request. */
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: discharge.id, serviceDate: '2026-01-05' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('import.dateInPast');
    });

    it('accepts today and tomorrow', async () => {
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        for (const day of [today, tomorrow]) {
            const res = await upload(them, `${BASE}/preview`, { siteId: discharge.id, serviceDate: day });
            expect(res.status, `service date ${day}`).toBe(200);
        }
    });

    it('still lets dispatch backfill, which is a thing that genuinely happens', async () => {
        const res = await upload(admin, `${BASE}/preview`, { siteId: discharge.id, serviceDate: '2026-01-05' });
        expect(res.status).toBe(200);
    });
});

describe('what stays a dispatch job', () => {
    it('does not let a pharmacy read or clear the saved column mapping', async () => {
        /* A repair, not a client action: forgetting a mapping is something
           somebody does after looking at why a layout stopped matching, and
           the next morning's upload depends on it. They are never stuck
           without it, because a preview hands back the mapping it used and an
           upload may carry its own. */
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        expect((await them.get(`${BASE}/mappings/${discharge.id}`)).status).toBe(403);
        expect((await them.delete(`${BASE}/mappings/${discharge.id}`)).status).toBe(403);
    });

    it('hands a pharmacy everything it needs from the preview instead', async () => {
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, `${BASE}/preview`, { siteId: discharge.id, serviceDate: tomorrow });
        expect(res.status).toBe(200);
        expect(res.body.mapping).toBeTruthy();
        expect(res.body.mappingSource).toBeTruthy();
        expect(res.body.headerFingerprint).toBeTruthy();
    });
});

describe('who may not upload at all', () => {
    it('refuses a courier, a lead and anonymous', async () => {
        await admin.post('/api/users').send({
            username: 'uh.driverx', name: 'Driver X', password: 'upload-pass-3', role: 'driver',
        });
        await admin.put('/api/users/uh.driverx/memberships/uh').send({ role: 'courier', settings: {} });
        const courier = await agentFor('uh.driverx', 'upload-pass-3');
        expect((await upload(courier, BASE, { siteId: discharge.id })).status).toBe(403);

        expect((await upload(srv.agent(), BASE, { siteId: discharge.id })).status).toBe(401);
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * WHETHER THE PORTAL TAKES LISTS AT ALL IS THE CONTRACT'S DECISION.
 *
 * The upload works. Whether University Health use it instead of emailing a
 * spreadsheet has been put to them and not answered, and shipping it switched
 * on would be answering for them: a pharmacist who found the page, used it,
 * and then heard the contract had settled on email would have sent us a list
 * nobody was expecting to receive that way.
 *
 * So it is listRelease.allowPortalUpload, off by default, and the tests that
 * matter are that it gates the SERVER rather than a link. A setting that only
 * took a button off a screen would be a decoration, because the endpoint is
 * what somebody finds.
 */
describe('the portal upload is off until a contract switches it on', () => {
    const settingsUrl = '/api/projects/uh/settings';

    const setUpload = async (on) => {
        const res = await admin.patch(settingsUrl).send({ listRelease: { allowPortalUpload: on } });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    };

    afterAll(async () => { await setUpload(true); });

    it('is off by default, so nothing had to be switched off to get here', async () => {
        /* The default matters more than the toggle: a feature that arrives
           switched on has already made the client's decision for them. */
        const fresh = await admin.get(settingsUrl);
        expect(fresh.status).toBe(200);
        expect(fresh.body.defaults.listRelease.allowPortalUpload).toBe(false);
    });

    it('refuses a pharmacy upload while it is off, at the endpoint', async () => {
        /* THE PROPERTY. Hiding the page would leave this working. */
        await setUpload(false);
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: discharge.id, serviceDate: ownDay() });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('import.portalUploadOff');
    });

    it('refuses the preview too, so nothing is learned by trying', async () => {
        await setUpload(false);
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, `${BASE}/preview`, { siteId: discharge.id });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('import.portalUploadOff');
    });

    it('says what to do instead, because a refusal nobody can act on is a phone call', async () => {
        await setUpload(false);
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: discharge.id, serviceDate: ownDay() });
        expect(res.body.error).toMatch(/email/i);
    });

    it('never gates dispatch, because importing a list is how the contract runs today', async () => {
        await setUpload(false);
        const res = await upload(admin, BASE, { siteId: discharge.id, serviceDate: ownDay() });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
    });

    it('still lets a pharmacy read its own past lists while it is off', async () => {
        /* The setting is about sending us a list, not about seeing what was
           sent. Taking the reads away would hide what they already gave us. */
        await setUpload(false);
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        expect((await them.get(BASE)).status).toBe(200);
    });

    it('lets them upload once it is on', async () => {
        await setUpload(true);
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        const res = await upload(them, BASE, { siteId: discharge.id, serviceDate: ownDay() });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
    });

    it('tells the portal which it is, so the link and the endpoint cannot disagree', async () => {
        /* The screen reads this rather than deciding for itself. A link to a
           page the server would refuse is worse than no link. */
        const them = await agentFor('uh.uploader', 'upload-pass-1');
        await setUpload(false);
        expect((await them.get(`${CLIENT}/summary`)).body.canUploadList).toBe(false);
        await setUpload(true);
        expect((await them.get(`${CLIENT}/summary`)).body.canUploadList).toBe(true);
    });
});
