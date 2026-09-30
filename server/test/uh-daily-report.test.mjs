/* Yesterday's performance, emailed to University Health each morning.
 *
 * Two properties matter more than the rest. It goes ONCE, because a hospital
 * receiving the same report eleven times before breakfast is worse than one
 * receiving none. And the figures are FROZEN into the row that records the
 * send, because "what did we tell them on the third of December" has to have
 * an answer in a year, and recomputing from today's data does not give one. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { reportBody, sendDailyReport, sendsToday } from '../src/modules/uh/daily-report.ts';
import { assertNoPatientData } from '../src/core/notify/ses.ts';
import { DEFAULT_PROJECT_SETTINGS } from '../src/core/projects/settings.ts';

let srv, admin, client, projectId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    client = srv.core.client;
    projectId = Number((await client.execute("SELECT id FROM projects WHERE code = 'uh'")).rows[0].id);
});
afterAll(async () => { await srv.stop(); });

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const FIGURES = {
    totals: { orders: 42, delivered: 40, notDelivered: 2, cancelled: 0, stillOpen: 0, attempts: 42 },
    rates: { completionRate: 95.2, onTimeRate: 97.5, dryRunRate: 4.8 },
    turnaround: { inOurHands: { medianMinutes: 34, p90Minutes: 78 } },
    followUp: { reattempts: 1, returned: 2, awaitingReturn: 0 },
    failureReasons: [{ label: 'No access to the building', packages: 2 }],
    target: 95,
};

const settings = (over = {}) => ({
    ...DEFAULT_PROJECT_SETTINGS,
    reporting: { dailyRecipients: ['quality@example.invalid'], days: [0, 1, 2, 3, 4, 5, 6], ...over },
});

const fakeMailer = (behaviour = () => {}) => {
    const sent = [];
    return {
        sent, available: true, reason: null,
        async send(mail) { behaviour(mail); sent.push(mail); },
    };
};

const deps = (over = {}) => ({
    client, logger: quiet, portalUrl: 'https://logs.example.invalid',
    projectId, projectCode: 'uh', settings: settings(),
    timezone: 'America/Chicago', serviceDate: '2026-09-29',
    figuresFor: async () => FIGURES,
    mailer: fakeMailer(),
    ...over,
});

const sends = () => client.execute('SELECT * FROM report_sends').then((r) => r.rows);
const clear = () => client.execute('DELETE FROM report_sends');

/* ------------------------------------------------------------ the body */

describe('what the report says', () => {
    it('carries the numbers, because a performance report is not about a patient', () => {
        /* The only message in this system whose figures travel in the body.
           Everything else concerns one person and links to the portal; this
           concerns none of them. */
        const body = reportBody('2026-09-29', FIGURES, 'https://logs.example.invalid');
        expect(body).toContain('Deliveries        42');
        expect(body).toContain('Completion rate   95.2%   (target 95%)');
        expect(body).toContain('34 min median');
    });

    it('passes the same refusal every other message is held to', () => {
        expect(() => assertNoPatientData(reportBody('2026-09-29', FIGURES, 'https://logs.example.invalid'))).not.toThrow();
    });

    it('formats thousands, so a big count is not mistaken for a ZIP code', () => {
        /* A bare 78229 looks exactly like a ZIP to assertNoPatientData, and a
           report refusing to send itself on the day somebody delivered ten
           thousand parcels would be a confusing way to learn that rule. */
        const big = { ...FIGURES, totals: { ...FIGURES.totals, orders: 78229, delivered: 12000 } };
        const body = reportBody('2026-09-29', big, 'https://logs.example.invalid');
        expect(body).toContain('78,229');
        expect(() => assertNoPatientData(body)).not.toThrow();
    });

    it('points at the portal for the basis of every rate', () => {
        const body = reportBody('2026-09-29', FIGURES, 'https://logs.example.invalid');
        expect(body).toContain('definition behind every rate');
        expect(body).toContain('https://logs.example.invalid');
    });
});

/* ----------------------------------------------------------- sending */

