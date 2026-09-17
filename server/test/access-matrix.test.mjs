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
/* Driver applications hang off the project, not off the uh module: they are
   a platform concern that every future contract will want. */
const UH_PROJECT = '/api/projects/uh';
const PASS = 'matrix-pass-31';

let srv;
/** principal -> supertest agent, plus `anon` for no session at all. */
const who = {};
/** principal -> the credentials to open a second session with. */
const CREDENTIALS = {};

/* Every caller the application can have. The names are used in the table.
 *
 * Three project roles since ticket 5.12, so three project principals plus the
 * two that hold no uh membership. `dispatcher` and `manager` used to be here
 * as separate people; they are administrators now. */
/* `applicant` is the DoorDash model's cost, pinned. Since ticket 6.1 signup
   creates a real account with a real password for somebody nobody has vetted,
   and the property that makes that safe is that it belongs to no project. It
   is in this table so that every row below is also the question "can an
   unvetted stranger reach this", answered for the whole application at once. */
const PRINCIPALS = ['anon', 'applicant', 'outsider', 'pharmacy', 'courier', 'projectAdmin', 'platformAdmin'];

/* Shorthand for the groups the table uses over and over. `platformAdmin` is a
 * member of every project at boot, so it appears in every project group. */
const EVERYONE = PRINCIPALS;
const SIGNED_IN = ['applicant', 'outsider', 'pharmacy', 'courier', 'projectAdmin', 'platformAdmin'];
const PLATFORM_ADMIN = ['platformAdmin'];
const UH_MEMBER = ['pharmacy', 'courier', 'projectAdmin', 'platformAdmin'];
/* UH_MANAGE used to be narrower than UH_STAFF: editing the rate card and
 * issuing an invoice were an ops manager's, and a dispatcher was refused
 * them. The merge in 5.12 made those the same set of people, so there is one
 * name for it now rather than two identical lists pretending otherwise. */
