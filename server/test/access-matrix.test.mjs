/* Who may call what.
 *
 * Ticket 4.2. Every endpoint the application mounts, called by every kind of
 * caller, with the answer written down. The table below is the access control
 * matrix: it is the specification, and the test is the proof.
 *
 * Two rules make it work.
 *
 * ONE: authorization is asserted, never anything else. An allowed caller must
 * not be answered 401 or 403; a denied caller must be answered 401 or 403. The
 * ids are deliberately nonexistent and the bodies deliberately empty, so an
 * allowed caller usually gets 400 or 404 and that counts as a pass. What is
 * being tested is the gate, not the handler behind it.
 *
 * TWO, which falls out of one: a route must decide who may call it BEFORE it
 * decides whether the thing exists. A handler that answers 404 to a caller who
 * should have been refused has told them the id is free, and told the auditor
 * nothing. This test found exactly that in the manual event endpoint.
 *
 * The coverage guard at the bottom compares this table against the routes the
 * application actually mounts. A new endpoint fails the suite until somebody
 * writes down who is allowed to call it, which is the point.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';

const UH = '/api/projects/uh/uh';
const PASS = 'matrix-pass-31';

let srv;
/** principal -> supertest agent, plus `anon` for no session at all. */
const who = {};
/** principal -> the credentials to open a second session with. */
const CREDENTIALS = {};

/* Every caller the application can have. The names are used in the table. */
const PRINCIPALS = ['anon', 'outsider', 'viewer', 'courier', 'dispatcher', 'manager', 'projectAdmin', 'platformAdmin'];

/* Shorthand for the groups the table uses over and over. `platformAdmin` is a
 * member of every project at boot, so it appears in every project group. */
const EVERYONE = PRINCIPALS;
const SIGNED_IN = ['outsider', 'viewer', 'courier', 'dispatcher', 'manager', 'projectAdmin', 'platformAdmin'];
const PLATFORM_ADMIN = ['platformAdmin'];
const UH_MEMBER = ['viewer', 'courier', 'dispatcher', 'manager', 'projectAdmin', 'platformAdmin'];
const UH_STAFF = ['dispatcher', 'manager', 'projectAdmin', 'platformAdmin'];
const UH_STAFF_AND_COURIER = ['courier', 'dispatcher', 'manager', 'projectAdmin', 'platformAdmin'];
const UH_MANAGE = ['manager', 'projectAdmin', 'platformAdmin'];
const UH_CLIENT_VIEW = ['viewer', 'dispatcher', 'manager', 'projectAdmin', 'platformAdmin'];
const TVHS_MEMBER = ['outsider', 'platformAdmin'];
/* Three TVHS endpoints are for drivers and nobody else, checked by platform
 * role inside the handler. The platform administrator is refused them too. */
const TVHS_DRIVER = ['outsider'];

beforeAll(async () => {
    srv = await startServer();
    const admin = await srv.login('admin');

    /* One account per project role, plus a signed-in caller with no uh
       membership at all. That last one is the cross-project check: it holds a
       valid session for this application and must still be refused every uh
       endpoint. */
    const people = [
        ['matrix.viewer', 'client_viewer'],
        ['matrix.courier', 'courier'],
        ['matrix.dispatcher', 'dispatcher'],
        ['matrix.manager', 'ops_manager'],
        ['matrix.projectadmin', 'admin'],
    ];
    for (const [username, role] of people) {
        const created = await admin.post('/api/users').send({ username, name: username, password: PASS, role: 'staff' });
        expect(created.status, created.text).toBe(201);
        const member = await admin.put(`/api/users/${username}/memberships/uh`).send({ role, settings: {} });
        expect(member.status, member.text).toBe(200);
    }
    /* The outsider is the seeded TVHS driver: a real account, a valid session,
       and no membership of uh at all. Every uh row below is therefore also a
       cross-project check. */

    const signIn = async (username) => {
        const a = srv.agent();
        const res = await a.post('/api/login').send({ username, password: PASS });
        expect(res.status, `${username}: ${res.text}`).toBe(200);
        return a;
    };
    Object.assign(CREDENTIALS, {
        outsider: { username: srv.creds.south.username, password: srv.creds.south.password },
        viewer: { username: 'matrix.viewer', password: PASS },
        courier: { username: 'matrix.courier', password: PASS },
        dispatcher: { username: 'matrix.dispatcher', password: PASS },
        manager: { username: 'matrix.manager', password: PASS },
        projectAdmin: { username: 'matrix.projectadmin', password: PASS },
        platformAdmin: { username: srv.creds.admin.username, password: srv.creds.admin.password },
    });
    who.anon = srv.agent();
    who.outsider = await srv.login('south');
    who.viewer = await signIn('matrix.viewer');
    who.courier = await signIn('matrix.courier');
    who.dispatcher = await signIn('matrix.dispatcher');
    who.manager = await signIn('matrix.manager');
    who.projectAdmin = await signIn('matrix.projectadmin');
    who.platformAdmin = admin;
});
afterAll(async () => { await srv.stop(); });

