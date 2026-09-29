/* Bounces and complaints: believing AWS, and refusing everybody else.
 *
 * The endpoint is public and takes no credential of ours, so the test that
 * matters most is not "a real bounce suppresses an address" but "a forged one
 * does not". An unverified webhook here would let anyone who found the URL
 * silently stop a hospital being told about their deliveries, and nothing in
 * the application would look wrong afterwards.
 *
 * A real RSA key pair is generated here and used to sign, so the verification
 * path is exercised for real rather than stubbed. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { startServer } from './helpers/server.mjs';
import {
    stringToSign, isTrustedCertUrl, addressesToSuppress, verifySns, SnsVerificationError,
} from '../src/core/notify/sns.ts';
import { createSesWebhookRouter, suppress, suppressedAddresses } from '../src/core/notify/suppressions.ts';
import { dispatchPending } from '../src/core/notify/dispatch.ts';

const TOPIC = 'arn:aws:sns:us-east-2:123456789012:izy-ses-events';
const CERT_URL = 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-abc123.pem';

let srv, client, keys, certPem;

beforeAll(async () => {
    srv = await startServer();
    client = srv.core.client;

    keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    /* A self-signed certificate, because that is what SNS serves and what
       crypto.verify wants: a PEM it can pull a public key out of. */
    certPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
afterAll(async () => { await srv.stop(); });

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

const sign = (msg) => {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(stringToSign(msg), 'utf8');
    return signer.sign(keys.privateKey, 'base64');
};

const notification = (payload, over = {}) => {
    const msg = {
        Type: 'Notification',
        MessageId: 'm-1',
        TopicArn: TOPIC,
        Message: JSON.stringify(payload),
        Timestamp: '2026-09-29T12:00:00.000Z',
        SignatureVersion: '2',
        SigningCertURL: CERT_URL,
        ...over,
    };
    return { ...msg, Signature: sign(msg) };
};

const bouncePayload = (address, type = 'Permanent', subType = 'General') => ({
    notificationType: 'Bounce',
    bounce: { bounceType: type, bounceSubType: subType, bouncedRecipients: [{ emailAddress: address }] },
});

const appWith = (over = {}) => {
    const app = express();
    app.use(express.json());
    app.use(createSesWebhookRouter({
        client, logger: quietLogger, topicArn: TOPIC,
        fetchCert: async () => certPem,
        confirmSubscription: async () => {},
        ...over,
    }));
    return app;
};

const rows = async (sql, args = []) => (await client.execute({ sql, args })).rows;
const clearSuppressions = () => client.execute('DELETE FROM mail_suppressions');

/* ---------------------------------------------------- refusing a stranger */