const UH_STAFF = ['projectAdmin', 'platformAdmin'];
const UH_STAFF_AND_COURIER = ['courier', 'projectAdmin', 'platformAdmin'];
const UH_MANAGE = UH_STAFF;
const UH_CLIENT_VIEW = ['pharmacy', 'projectAdmin', 'platformAdmin'];
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
        ['matrix.pharmacy', 'pharmacy'],
        ['matrix.courier', 'courier'],
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
        pharmacy: { username: 'matrix.pharmacy', password: PASS },
        courier: { username: 'matrix.courier', password: PASS },
        projectAdmin: { username: 'matrix.projectadmin', password: PASS },
        platformAdmin: { username: srv.creds.admin.username, password: srv.creds.admin.password },
    });
    /* An applicant: signs up through the public form, so they hold a real
       credential and no membership anywhere. */
    const applicantEmail = 'matrix.applicant@example.com';
    const applied = await srv.agent().post('/api/driver-applications').send({
        projectCode: 'uh', name: 'Matrix Applicant', email: applicantEmail,
        phone: '210-555-0400', password: PASS,
    });
    expect(applied.status, applied.text).toBe(202);
    Object.assign(CREDENTIALS, { applicant: { username: applicantEmail, password: PASS } });

    who.anon = srv.agent();
    who.applicant = await signIn(applicantEmail);
    who.outsider = await srv.login('south');
    who.pharmacy = await signIn('matrix.pharmacy');
    who.courier = await signIn('matrix.courier');
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
    /* The one thing an unvetted account may read, and only ever their own:
       the query is keyed on the session's username, so there is no id to
       change. Anybody without an application gets a 404. */
    ['GET', '/api/me/application', SIGNED_IN, 'my own application status'],
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

    /* --- driver applications (tickets 6.1 and 6.2).
     *
     * The public one is EVERYONE on purpose and is the only write in this
     * whole table a stranger may make. It can create an application and
     * nothing else: no user, no session, no membership. The rest of the
     * flow, including the approval that does create an account, is staff. */
    ['POST', '/api/driver-applications', EVERYONE, 'apply to drive: public, and creates nothing that can sign in'],
    ['GET', `${UH_PROJECT}/driver-applications`, UH_STAFF, 'the application queue'],
    ['GET', `${UH_PROJECT}/driver-applications/999999`, UH_STAFF, 'one application'],
    ['PUT', `${UH_PROJECT}/driver-applications/999999/checks/nope`, UH_STAFF, 'record an onboarding check'],
    ['POST', `${UH_PROJECT}/driver-applications/999999/approve`, UH_STAFF, 'approve: the only door to an account'],
    ['POST', `${UH_PROJECT}/driver-applications/999999/reject`, UH_STAFF, 'reject, with a reason'],

    /* --- retention (ticket 4.6). A platform-wide policy, and a purge that
       deletes patient records, so the same gate as the audit log. */
    ['GET', '/api/retention', PLATFORM_ADMIN, 'the policy and what is flagged'],
    ['POST', '/api/retention/sweep', PLATFORM_ADMIN, 'count now'],
    ['POST', '/api/retention/purge', PLATFORM_ADMIN, 'remove a category, by approved count'],

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

    /* --- address lookup (ticket 1.4). Reading it shows the pharmacies and
       what has been spent; running it spends money and discloses an address
       to a third party, so it takes the role that manages the contract. */
    ['GET', `${UH}/geocode`, UH_STAFF, 'what is located and what it has cost'],
    ['POST', `${UH}/geocode/sites`, UH_MANAGE, 'look up the pharmacies'],
    ['POST', `${UH}/geocode/mileage`, UH_MANAGE, 'measure out-of-area miles, which decides what is billed'],

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
    ['GET', `${UH}/orders/999999/directions`, UH_STAFF_AND_COURIER, ''],
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

    /* --- shifts (ticket 6.3). A courier starts and ends their own; only
       dispatch ends somebody else's, which is the escape hatch for a driver
       who cannot hand packages back because the pharmacy has shut. */
    ['POST', `${UH}/shifts/start`, UH_STAFF_AND_COURIER, 'go on shift'],
    ['POST', `${UH}/shifts/end`, UH_STAFF_AND_COURIER, 'go off shift'],
    ['GET', `${UH}/shifts/mine`, UH_STAFF_AND_COURIER, 'am I on shift, and what am I still carrying'],
    ['GET', `${UH}/shifts`, UH_STAFF, 'who is out there'],
    ['POST', `${UH}/shifts/999999/end`, UH_STAFF, "end somebody else's shift"],

    /* --- asking for work (tickets 6.4 and 6.5). A courier browses and asks;
       only dispatch decides, and only dispatch runs the sweep. */
    ['GET', `${UH}/requests/available`, UH_STAFF_AND_COURIER, 'what can I ask for: no patient names, no street addresses'],
    ['POST', `${UH}/requests`, UH_STAFF_AND_COURIER, 'ask for some stops'],
    ['GET', `${UH}/requests/mine`, UH_STAFF_AND_COURIER, 'what did I ask for'],
    ['DELETE', `${UH}/requests/999999`, UH_STAFF_AND_COURIER, 'never mind'],
    ['GET', `${UH}/requests`, UH_STAFF, 'the queue'],
    ['POST', `${UH}/requests/999999/approve`, UH_STAFF, 'yes'],
    ['POST', `${UH}/requests/999999/deny`, UH_STAFF, 'no, and why'],
    ['POST', `${UH}/requests/sweep`, UH_STAFF, 'hand out what nobody claimed'],

    /* --- tracking (tickets 6.6 and 6.7). A courier posts their own fixes and
       can read nobody's track, not even their own: a map of where they were
       all day is a thing to be asked for, not a screen to browse. */
    ['POST', `${UH}/tracking`, UH_STAFF_AND_COURIER, 'send my own fixes, only while on shift'],
    ['GET', `${UH}/tracking/live`, UH_STAFF, 'who is where, now, with the age of each fix'],
    ['GET', `${UH}/tracking/999999`, UH_STAFF, "one shift's track, and it writes an audit row"],

    /* --- being told (ticket 6.8). Every member reads their own and only
       their own: the query is keyed on the session, so there is no id to
       change. A phone belongs to a person, so push devices are not scoped to
       a project at all. */
    ['GET', `${UH}/notifications`, UH_MEMBER, 'what I was told'],
    ['POST', `${UH}/notifications/read`, UH_MEMBER, 'mark mine read'],
    ['POST', '/api/me/push-devices', SIGNED_IN, 'this phone will take push'],
    ['DELETE', '/api/me/push-devices/999999', SIGNED_IN, 'it will not any more'],
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

    /* --- the shadow week's log (ticket 5.2). A courier can report what they
       see at the door; reviewing and closing is a judgement about the
       contract and is not theirs to make. */
    ['POST', `${UH}/discrepancies`, UH_STAFF_AND_COURIER, 'anybody who notices'],
    ['GET', `${UH}/discrepancies`, UH_STAFF, 'the log'],
    ['GET', `${UH}/discrepancies/summary`, UH_STAFF, 'the go-live question'],
    ['PATCH', `${UH}/discrepancies/999999`, UH_STAFF, 'close one'],

    /* --- go-live (ticket 5.3). Reading the readiness check is for anybody
       running the contract; recording a report as sent to University Health
       is a statement to the client and belongs to the people accountable for
       one. */
    ['GET', `${UH}/go-live`, UH_STAFF, 'what is in the way'],

    /* --- performance against the contract. */
    ['GET', `${UH}/reports/sent`, UH_STAFF, 'what we have told University Health'],
    ['POST', `${UH}/reports/sent`, UH_MANAGE, 'record the daily report as sent'],
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
            p = p.replace(/^\/api\/projects\/[a-z]+\/driver-applications(?=\/|$)/, '');
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