/* Two kinds of row need care.
 *
 * SIGN_IN: the endpoint's whole job is to judge credentials, so a 401 from it
 * means "those are wrong", not "you may not ask". The assertion for these is
 * that the caller reached the handler: never 403, and never the framework's
 * own "Not authenticated".
 *
 * LOGOUT: calling it would end the session of the agent that called it and
 * quietly turn every later row into a 401. It is called on a throwaway
 * session instead.
 */
const SIGN_IN = 'sign-in';
const LOGOUT = 'logout';

/* ------------------------------------------------------------- the matrix */

/* [method, path, allowed principals, note]
 *
 * Ids are nonexistent on purpose (see the header). Bodies are empty on
 * purpose. Anything that is not 401 or 403 counts as allowed. */
const MATRIX = [
    /* --- sign-in and public surface. Open by necessity: a person who cannot
       sign in yet has no session to be judged by. Each one is here so that
       "public" is a recorded decision rather than a missing gate. */
    ['POST', '/api/login', EVERYONE, 'sign in', SIGN_IN],
    ['POST', '/api/login/pin', EVERYONE, 'PIN sign-in, throttled', SIGN_IN],
    ['POST', '/api/login/pin/setup', EVERYONE, 'password required in the body', SIGN_IN],
    ['GET', '/api/login/device', EVERYONE, 'is this phone enrolled', SIGN_IN],
    ['POST', '/api/login/device', EVERYONE, 'PIN sign-in from an enrolled phone, throttled', SIGN_IN],
    ['POST', '/api/devices/enrol', EVERYONE, 'password required in the body', SIGN_IN],
    ['GET', '/api/session', EVERYONE, 'who am I, or nobody', SIGN_IN],
    ['POST', '/api/logout', EVERYONE, 'ending a session needs no permission', LOGOUT],
    ['GET', '/api/drivers/list', EVERYONE, 'names and whether a PIN is set, for the picker'],
    ['GET', '/api/login/projects', EVERYONE, 'project names only'],
    ['GET', '/api/config', EVERYONE, 'timezone and date'],
    ['GET', '/health', EVERYONE, 'liveness'],

    /* --- a caller acting on themselves */
    ['GET', '/api/me/projects', SIGNED_IN, 'my memberships'],
    ['GET', '/api/me/sessions', SIGNED_IN, 'my live devices'],
    ['DELETE', '/api/me/sessions/others', SIGNED_IN, 'sign out everywhere else'],
    ['DELETE', '/api/me/sessions/nope', SIGNED_IN, 'sign out one of mine'],
    ['GET', '/api/devices', SIGNED_IN, 'my enrolled phones'],
    ['DELETE', '/api/devices/999999', SIGNED_IN, 'owner or admin, checked in the handler'],

    /* --- the platform administrator. A project role of admin is not this:
       matrix.projectadmin runs the uh contract and still cannot read the user
       directory or the audit log. */
    ['GET', '/api/users', PLATFORM_ADMIN, 'the directory'],
    ['POST', '/api/users', PLATFORM_ADMIN, 'create a person'],
    ['GET', '/api/users/nobody', PLATFORM_ADMIN, 'one person'],
    ['PATCH', '/api/users/nobody', PLATFORM_ADMIN, 'change a person'],
    ['POST', '/api/users/nobody/password', PLATFORM_ADMIN, 'reset a password'],
    ['PUT', '/api/users/nobody/pin', PLATFORM_ADMIN, 'set a PIN'],
    ['DELETE', '/api/users/nobody/pin', PLATFORM_ADMIN, 'clear a PIN'],
    ['PUT', '/api/users/nobody/memberships/uh', PLATFORM_ADMIN, 'grant a project role'],
    ['DELETE', '/api/users/nobody/memberships/uh', PLATFORM_ADMIN, 'remove one'],
    ['GET', '/api/users/nobody/sessions', PLATFORM_ADMIN, 'somebody else s devices'],
    ['DELETE', '/api/users/nobody/sessions', PLATFORM_ADMIN, 'revoke them all'],
    ['DELETE', '/api/users/nobody/sessions/nope', PLATFORM_ADMIN, 'revoke one'],
    ['GET', '/api/users/nobody/devices', PLATFORM_ADMIN, 'somebody else s phones'],
    ['GET', '/api/audit', PLATFORM_ADMIN, 'the audit log'],

    /* --- a project, and the TVHS module inside it. The uh principals are not
       members of tvhs, so every row below is also a cross-project check. */
    ['GET', '/api/projects/tvhs', TVHS_MEMBER, 'one project, members only'],
    ['GET', '/api/projects/tvhs/tvhs/routes', TVHS_MEMBER, ''],
    ['POST', '/api/projects/tvhs/tvhs/checkin', TVHS_DRIVER, 'drivers clock in; nobody else, not even an admin'],
    ['GET', '/api/projects/tvhs/tvhs/checkin', TVHS_MEMBER, ''],
    ['GET', '/api/projects/tvhs/tvhs/checkins/history', TVHS_MEMBER, ''],
    ['GET', '/api/projects/tvhs/tvhs/logs', TVHS_MEMBER, ''],
    ['POST', '/api/projects/tvhs/tvhs/logs', TVHS_DRIVER, 'a driver files their own log'],
    ['DELETE', '/api/projects/tvhs/tvhs/logs', TVHS_DRIVER, 'and corrects it'],
    ['GET', '/api/projects/tvhs/tvhs/logs/export', TVHS_MEMBER, ''],
    ['GET', '/api/projects/tvhs/tvhs/admin/checkins', PLATFORM_ADMIN, 'platform admin, not a tvhs role'],
    ['GET', '/api/projects/tvhs/tvhs/admin/checkins/history', PLATFORM_ADMIN, ''],
    ['GET', '/api/projects/tvhs/tvhs/admin/logs', PLATFORM_ADMIN, ''],
    ['GET', '/api/projects/tvhs/tvhs/admin/stats', PLATFORM_ADMIN, ''],
    ['GET', '/api/projects/tvhs/tvhs/admin/drivers', PLATFORM_ADMIN, ''],
    ['GET', '/api/projects/tvhs/tvhs/admin/export', PLATFORM_ADMIN, ''],

    /* --- project settings: business hours, SLA windows, the operating
       parameters of the contract. Read by the people who run it. A client
       viewer has no business knowing what our internal goal is. */
    ['GET', '/api/projects/uh/settings', UH_STAFF_AND_COURIER, 'the courier app reads business hours'],
    ['PATCH', '/api/projects/uh/settings', UH_MANAGE, ''],

    /* --- pharmacies. Addresses and contacts of University Health sites. */
    ['GET', `${UH}/sites`, UH_STAFF_AND_COURIER, 'a courier needs the pickup address'],
    ['POST', `${UH}/sites`, UH_MANAGE, ''],
    ['GET', `${UH}/sites/999999`, UH_STAFF_AND_COURIER, ''],
    ['PATCH', `${UH}/sites/999999`, UH_MANAGE, ''],
    ['DELETE', `${UH}/sites/999999`, UH_MANAGE, ''],

    /* --- the price schedule. What we charge, which is ours and the client
       finance team's, and nobody else's. */
    ['GET', `${UH}/pricing`, UH_STAFF, ''],
    ['GET', `${UH}/pricing/zones`, UH_STAFF, ''],
    ['POST', `${UH}/pricing/quote`, UH_STAFF, ''],

    /* --- the daily list. A whole pharmacy run of patients in one file. */
    ['POST', `${UH}/imports/preview`, UH_STAFF, ''],
    ['POST', `${UH}/imports`, UH_STAFF, ''],
    ['GET', `${UH}/imports`, UH_STAFF, 'reading one discloses what uploading one did'],
    ['GET', `${UH}/imports/999999`, UH_STAFF, ''],
    ['GET', `${UH}/imports/mappings/999999`, UH_STAFF, ''],
    ['DELETE', `${UH}/imports/mappings/999999`, UH_STAFF, ''],

    /* --- orders: patient names and addresses. */
    ['POST', `${UH}/orders`, UH_STAFF, 'a manual order'],
    ['GET', `${UH}/orders`, UH_STAFF_AND_COURIER, 'couriers are narrowed to their own work inside'],
    ['GET', `${UH}/orders/summary`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/orders/999999`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/orders/999999/pod.pdf`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/orders/999999/events`, UH_STAFF_AND_COURIER, 'which event is then gated by role again'],

    /* --- the door. */
    ['POST', `${UH}/orders/999999/arrive`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/orders/999999/deliver`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/orders/999999/doorstep`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/orders/999999/attempt`, UH_STAFF_AND_COURIER, ''],

    /* --- runs and the pharmacy counter. */
    ['POST', `${UH}/runs`, UH_STAFF, ''],
    ['GET', `${UH}/runs`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/runs/mine`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/runs/999999`, UH_STAFF_AND_COURIER, ''],
    ['PATCH', `${UH}/runs/999999`, UH_STAFF, ''],
    ['POST', `${UH}/runs/999999/stops`, UH_STAFF, ''],
    ['DELETE', `${UH}/runs/999999/stops/999999`, UH_STAFF, ''],
    ['PUT', `${UH}/runs/999999/sequence`, UH_STAFF, ''],
    ['POST', `${UH}/runs/999999/sequence/auto`, UH_STAFF, ''],
    ['GET', `${UH}/runs/999999/pickup`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/runs/999999/pickup`, UH_STAFF_AND_COURIER, ''],

    /* --- medication coming back. */
    ['GET', `${UH}/returns`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/returns`, UH_STAFF_AND_COURIER, ''],

    /* --- the dispatch board: every patient address in the contract on one
       screen. Couriers see their own run instead. */
    ['GET', `${UH}/board`, UH_STAFF, ''],

    /* --- what the pharmacy sees. The only endpoints a client viewer may
       reach, and each one narrows to the sites that viewer is scoped to. */
    ['GET', `${UH}/client/summary`, UH_CLIENT_VIEW, ''],
    ['GET', `${UH}/client/orders`, UH_CLIENT_VIEW, ''],
    ['GET', `${UH}/client/orders/999999`, UH_CLIENT_VIEW, ''],
    ['GET', `${UH}/client/orders/999999/pod.pdf`, UH_CLIENT_VIEW, ''],

    /* --- performance against the contract. */
    ['GET', `${UH}/reports/sla`, UH_STAFF, ''],
    ['GET', `${UH}/reports/sla.xlsx`, UH_STAFF, ''],

    /* --- money. Reading an invoice is the contract's revenue; issuing one is
       a document that leaves the building. */
    ['GET', `${UH}/invoices`, UH_STAFF, ''],
    ['GET', `${UH}/invoices/999999`, UH_STAFF, ''],
    ['GET', `${UH}/invoices/999999/invoice.xlsx`, UH_STAFF, ''],
    ['GET', `${UH}/invoices/999999/invoice.pdf`, UH_STAFF, ''],
    ['POST', `${UH}/invoices`, UH_MANAGE, ''],
    ['POST', `${UH}/invoices/999999/adjustments`, UH_MANAGE, ''],
    ['DELETE', `${UH}/invoices/999999/adjustments/999999`, UH_MANAGE, ''],
    ['POST', `${UH}/invoices/999999/issue`, UH_MANAGE, ''],
    ['POST', `${UH}/invoices/999999/paid`, UH_MANAGE, ''],
    ['POST', `${UH}/invoices/999999/void`, UH_MANAGE, ''],

    /* --- doorstep photographs, which are PHI in a bucket. */
    ['POST', `${UH}/files`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/files`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/files/999999`, UH_STAFF_AND_COURIER, ''],
    ['POST', `${UH}/files/999999/stored`, UH_STAFF_AND_COURIER, ''],
    ['GET', `${UH}/files/status/check`, UH_STAFF_AND_COURIER, ''],
];

