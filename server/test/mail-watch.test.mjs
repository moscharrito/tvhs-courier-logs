/* Telling somebody that the thing which tells people has stopped.
 *
 * SES answered 403 to every send for twenty-five hours. No password reset
 * code reached anybody and no pharmacy was told about a delivery. /health
 * reported it accurately the whole time, and /health is a URL somebody has
 * to think to open. What found it was the owner trying a reset.
 *
 * Email going down is quiet by construction: nobody sees an error, because
 * the person who would have seen one is the person who never got the
 * message. So most of these tests are about the two ways this could fail
 * to be useful -- staying silent when it matters, and crying wolf until
 * nobody reads it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { sweepMailWatch, FAILURES_BEFORE_ALARM } from '../src/core/notify/mail-watch.ts';

let srv, admin, projectId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    projectId = Number((await sql("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
    await admin.post('/api/users').send({ username: 'mail.lead', name: 'Site Manager', password: 'mail-pass-1', role: 'staff' });
    await admin.put('/api/users/mail.lead/memberships/uh').send({ role: 'lead', settings: {} });
});
afterAll(async () => { await srv.stop(); });

function sql(q, args = []) { return srv.core.client.execute({ sql: q, args }); }

beforeEach(async () => { await sql('DELETE FROM notifications'); });

const NOW = new Date('2026-10-27T15:00:00.000Z');
const justNow = new Date(NOW.getTime() - 60 * 1000).toISOString();
const anHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

const attempts = (over = {}) => ({
    attempted: 30, failing: 25, lastError: '403 AccessDeniedException', lastAttemptAt: justNow, ...over,
});
const sweep = (over = {}, available = true) => sweepMailWatch({
    client: srv.core.client, projectId, attempts: attempts(over), available, now: NOW,
});
const told = async () => (await sql("SELECT username, body FROM notifications WHERE kind = 'mail.failing' ORDER BY id")).rows;

describe('when email has stopped', () => {
    it('tells whoever runs the board, in the app rather than by email', async () => {
        /* An email saying email is broken is a joke with a long delivery
           time. This is a database row the board renders, which needs
           nothing of SES at all. */
        const out = await sweep();
        expect(out.told).toBe(1);

        const rows = await told();
        expect(rows.map((r) => String(r.username)).sort()).toEqual(['admin', 'mail.lead']);
        const body = String(rows[0].body);
        expect(body).toContain('25 sends in a row');
        expect(body, 'what AWS called it').toContain('403 AccessDeniedException');
        expect(body, 'what it costs').toMatch(/reset codes and delivery notices/i);
        expect(body, 'and what it does not cost').toMatch(/Nothing is lost/i);
    });

    it('says it again the next day, because it is still true', async () => {
        /* Not once ever: a mailer still dead tomorrow is still news
           tomorrow, and a notification scrolled past on Tuesday does not
           help on Wednesday. */
        await sweep();
        const tomorrow = new Date('2026-10-28T15:00:00.000Z');
        const out = await sweepMailWatch({
            client: srv.core.client, projectId,
            /* Still failing, and still failing RECENTLY -- a timestamp from
               yesterday would be stale by tomorrow, which is the staleness
               rule working rather than this case. */
            attempts: attempts({ lastAttemptAt: new Date(tomorrow.getTime() - 60 * 1000).toISOString() }),
            available: true, now: tomorrow,
        });
        expect(out.told).toBe(1);
        expect(await told()).toHaveLength(4);
    });

    it('says it again when the fault changes, because that is progress', async () => {
        /* 403 becoming 400 means somebody fixed the credentials and met the
           sandbox. Worth hearing rather than swallowing as a duplicate. */
        await sweep();
        const out = await sweep({ lastError: '400 MessageRejected' });
        expect(out.told).toBe(1);
        const bodies = (await told()).map((r) => String(r.body));
        expect(bodies.some((b) => b.includes('403'))).toBe(true);
        expect(bodies.some((b) => b.includes('400'))).toBe(true);
    });
});

describe('when it must stay quiet', () => {
    it('says nothing once sends are working', async () => {
        const out = await sweep({ failing: 0, lastError: null });
        expect(out.skipped).toBe('working');
        expect(await told()).toHaveLength(0);
    });

    it('does not alarm on a single refusal', async () => {
        /* One failed send is a blip and the sweep retries. The thing worth
           interrupting somebody for is a mailer that is not working, not a
           message that did not go. */
        const out = await sweep({ failing: 1 });
        expect(out.skipped).toBe('tooFew');
        expect(await told()).toHaveLength(0);
    });

    it('waits for a run of them', async () => {
        expect((await sweep({ failing: FAILURES_BEFORE_ALARM - 1 })).skipped).toBe('tooFew');
        expect((await sweep({ failing: FAILURES_BEFORE_ALARM })).told).toBe(1);
    });

    it('says nothing about a run that has gone quiet', async () => {
        /* THE BUG /health HAD, NOT REPEATED HERE. `failing` only returns to
           zero when a send succeeds, so clearing away the queue that was
           failing freezes the count. Without this the alarm would fire
           daily over a mailer nobody is asking to send anything. */
        const out = await sweep({ lastAttemptAt: anHourAgo });
        expect(out.skipped).toBe('stale');
        expect(await told()).toHaveLength(0);
    });

    it('says nothing when nothing has ever been attempted', async () => {
        const out = await sweep({ lastAttemptAt: null });
        expect(out.skipped).toBe('stale');
    });

    it('says nothing when email is switched off', async () => {
        /* A configuration somebody chose, reported by /health as "off".
           Alarming daily about it would train people to ignore this. */
        const out = await sweep({}, false);
        expect(out.skipped).toBe('off');
        expect(await told()).toHaveLength(0);
    });

    it('says it once, not once every two minutes', async () => {
        expect((await sweep()).told).toBe(1);
        expect((await sweep()).skipped).toBe('alreadySaid');
        expect((await sweep()).skipped).toBe('alreadySaid');
        expect(await told(), 'one per dispatcher, from the first sweep').toHaveLength(2);
    });
});
