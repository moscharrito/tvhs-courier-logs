import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { requestId } from '../src/core/http/request.ts';
import express from 'express';
import request from 'supertest';
import { createHealthRouter } from '../src/core/http/health.ts';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

const requestLogs = () => srv.logs.filter((l) => l.msg === 'request');

describe('GET /health', () => {
    it('is public and reports the database, migrations, uptime and version', async () => {
        const res = await srv.agent().get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
        expect(res.body.migrations).toBeGreaterThanOrEqual(5);
        expect(typeof res.body.uptimeSeconds).toBe('number');
        expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(JSON.stringify(res.body)).not.toMatch(/secret|token|password|file:/i);
    });

    it('says whether the background timers are running', async () => {
        /* "Is unclaimed work actually being escalated" could previously only
           be answered by scrolling a host's log for one boot line, and an
           environment variable that silently failed to arrive is exactly the
           kind of fault that stays undetected for weeks. The thing it
           switches off is a promise made to a hospital. */
        const res = await srv.agent().get('/health');
        expect(res.body.scheduler).toBeTruthy();
        // Tests start without an interval, so it reports the honest answer.
        expect(res.body.scheduler.sweep).toBe('off');
        expect(res.body.scheduler.mail).toBe('off');
        /* Texting was reported nowhere but the boot log, so "are patients
           being told anything" could not be answered without the Render
           dashboard open. */
        expect(res.body.scheduler.sms).toBe('off');
        /* Off means a doorstep delivery is refused outright rather than
           recorded without its photograph. The blueprint no longer records
           whether this is on, so this endpoint is where it is answered. */
        expect(res.body.files).toBe('off');
    });

    it('reports the interval when the sweep is switched on', async () => {
        /* The router directly rather than a second booted server: the test
           helper allows one per file, and the thing worth pinning here is the
           mapping from configuration to the word somebody reads over curl. */
        const app = express();
        app.use(createHealthRouter({
            client: srv.core.client,
            version: '1.2.3',
            sweepIntervalSeconds: 120,
            mailConfigured: true,
            filesConfigured: true,
            smsConfigured: true,
        }));
        const res = await request(app).get('/health');
        expect(res.body.scheduler).toEqual({ sweep: 'every 120s', mail: 'configured', sms: 'configured' });
        expect(res.body.files).toBe('configured');
    });

    /* ─────────────────────────────────────────────────────────────────────
     * THE DAY A DEAD MAILER LOOKED LIKE A QUIET SUNDAY.
     *
     * Production ran with SES answering 403 to every send -- the credentials
     * were refused, so no password reset code could reach anybody -- and
     * this endpoint said "configured, nothing sent yet" the whole time.
     * mailConfigured only means the values are present; mailRecent counts
     * notification rows that FINISHED and a refused send leaves its row
     * pending; and a reset code is not a notification row at all.
     *
     * What found it was somebody testing the reset form, which is the "one
     * line in a log" problem the sms and tracking fields exist to end.
     * ───────────────────────────────────────────────────────────────────── */
    const withMail = (attempts, recent = 'configured, nothing sent yet', configured = true) => {
        const app = express();
        app.use(createHealthRouter({
            client: srv.core.client,
            version: '1.2.3',
            mailConfigured: configured,
            mailRecent: async () => recent,
            mailAttempts: () => attempts,
        }));
        return request(app).get('/health');
    };

    it('says a mailer SES is refusing is refusing, not quiet', async () => {
        const res = await withMail({ attempted: 2, failing: 2, lastError: '403 AccessDeniedException', lastAttemptAt: new Date().toISOString() });
        expect(res.body.scheduler.mail).toMatch(/^REFUSING EVERY SEND/);
        /* The error TYPE, because it names the job: a wrong key id, a wrong
           secret and a missing ses:SendEmail are all 403 and all different
           work. The precedent is the files field reporting S3's own code. */
        expect(res.body.scheduler.mail).toContain('403 AccessDeniedException');
        expect(res.body.scheduler.mail).toContain('2 in a row');
    });

    it('puts the refusal ahead of the row count, which cannot know about it', async () => {
        /* A reset code is not a notification row, so outbox.ts would answer
           "nothing sent yet" however many resets SES had just thrown out. */
        const res = await withMail(
            { attempted: 9, failing: 9, lastError: '403 SignatureDoesNotMatch', lastAttemptAt: new Date().toISOString() },
            'configured, nothing sent yet',
        );
        expect(res.body.scheduler.mail).not.toContain('nothing sent yet');
        expect(res.body.scheduler.mail).toContain('SignatureDoesNotMatch');
    });

    it('stops describing a cleared-away failure in the present tense', async () => {
        /* `failing` only returns to zero when a send SUCCEEDS. Clear away
           the queue that was failing and nothing is attempted at all, so
           the count freezes and this line went on announcing "REFUSING
           EVERY SEND: 25 in a row" over a mailer nobody was asking to send
           anything. That happened, and the obvious reading was that the
           clearing had not worked. */
        const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const res = await withMail({
            attempted: 25, failing: 25, lastError: '400 MessageRejected', lastAttemptAt: anHourAgo,
        });
        expect(res.body.scheduler.mail).not.toMatch(/REFUSING EVERY SEND/);
        expect(res.body.scheduler.mail).toMatch(/last send refused 60 minutes ago/);
        expect(res.body.scheduler.mail, 'still says what it was').toContain('400 MessageRejected');
        expect(res.body.scheduler.mail, 'and that nothing has been tried since').toContain('nothing tried since');
    });

    it('still shouts while the refusals are actually happening', async () => {
        /* The other half. A mailer failing right now must not be softened
           into a historical note, which would be the same mistake wearing
           the opposite hat. */
        const justNow = new Date(Date.now() - 60 * 1000).toISOString();
        const res = await withMail({
            attempted: 25, failing: 25, lastError: '400 MessageRejected', lastAttemptAt: justNow,
        });
        expect(res.body.scheduler.mail).toMatch(/^REFUSING EVERY SEND/);
    });

    it('stops saying it the moment one send works', async () => {
        const res = await withMail({ attempted: 4, failing: 0, lastError: null, lastAttemptAt: new Date().toISOString() });
        expect(res.body.scheduler.mail).not.toMatch(/REFUSING/);
        /* And "nothing sent yet" would now be false: this process has put
           four through and they were accepted. */
        expect(res.body.scheduler.mail).toBe('configured, 4 sent this boot');
    });

    it('leaves "nothing sent yet" alone when nothing has in fact been tried', async () => {
        /* A quiet Sunday is still a real answer and must not read as a
           fault. The whole point is telling the two apart. */
        const res = await withMail({ attempted: 0, failing: 0, lastError: null, lastAttemptAt: null });
        expect(res.body.scheduler.mail).toBe('configured, nothing sent yet');
    });

    it('does not contradict itself when the sweep has sent something recently', async () => {
        const res = await withMail({ attempted: 3, failing: 0, lastError: null, lastAttemptAt: new Date().toISOString() }, 'sending');
        expect(res.body.scheduler.mail).toBe('sending');
    });

    it('still says off when email is not configured at all', async () => {
        /* available is checked first and nothing below can override it: a
           mailer with no credentials has not been refused, it has not been
           asked. */
        const res = await withMail({ attempted: 0, failing: 0, lastError: null, lastAttemptAt: null }, 'sending', false);
        expect(res.body.scheduler.mail).toBe('off');
    });

    it('names the fault without naming the endpoint, the key or the recipient', async () => {
        /* The rule at the top of health.ts. An AWS error type is a fixed
           string from a published list; a hostname, a region, an address and
           a key id are not allowed on a public endpoint at any time. */
        const res = await withMail({ attempted: 1, failing: 1, lastError: 'could not reach SES', lastAttemptAt: new Date().toISOString() });
        const body = JSON.stringify(res.body);
        expect(res.body.scheduler.mail).toContain('could not reach SES');
        expect(body).not.toMatch(/amazonaws|\.com|@|us-[a-z]+-\d|AKIA/i);
    });

    it('says whether the query planner has the statistics it needs', async () => {
        /* Those statistics decide whether the order detail page reads four
           custody rows or walks every event in the project: 0.5 ms against
           84 ms on a month of volume. PRAGMA optimize is allowed to fail on a
           hosted database and does so silently, so the only answer to "is the
           planner guessing?" was one line in a boot log, which is no answer
           at all to anybody without the dashboard. Same reason sms is here. */
        const res = await srv.agent().get('/health');
        expect(['ok', 'missing', 'unknown']).toContain(res.body.statistics);
    });

    it('reports unknown rather than ok before the first optimise has run', async () => {
        /* The boot ordering: the health router is built before the first
           optimise reports, so there is a window with no answer. Saying "ok"
           in it would be a guess, and a guess is what this field exists to
           remove. */
        const app = express();
        app.use(createHealthRouter({ client: srv.core.client, version: '1.2.3' }));
        const res = await request(app).get('/health');
        expect(res.body.statistics).toBe('unknown');
    });

    it('reports what the last optimise found, not what it hopes', async () => {
        const app = express();
        let state = 'ok';
        app.use(createHealthRouter({
            client: srv.core.client, version: '1.2.3', statistics: () => state,
        }));
        expect((await request(app).get('/health')).body.statistics).toBe('ok');
        state = 'missing';
        expect((await request(app).get('/health')).body.statistics).toBe('missing');
    });

    it('says whether a courier can be tracked at all, because off is silent', async () => {
        /* The failure this closes. With no retention period the ingest
           endpoint refuses every batch with 503 tracking.retentionUndecided,
           and trace.ts treats that as a PERMANENT stop -- so tracking does
           not degrade, it silently does not exist. render.yaml declaring the
           variable is not proof the running process received it, and the only
           thing that said otherwise was a line in the boot log. */
        const app = express();
        app.use(createHealthRouter({ client: srv.core.client, version: '1.2.3' }));
        expect((await request(app).get('/health')).body.tracking).toMatch(/^off/);

        const on = express();
        on.use(createHealthRouter({
            client: srv.core.client, version: '1.2.3', trackingRetentionDays: 7,
        }));
        const body = (await request(on).get('/health')).body;
        expect(body.tracking).toMatch(/^on/);
        /* The number matters: "on" without it would be the same empty
           reassurance that files: "configured" gave for weeks. */
        expect(body.tracking).toMatch(/7 days/);
    });

    it('says only the one word, never which tables', async () => {
        /* The rule at the top of health.ts forbids a count of anything in the
           database or any word that came from a row. Which tables lack
           statistics is both: a count, and a map of the schema. The boot log
           keeps that detail for whoever holds the log. */
        const app = express();
        app.use(createHealthRouter({
            client: srv.core.client, version: '1.2.3', statistics: () => 'missing',
        }));
        const body = JSON.stringify((await request(app).get('/health')).body);
        for (const table of ['custody_events', 'run_stops', 'orders', 'packages']) {
            expect(body).not.toContain(table);
        }
    });

    it('never puts a hostname, a region or an address on a public endpoint', async () => {
        /* The rule for this endpoint is not "is it secret" but "would I be
           content to see this in a pastebin". A service name plus a region is
           a map for somebody. */
        const res = await srv.agent().get('/health');
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/amazonaws|\.com|@|us-[a-z]+-\d|bucket|AKIA/i);
    });

    it('answers 503 degraded when the database is unreachable', async () => {
        const client = srv.core.client;
        const original = client.execute.bind(client);
        client.execute = async () => { throw new Error('connection lost'); };
        try {
            const res = await srv.agent().get('/health');
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({ status: 'degraded', db: 'error', migrations: null });
        } finally {
            client.execute = original;
        }
        expect((await srv.agent().get('/health')).status).toBe(200);
    });

    it('is not redirected or caught by the shell fallback', async () => {
        const res = await srv.agent().get('/health').redirects(0);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/json/);
    });
});