const REFUSED = [401, 403];
/* What the guards say when they turn somebody away. A sign-in endpoint that
 * answers 401 says something else entirely. */
const GUARD_MESSAGES = ['Not authenticated', 'Not a member of this project', 'Admin access required', 'Requires project role'];

async function callAs(principal, method, path, kind) {
    /* Logout would end the caller's session and make every later row a 401,
       so it is answered on a session nobody else is using. */
    const agent = kind === LOGOUT && principal !== 'anon' ? await freshSession(principal) : who[principal];
    const req = agent[method.toLowerCase()](path);
    return method === 'GET' || method === 'DELETE' ? req.send() : req.send({});
}

async function freshSession(principal) {
    const a = srv.agent();
    await a.post('/api/login').send(CREDENTIALS[principal]);
    return a;
}

function reachedTheHandler(res) {
    const body = String(res.text ?? '');
    if (res.status === 403) return false;
    if (res.status === 401 && GUARD_MESSAGES.some((m) => body.includes(m))) return false;
    return true;
}

describe('the access control matrix', () => {
    for (const [method, path, allowed, note, kind] of MATRIX) {
        const denied = PRINCIPALS.filter((p) => !allowed.includes(p));
        const title = `${method} ${path}${note ? ` (${note})` : ''}`;

        it(`${title}: ${allowed.join(', ')}`, async () => {
            for (const principal of allowed) {
                const res = await callAs(principal, method, path, kind);
                const why = `${principal} should be allowed ${method} ${path}, got ${res.status} ${res.text?.slice(0, 120)}`;
                if (kind === SIGN_IN) expect(reachedTheHandler(res), why).toBe(true);
                else expect(REFUSED, why).not.toContain(res.status);
            }
            for (const principal of denied) {
                const res = await callAs(principal, method, path, kind);
                /* A denied caller must be refused, not answered. 404 here means
                   the route decided what exists before it decided who asked. */
                expect(REFUSED, `${principal} should be refused ${method} ${path}, got ${res.status} ${res.text?.slice(0, 120)}`)
                    .toContain(res.status);
            }
        });
    }
});