describe('sending it', () => {
    it('sends to every recipient and records the send', async () => {
        await clear();
        const mailer = fakeMailer();
        const res = await sendDailyReport(deps({ mailer }));

        expect(res.outcome).toBe('sent');
        expect(mailer.sent).toHaveLength(1);
        expect(mailer.sent[0].to).toBe('quality@example.invalid');
        expect(mailer.sent[0].subject).toBe('Delivery performance, 2026-09-29');

        const rows = await sends();
        expect(rows).toHaveLength(1);
        expect(String(rows[0].sent_by)).toBe('scheduler');
        expect(String(rows[0].channel)).toBe('email');
    });

    it('freezes the figures into the row, so what we said stays what we said', async () => {
        /* Recomputing today's numbers from today's data does not answer what
           was sent, because the data has moved since. */
        await clear();
        await sendDailyReport(deps());
        const stored = JSON.parse(String((await sends())[0].figures));
        expect(stored.rates.completionRate).toBe(95.2);
        expect(stored.totals.orders).toBe(42);
    });

    it('never sends the same day twice', async () => {
        /* A hospital receiving the same report eleven times before breakfast
           is worse than one receiving none. The unique index holds it, not a
           check before the insert: two ticks racing would both pass a check. */
        await clear();
        expect((await sendDailyReport(deps())).outcome).toBe('sent');

        const again = fakeMailer();
        expect((await sendDailyReport(deps({ mailer: again }))).outcome).toBe('already_sent');
        expect(again.sent).toHaveLength(0);
        expect(await sends()).toHaveLength(1);
    });

    it('does not claim a day when nobody received it', async () => {
        /* Otherwise the record says a report was issued and none arrived, and
           the next tick would pass over it forever. */
        await clear();
        const angry = fakeMailer(() => { throw new Error('SES refused it'); });
        expect((await sendDailyReport(deps({ mailer: angry }))).outcome).toBe('failed');
        expect(await sends()).toHaveLength(0);

        // And the retry gets through.
        expect((await sendDailyReport(deps())).outcome).toBe('sent');
    });

    it('keeps the day when only some recipients failed', async () => {
        await clear();
        let n = 0;
        const flaky = fakeMailer(() => { n += 1; if (n === 1) throw new Error('one bounced'); });
        const res = await sendDailyReport(deps({
            mailer: flaky,
            settings: settings({ dailyRecipients: ['a@example.invalid', 'b@example.invalid'] }),
        }));
        expect(res.outcome).toBe('sent');
        expect(res.recipients).toBe(1);
        expect(await sends()).toHaveLength(1);
    });
});

/* --------------------------------------------------------- when it goes */

describe('when it goes', () => {
    it('sends nothing when nobody is named', async () => {
        /* The right default. A system that starts emailing a hospital the
           moment it is deployed, to addresses nobody chose, is worse than one
           that waits to be told. */
        await clear();
        const mailer = fakeMailer();
        const res = await sendDailyReport(deps({ mailer, settings: settings({ dailyRecipients: [] }) }));
        expect(res.outcome).toBe('no_recipients');
        expect(mailer.sent).toHaveLength(0);
    });

    it('sends nothing when mail is not configured', async () => {
        await clear();
        const off = { available: false, reason: 'off', async send() { throw new Error('nope'); } };
        expect((await sendDailyReport(deps({ mailer: off }))).outcome).toBe('no_mailer');
    });

    it('honours the days setting, which is the knob for "then less frequent"', async () => {
        await clear();
        /* 2026-09-30 is a Wednesday. A Monday-only schedule skips it. */
        const wednesday = new Date('2026-09-30T13:00:00.000Z');
        const res = await sendDailyReport(deps({
            now: wednesday,
            settings: settings({ days: [1] }),
        }));
        expect(res.outcome).toBe('not_today');
    });

    it('agrees with sendsToday about which day it is', () => {
        const wednesday = new Date('2026-09-30T13:00:00.000Z');
        expect(sendsToday(settings({ days: [3] }), wednesday, 'America/Chicago')).toBe(true);
        expect(sendsToday(settings({ days: [1, 2] }), wednesday, 'America/Chicago')).toBe(false);
    });
});
