/* One search box, and what it is not allowed to look at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ABSENT COLUMN IS THE FEATURE.
 *
 * A term typed into a search box ends up in the URL, and URLs reach browser
 * history, proxies, referrer headers and anything that logs a request line. A
 * patient name that reaches those places has left this system in a way no
 * audit row records and no retention policy reaches. So the searchable
 * columns are an allow list and a patient name is not on it.
 *
 * The other half is that a search NARROWS. It is ANDed into a WHERE that
 * already carries the caller's scope, so a lead searching for the pharmacy
 * next door gets nothing rather than that pharmacy's day.
 *
 * Every name and address here is invented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { searchFragment, ORDER_SEARCH_COLUMNS } from '../src/modules/uh/search.ts';

const UH = '/api/projects/uh/uh';
const ORDERS = `${UH}/orders`;

let srv;
let admin;
let discharge;
let green;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    const sites = (await admin.get(`${UH}/sites`)).body;
    discharge = sites.find((s) => s.code === 'discharge');
    green = sites.find((s) => s.code === 'green');

    const make = async (siteId, recipientName, externalRef, serviceType = 'stat') => {
        const res = await admin.post(ORDERS).send({
            siteId, serviceType, recipientName, externalRef,
            addressLine: '9 Searchable Street', zip: '78215',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body;
    };
    await make(discharge.id, 'Search Patient Alpha', 'SRCH-1001');
    await make(green.id, 'Search Patient Beta', 'SRCH-2002', 'adhoc');
    await make(discharge.id, 'Underscore Patient', 'SRCH_3003');
});
afterAll(async () => { await srv.stop(); });

const found = async (q) => {
    const res = await admin.get(`${ORDERS}?q=${encodeURIComponent(q)}&limit=200`);
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    return res.body.orders;
};

describe('the fragment', () => {
    it('is null for an empty term, so a caller can tell no search from no results', () => {
        /* One of those is a list and the other is an empty state with a
           different message. */
        expect(searchFragment('', ORDER_SEARCH_COLUMNS)).toBeNull();
        expect(searchFragment('   ', ORDER_SEARCH_COLUMNS)).toBeNull();
        expect(searchFragment(undefined, ORDER_SEARCH_COLUMNS)).toBeNull();
    });

    it('never names a patient column, whatever it is asked for', () => {
        /* THE PROPERTY THE FILE EXISTS FOR, asserted against the generated
           SQL rather than against a list of fields in a comment. */
        const sql = searchFragment('anything', ORDER_SEARCH_COLUMNS).sql;
        for (const column of ['recipient_name', 'address_line', 'recipient_phone', 'city', 'zip']) {
            expect(sql, `the search must not look at ${column}`).not.toContain(column);
        }
    });

    it('only ever ORs within itself, so it cannot widen what it is added to', () => {
        const sql = searchFragment('green', ORDER_SEARCH_COLUMNS).sql;
        expect(sql.startsWith('(')).toBe(true);
        expect(sql.endsWith(')')).toBe(true);
        expect(sql).not.toMatch(/\bAND\b/);
    });
});

describe('what the box finds', () => {
    it('finds a delivery by the pharmacy reference', async () => {
        const rows = await found('SRCH-1001');
        expect(rows).toHaveLength(1);
        expect(rows[0].externalRef).toBe('SRCH-1001');
    });

    it('finds part of a reference, because somebody reads it out over a phone', async () => {
        const rows = await found('srch-2');
        expect(rows.map((r) => r.externalRef)).toContain('SRCH-2002');
    });

    it('finds the deliveries for a pharmacy by its name', async () => {
        /* The whole name rather than its first word: several University
           Health pharmacies share a first word, so a one-word term is a
           test about the fixture rather than about the search. */
        const rows = await found(green.name);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.siteId).toBe(green.id);
    });

    it('finds by status and by service level', async () => {
        expect((await found('ready')).length).toBeGreaterThan(0);
        const adhoc = await found('adhoc');
        expect(adhoc.length).toBeGreaterThan(0);
        for (const r of adhoc) expect(r.serviceType).toBe('adhoc');
    });

    it('treats an underscore in a reference as a character, not a wildcard', async () => {
        /* LIKE reads _ as "any single character", so without escaping,
           SRCH_3003 would also match SRCH-3003 and anything else shaped like
           it. The reference is the pharmacy's own handle for a row and has to
           find exactly that row. */
        const rows = await found('SRCH_3003');
        expect(rows).toHaveLength(1);
        expect(rows[0].externalRef).toBe('SRCH_3003');
    });

    it('finds nothing rather than everything when the term matches no column', async () => {
        /* A search that silently became "show me all of it" is how somebody
           reads a list they did not ask for and believes it was filtered. */
        const rows = await found('zzzz-no-such-thing');
        expect(rows).toHaveLength(0);
    });
});

describe('what the box will not find', () => {
    it('does not find a delivery by the patient name', async () => {
        /* Said as a test rather than as a comment, because the comment is
           what gets edited by somebody adding a column. */
        expect(await found('Search Patient Alpha')).toHaveLength(0);
        expect(await found('Alpha')).toHaveLength(0);
    });

    it('does not find one by street address', async () => {
        expect(await found('Searchable Street')).toHaveLength(0);
        expect(await found('78215')).toHaveLength(0);
    });
});

describe('a lead searching', () => {
    it('cannot reach the pharmacy next door with a search term', async () => {
        /* The search is ANDed into a WHERE that already carries the lead's
           own pharmacies, and it only ORs within itself, so the worst a term
           can do is match nothing. */
        const username = 'search.lead';
        await admin.post('/api/users').send({
            username, name: 'Search Lead', password: 'search-pass-1',
            role: 'staff',
        });
        await admin.put(`/api/users/${username}/memberships/uh`).send({
            role: 'lead', settings: { siteIds: [discharge.id] },
        });
        const lead = srv.agent();
        await lead.post('/api/login').send({ username, password: 'search-pass-1' });

        const res = await lead.get(`${ORDERS}?q=${encodeURIComponent(green.name)}&limit=200`);
        expect(res.status).toBe(200);
        for (const r of res.body.orders) {
            expect(r.siteId, 'a search must not reach past the scope').toBe(discharge.id);
        }
    });
});