describe('request id', () => {
    it('generates a UUID and echoes it on the response', async () => {
        const res = await srv.agent().get('/api/config');
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('honours a sane client-supplied X-Request-Id and rejects a hostile one', async () => {
        const ok = await srv.agent().get('/api/config').set('X-Request-Id', 'trace-abc-123456');
        expect(ok.headers['x-request-id']).toBe('trace-abc-123456');
        const bad = await srv.agent().get('/api/config').set('X-Request-Id', '<script>alert(1)</script>');
        expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestId('short')).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestId('a'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('structured request log', () => {
    it('writes one JSON record per request with method, path, status, duration, actor and id, but never the query string', async () => {
        const admin = await srv.login('admin');
        const before = requestLogs().length;
        const res = await admin.get('/api/audit?username=secret.person&limit=1');
        const line = requestLogs().slice(before).find((l) => l.path === '/api/audit');
        expect(line).toBeTruthy();
        expect(line).toMatchObject({ level: 'info', msg: 'request', method: 'GET', path: '/api/audit', status: 200, user: 'admin', app: 'izy-ops', env: 'test' });
        expect(line.req).toBe(res.headers['x-request-id']);
        expect(typeof line.ms).toBe('number');
        expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(JSON.stringify(line)).not.toContain('secret.person');
    });

    it('logs the full path of a mounted module route, not the path inside the router', async () => {
        // Express rewrites req.url as it descends into a mounted router, so a
        // path read on finish would say "/" for every module endpoint.
        const admin = await srv.login('admin');
        const before = requestLogs().length;
        await admin.get('/api/projects/uh/uh/sites');
        const line = requestLogs().slice(before).find((l) => l.method === 'GET' && l.status === 200 && l.path.includes('/uh/sites'));
        expect(line, 'no log line carried the full mounted path').toBeTruthy();
        expect(line.path).toBe('/api/projects/uh/uh/sites');
    });

    it('logs 4xx as warn, 5xx as error, and /health at debug', async () => {
        await srv.agent().get('/api/session');           // 401
        await srv.agent().get('/api/_test/error');       // 500
        await srv.agent().get('/health');
        const lines = requestLogs();
        expect(lines.find((l) => l.path === '/api/session' && l.status === 401).level).toBe('warn');
        expect(lines.find((l) => l.path === '/api/_test/error').level).toBe('error');
        expect(lines.find((l) => l.path === '/health').level).toBe('debug');
    });
});
