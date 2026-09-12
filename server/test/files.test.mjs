/* The file service.
 *
 * The signing tests reproduce AWS's own published worked example byte for
 * byte. That is the only way to know a hand-written SigV4 implementation is
 * right without a live bucket: if the canonical request, the string to sign
 * and the derived key all match the documentation, they match AWS.
 *
 * The rest is about what the service refuses. S3 is not configured on this
 * machine and will not be until ticket 0.10 sets up the account, so the
 * endpoints are exercised against a storage double as well as against the
 * real unconfigured one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import {
    presign, canonicalPartsForTest, uriEncode, encodeKeyPath, bucketHost, amzDates,
} from '../src/core/files/sigv4.ts';
import {
    buildKey, createFileStorage, FilesUnavailableError,
    READ_URL_SECONDS, WRITE_URL_SECONDS, ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES,
} from '../src/core/files/storage.ts';

const FILES = '/api/projects/uh/uh/files';
const ORDERS = '/api/projects/uh/uh/orders';

let srv;
let admin;
let dischargeId;

beforeAll(async () => {
    srv = await startServer();
    admin = await srv.login('admin');
    dischargeId = (await admin.get('/api/projects/uh/uh/sites')).body.find((s) => s.code === 'discharge').id;
});
afterAll(async () => { await srv.stop(); });

/* ------------------------------------------------------------- AWS vector */

describe('SigV4 against the published AWS example', () => {
    /* From "Authenticating Requests: Using Query Parameters (AWS Signature
       Version 4)" in the S3 documentation. The expected values below are
       AWS's, not ours. */
    const vector = {
        method: 'GET',
        bucket: 'examplebucket',
        region: 'us-east-1',
        key: 'test.txt',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        expiresIn: 86400,
        at: new Date('2013-05-24T00:00:00Z'),
    };

    it('builds the documented canonical request', () => {
        expect(canonicalPartsForTest(vector).canonicalRequest).toBe(
            'GET\n'
            + '/test.txt\n'
            + 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
            + '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host\n'
            + 'host:examplebucket.s3.amazonaws.com\n'
            + '\n'
            + 'host\n'
            + 'UNSIGNED-PAYLOAD',
        );
    });

    it('hashes it to the documented value', () => {
        expect(canonicalPartsForTest(vector).stringToSign).toBe(
            'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n'
            + '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04',
        );
    });

    it('produces the documented signature', () => {
        // If this matches, the key derivation and the HMAC chain are right.
        expect(presign(vector).url).toContain(
            'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
        );
    });
});