describe('what it refuses to believe', () => {
    it('rejects a message signed with somebody else\'s key', async () => {
        /* The whole reason this endpoint verifies anything. Without it,
           anyone who found the URL could post a bounce for a named pharmacist
           and silently cut them off from their delivery notifications. */
        const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const msg = notification(bouncePayload('victim@example.invalid'));
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(stringToSign(msg), 'utf8');
        msg.Signature = signer.sign(other.privateKey, 'base64');

        const res = await request(appWith()).post('/api/webhooks/ses').send(msg);
        expect(res.status).toBe(403);
        expect(await rows('SELECT address FROM mail_suppressions')).toHaveLength(0);
    });

    it('rejects a certificate served from anywhere but AWS', async () => {
        /* THE check people forget. Without it an attacker signs with their own
           key and points SigningCertURL at their own host, and every other
           check passes. */
        for (const url of [
            'https://sns.evil-amazonaws.com/cert.pem',
            'https://amazonaws.com.evil.net/cert.pem',
            'http://sns.us-east-2.amazonaws.com/cert.pem',
            'https://s3.us-east-2.amazonaws.com/cert.pem',
            'https://sns.us-east-2.amazonaws.com/cert.txt',
        ]) {
            expect(isTrustedCertUrl(url), url).toBe(false);
        }
        expect(isTrustedCertUrl(CERT_URL)).toBe(true);
    });

    it('rejects a valid signature from somebody else\'s topic', async () => {
        /* A signature proves it came from SNS, not that it came from OUR
           topic. Anybody with an AWS account can create one. */
        const msg = notification(bouncePayload('victim@example.invalid'), {
            TopicArn: 'arn:aws:sns:us-east-2:999999999999:someone-elses',
        });
        msg.Signature = sign(msg);
        const res = await request(appWith()).post('/api/webhooks/ses').send(msg);
        expect(res.status).toBe(403);
    });

    it('refuses everything when no topic is configured', async () => {
        const res = await request(appWith({ topicArn: undefined }))
            .post('/api/webhooks/ses').send(notification(bouncePayload('a@example.invalid')));
        expect(res.status).toBe(503);
    });

    it('confirms a subscription only after checking the signature', async () => {
        let confirmed = null;
        const app = appWith({ confirmSubscription: async (url) => { confirmed = url; } });

        const bad = {
            Type: 'SubscriptionConfirmation', MessageId: 'c-1', TopicArn: TOPIC,
            Message: 'confirm me', Timestamp: '2026-09-29T12:00:00.000Z',
            SignatureVersion: '2', SigningCertURL: CERT_URL, Token: 't',
            SubscribeURL: 'https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription',
            Signature: 'not-a-real-signature',
        };
        expect((await request(app).post('/api/webhooks/ses').send(bad)).status).toBe(403);
        // Fetching SubscribeURL is what completes the subscription, so doing
        // it before verification would let a stranger wire their own topic in.
        expect(confirmed).toBeNull();

        const good = { ...bad };
        good.Signature = sign(good);
        expect((await request(app).post('/api/webhooks/ses').send(good)).status).toBe(200);
        expect(confirmed).toBe(good.SubscribeURL);
    });
});

/* -------------------------------------------------------- what it acts on */

describe('which events suppress an address', () => {
    it('suppresses a permanent bounce', () => {
        expect(addressesToSuppress(bouncePayload('gone@example.invalid')))
            .toEqual([{ address: 'gone@example.invalid', reason: 'bounce', detail: 'Permanent/General' }]);
    });

    it('leaves a transient bounce alone', () => {
        /* A full mailbox or a server having a bad afternoon. Suppressing on
           one would permanently silence a pharmacist over a fault that fixed
           itself. */
        expect(addressesToSuppress(bouncePayload('busy@example.invalid', 'Transient', 'MailboxFull'))).toEqual([]);
    });

    it('leaves an undetermined bounce alone', () => {
        // "AWS could not tell" is not grounds for cutting somebody off.
        expect(addressesToSuppress(bouncePayload('who@example.invalid', 'Undetermined'))).toEqual([]);
    });

    it('suppresses a complaint', () => {
        const payload = {
            notificationType: 'Complaint',
            complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'Cross@Example.invalid' }] },
        };
        expect(addressesToSuppress(payload))
            .toEqual([{ address: 'cross@example.invalid', reason: 'complaint', detail: 'abuse' }]);
    });

    it('ignores a delivery receipt', () => {
        expect(addressesToSuppress({ notificationType: 'Delivery' })).toEqual([]);
    });

    it('does not fall over on a payload that is not what we expected', () => {
        for (const junk of [null, 'a string', 42, {}, { notificationType: 'Bounce' }]) {
            expect(() => addressesToSuppress(junk)).not.toThrow();
        }
    });
});

/* -------------------------------------------------------- end to end */