/* --------------------------------------------------------------- coverage */

describe('the matrix covers the application', () => {
    it('has a row for every route mounted', () => {
        const mounted = [];
        const walk = (layer) => {
            if (layer.route) {
                for (const m of Object.keys(layer.route.methods)) {
                    if (m !== '_all') mounted.push(`${m.toUpperCase()} ${layer.route.path}`);
                }
                return;
            }
            if (layer.handle?.stack) for (const l of layer.handle.stack) walk(l);
        };
        for (const l of (srv.app.router?.stack ?? [])) walk(l);

        /* Express 5 does not keep the mount prefix on a layer, so the
           comparison is on method and the path the router itself declares.
           That is enough: adding, removing or renaming any endpoint changes
           this multiset and brings somebody back to the table above. */
        const suffix = (path) => {
            let p = path;
            // Strip the mount, so what is left is what the router declares.
            p = p.replace(/^\/api\/projects\/[a-z]+\/tvhs(?=\/|$)/, '');
            p = p.replace(/^\/api\/projects\/[a-z]+\/uh\/[a-z-]+(?=\/|$)/, '');
            p = p.replace(/^\/api\/projects\/[a-z]+\/settings(?=\/|$)/, '');
            p = p.replace(/^\/api\/projects\/[a-z]+$/, '/api/projects/:p');
            // A parameter is a parameter, however it is named or filled in.
            p = p.replace(/\/memberships\/[a-z]+/g, '/memberships/:p');
            p = p.replace(/\/:[A-Za-z]+/g, '/:p');
            p = p.replace(/\/(999999|nope|nobody)(?=\/|$)/g, '/:p');
            return p === '' ? '/' : p;
        };

        const tally = (list) => {
            const m = new Map();
            for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
            return m;
        };

        // The synthetic error routes exist only under NODE_ENV=test.
        const key = (entry) => {
            const [method, ...rest] = entry.split(' ');
            return `${method} ${suffix(rest.join(' '))}`;
        };
        const actual = tally(mounted.filter((r) => !r.includes('/api/_test/')).map(key));
        const declared = tally(MATRIX.map(([method, path]) => key(`${method} ${path}`)));

        const missing = [];
        for (const [key, count] of actual) {
            const have = declared.get(key) ?? 0;
            if (have < count) missing.push(`${key}: mounted ${count}, in the matrix ${have}`);
        }
        const extra = [];
        for (const [key, count] of declared) {
            const have = actual.get(key) ?? 0;
            if (count > have) extra.push(`${key}: in the matrix ${count}, mounted ${have}`);
        }

        expect(missing, 'endpoints with no row in the access matrix: add one saying who may call them').toEqual([]);
        expect(extra, 'rows in the access matrix for endpoints that no longer exist: remove them').toEqual([]);
    });
});