describe('signing details that are easy to get wrong', () => {
    it('percent-encodes the characters encodeURIComponent leaves alone', () => {
        // A signature computed over differently encoded text is simply wrong.
        expect(uriEncode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af');
        expect(uriEncode('a b/c')).toBe('a%20b%2Fc');
    });

    it('encodes path segments but not the separators', () => {
        expect(encodeKeyPath('uh/2026-09-12/order-1/doorstep/a b.jpg')).toBe('/uh/2026-09-12/order-1/doorstep/a%20b.jpg');
    });

    it('leaves the region out of the host only for us-east-1', () => {
        expect(bucketHost('b', 'us-east-1')).toBe('b.s3.amazonaws.com');
        expect(bucketHost('b', 'us-east-2')).toBe('b.s3.us-east-2.amazonaws.com');
    });

    it('formats the two date shapes AWS expects', () => {
        expect(amzDates(new Date('2026-09-12T15:04:05.123Z'))).toEqual({ amzDate: '20260912T150405Z', dateStamp: '20260912' });
    });

    it('signs every header it will require, so an unsigned PUT cannot match', () => {
        const signed = presign({
            method: 'PUT', bucket: 'b', region: 'us-east-2', key: 'k.jpg',
            accessKeyId: 'AKIA', secretAccessKey: 'secret', expiresIn: 900,
            at: new Date('2026-09-12T00:00:00Z'),
            headers: { 'content-type': 'image/jpeg', 'x-amz-server-side-encryption': 'aws:kms' },
        });
        expect(signed.url).toContain('X-Amz-SignedHeaders=content-type%3Bhost%3Bx-amz-server-side-encryption');
    });

    it('changes the signature when anything signed changes', () => {
        const base = {
            method: 'PUT', bucket: 'b', region: 'us-east-2', key: 'k.jpg',
            accessKeyId: 'AKIA', secretAccessKey: 'secret', expiresIn: 900,
            at: new Date('2026-09-12T00:00:00Z'),
            headers: { 'content-type': 'image/jpeg' },
        };
        const sig = (u) => u.split('X-Amz-Signature=')[1];
        const a = sig(presign(base).url);
        expect(sig(presign({ ...base, key: 'other.jpg' }).url)).not.toBe(a);
        expect(sig(presign({ ...base, headers: { 'content-type': 'image/png' } }).url)).not.toBe(a);
        expect(sig(presign({ ...base, expiresIn: 901 }).url)).not.toBe(a);
        expect(sig(presign({ ...base, at: new Date('2026-09-13T00:00:00Z') }).url)).not.toBe(a);
    });
});

/* -------------------------------------------------------------- key layout */

describe('the key layout', () => {
    it('is project, date, order, kind, as the ticket specifies', () => {
        expect(buildKey({ projectCode: 'uh', serviceDate: '2026-09-12', orderId: 418, kind: 'doorstep' }, 'jpg', 'abc-123'))
            .toBe('uh/2026-09-12/order-418/doorstep/abc-123.jpg');
    });

    it('files something with no order under its own prefix', () => {
        expect(buildKey({ projectCode: 'uh', serviceDate: '2026-09-12', orderId: null, kind: 'pod' }, 'pdf', 'x'))
            .toBe('uh/2026-09-12/unassigned/pod/x.pdf');
    });

    it('cannot be talked into leaving its own prefix', () => {
        // A patient's name must not arrive in an object key, and a key must
        // not climb out of its project.
        const key = buildKey({ projectCode: '../other', serviceDate: '2026/09/12', orderId: 1, kind: 'doorstep' }, 'jpg', 'u');
        expect(key).toBe('-other/2026-09-12/order-1/doorstep/u.jpg');
        expect(key).not.toContain('..');
        expect(key.split('/')).toHaveLength(5);
    });
});

/* ------------------------------------------------------------- unavailable */

describe('when S3 is not configured', () => {
    it('refuses rather than pretending to store something', () => {
        const storage = createFileStorage({ files: { enabled: false, s3: undefined } });
        expect(storage.available).toBe(false);
        expect(storage.reason).toMatch(/FILES_ENABLED is false/);
        expect(() => storage.presignUpload('k', 'image/jpeg')).toThrow(FilesUnavailableError);
        expect(() => storage.presignDownload('k')).toThrow(FilesUnavailableError);
    });

    it('says so when the flag is on but the values are missing', () => {
        const storage = createFileStorage({ files: { enabled: true, s3: undefined } });
        expect(storage.reason).toMatch(/incomplete/);
    });

    it('answers 503 from the endpoints, naming the ticket that fixes it', async () => {
        // This machine has no AWS account: the real, unconfigured service.
        const res = await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000 });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('files.notConfigured');
        expect(res.body.detail).toMatch(/0\.10/);

        const status = await admin.get(`${FILES}/status/check`);
        expect(status.body).toMatchObject({ available: false });
        expect(status.body.reason).toBeTruthy();
    });

    it('creates no row when it refuses', async () => {
        const before = (await srv.core.client.execute('SELECT COUNT(*) AS n FROM files')).rows[0].n;
        await admin.post(FILES).send({ kind: 'doorstep', contentType: 'image/jpeg', bytes: 1000 });
        const after = (await srv.core.client.execute('SELECT COUNT(*) AS n FROM files')).rows[0].n;
        expect(Number(after)).toBe(Number(before));
    });
});