describe('a real bounce, all the way through', () => {
    it('records it and then stops sending to that address', async () => {
        await clearSuppressions();
        const res = await request(appWith())
            .post('/api/webhooks/ses').send(notification(bouncePayload('Left.The.Hospital@example.invalid')));
        expect(res.status).toBe(200);
        expect(res.body.suppressed).toBe(1);

        // Lowercased on the way in, so a capital letter cannot miss later.
        const stored = await rows('SELECT address, reason FROM mail_suppressions');
        expect(stored).toHaveLength(1);
        expect(String(stored[0].address)).toBe('left.the.hospital@example.invalid');

        expect(await suppressedAddresses(client)).toContain('left.the.hospital@example.invalid');
    });

    it('is idempotent: the same bounce twice is one row', async () => {
        await clearSuppressions();
        const app = appWith();
        const msg = notification(bouncePayload('twice@example.invalid'));
        await request(app).post('/api/webhooks/ses').send(msg);
        await request(app).post('/api/webhooks/ses').send(msg);
        expect(await rows('SELECT id FROM mail_suppressions')).toHaveLength(1);
    });

    it('makes the dispatcher skip that address instead of sending again', async () => {
        await clearSuppressions();
        await suppress(client, { address: 'bounced@example.invalid', reason: 'bounce', detail: 'Permanent/General' });

        const project = (await rows("SELECT id FROM projects WHERE code = 'uh'"))[0];
        await client.execute({
            sql: `INSERT INTO notifications (project_id, username, kind, body, created_at)
                  VALUES (?, ?, 'delivery.completed', 'Delivery 1 for X was completed at 1:00 PM.', ?)`,
            args: [Number(project.id), 'bounced.user', new Date().toISOString()],
        });
        await client.execute({
            sql: "INSERT INTO users (username, password, name, email, role, status, created_at) VALUES (?, 'x', 'B', ?, 'staff', 'active', ?)",
            args: ['bounced.user', 'Bounced@Example.invalid', new Date().toISOString()],
        });

        const sent = [];
        const result = await dispatchPending({
            client,
            mailer: { available: true, reason: null, async send(m) { sent.push(m); } },
            logger: quietLogger,
            portalUrl: 'https://logs.example.invalid',
        });

        expect(result.suppressed).toBeGreaterThan(0);
        expect(sent.map((m) => m.to)).not.toContain('bounced@example.invalid');
        // Marked done, not retried every two minutes forever.
        const waiting = await rows("SELECT id FROM notifications WHERE sent_at IS NULL AND username = 'bounced.user'");
        expect(waiting).toHaveLength(0);
    });

    it('still sends when the suppression table cannot be read', async () => {
        /* The one place this file fails OPEN, deliberately. Not knowing
           whether an address is suppressed is better handled by sending than
           by silently not telling a hospital their STAT arrived. */
        const broken = { execute: async () => { throw new Error('table gone'); } };
        expect(await suppressedAddresses(broken)).toEqual(new Set());
    });
});

/* ------------------------------------------------------------ the signer */

describe('the string that gets signed', () => {
    it('skips an absent Subject rather than sending it empty', () => {
        /* Including it as "" when it was absent produces a different string
           and fails verification on every notification without a subject,
           which is most of them. */
        const s = stringToSign({
            Type: 'Notification', MessageId: 'm', TopicArn: 't',
            Message: 'body', Timestamp: 'ts', SignatureVersion: '2', Signature: '',
        });
        expect(s).toBe('Message\nbody\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n');
    });

    it('includes Subject when there is one, in the right place', () => {
        const s = stringToSign({
            Type: 'Notification', MessageId: 'm', TopicArn: 't', Subject: 'hi',
            Message: 'body', Timestamp: 'ts', SignatureVersion: '2', Signature: '',
        });
        expect(s).toContain('Subject\nhi\n');
        expect(s.indexOf('Subject')).toBeGreaterThan(s.indexOf('MessageId'));
        expect(s.indexOf('Subject')).toBeLessThan(s.indexOf('Timestamp'));
    });

    it('throws rather than returning false, so a forgotten check is not an open door', async () => {
        await expect(verifySns(
            { Type: 'Notification', TopicArn: 'wrong' },
            { fetchCert: async () => certPem, expectedTopicArn: TOPIC },
        )).rejects.toBeInstanceOf(SnsVerificationError);
    });
});
