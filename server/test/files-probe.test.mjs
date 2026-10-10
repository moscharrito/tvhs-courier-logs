/* Whether the bucket actually takes a write.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS BECAUSE OF.
 *
 * /health reported `files: "configured"` for weeks against a bucket that
 * refused every upload. createFileStorage returns available: true when the
 * five S3 values are present and never contacts AWS, so the field meant
 * "somebody filled the form in" and was read by everybody as "proof of
 * delivery photographs work".
 *
 * What found it was a production dry run three weeks before go-live:
 * 403 AccessDenied, the KMS key policy never applied, which
 * docs/infra/s3-bucket.md §5b predicts in as many words.
 *
 * So these tests are mostly about the failure cases. A probe that says ok
 * when the bucket works is the easy half; one that stays quiet when it
 * does not is the bug all over again.
 */

import { describe, it, expect, vi } from 'vitest';
import { createFilesProbe, PROBE_KEY } from '../src/core/files/probe.ts';

/** Enough of a FileStorage to drive the probe. */
const storageThat = (available = true) => ({
    available,
    reason: available ? null : 'FILES_ENABLED is false.',
    presignUpload: (key, contentType) => ({
        url: `https://bucket.s3.us-east-1.amazonaws.com/${key}?sig=put`,
        headers: { 'content-type': contentType, 'x-amz-server-side-encryption': 'aws:kms' },
        expiresAt: '2026-01-01T00:00:00.000Z',
    }),
    presignDownload: () => { throw new Error('not used'); },
    presignDelete: (key) => ({
        url: `https://bucket.s3.us-east-1.amazonaws.com/${key}?sig=del`,
        headers: {},
        expiresAt: '2026-01-01T00:00:00.000Z',
    }),
});

const reply = (status, body = '') => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
});

const DENIED = '<?xml version="1.0"?><Error><Code>AccessDenied</Code>'
    + '<Message>User arn:aws:iam::1234:user/izy is not authorized to perform kms:GenerateDataKey '
    + 'on resource arn:aws:kms:us-east-1:1234:key/abc</Message></Error>';

describe('when storage is not configured at all', () => {
    it('says off and never touches the network', async () => {
        const fetchImpl = vi.fn();
        const probe = createFilesProbe(storageThat(false), { fetchImpl });
        expect(probe.state()).toBe('off');
        await probe.check();
        expect(fetchImpl).not.toHaveBeenCalled();
        probe.stop();
    });
});

describe('a bucket that works', () => {
    it('probes once on its own, without being asked', async () => {
        /* The whole point is that a broken bucket shows up at boot rather
           than when somebody finally runs a dry run against production. */
        const fetchImpl = vi.fn(async () => reply(204));
        const probe = createFilesProbe(storageThat(), { fetchImpl });
        await Promise.resolve();
        await Promise.resolve();
        expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
        probe.stop();
    });

    it('writes a zero-byte object and deletes it again', async () => {
        let calls = [];
        const fetchImpl = vi.fn(async (url, init) => {
            calls.push([init.method, String(url)]);
            return reply(204);
        });
        const probe = createFilesProbe(storageThat(), { fetchImpl });
        /* Constructing it already starts one, so measure a probe of our
           own rather than whatever the boot probe left behind. */
        await probe.check();
        calls = [];
        await probe.check();

        expect(probe.state()).toBe('ok');
        expect(calls).toHaveLength(2);
        expect(calls[0][0]).toBe('PUT');
        expect(calls[1][0]).toBe('DELETE');
        /* One reserved key, not a random one per boot: a delete that failed
           quietly would otherwise leave an object per restart in a bucket
           holding patient photographs. */
        expect(calls[0][1]).toContain(PROBE_KEY);
        expect(calls[1][1]).toContain(PROBE_KEY);
        probe.stop();
    });

    it('signs the write the same way a courier phone does', async () => {
        /* The encryption header is what the bucket policy conditions on.
           A probe that wrote without it would pass against a bucket that
           refuses every real upload. */
        let sent = null;
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: async (_url, init) => { sent = sent ?? init.headers; return reply(204); },
        });
        await probe.check();
        expect(sent['x-amz-server-side-encryption']).toBe('aws:kms');
        probe.stop();
    });
});

describe('a bucket that refuses', () => {
    it('reports S3 own error code rather than just failing', async () => {
        /* 403 alone cannot tell apart a missing key policy, a bucket policy
           that rejects the header, and a signature that did not match. */
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: async () => reply(403, DENIED),
        });
        await probe.check();
        expect(probe.state()).toBe('unreachable: AccessDenied');
        probe.stop();
    });

    it('never puts the bucket name or an ARN in the answer', async () => {
        /* This endpoint's standing rule: it says whether something works,
           never what it is called. The S3 message carries both. */
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: async () => reply(403, DENIED),
        });
        await probe.check();
        const state = probe.state();
        expect(state).not.toContain('arn:aws');
        expect(state).not.toContain('bucket');
        expect(state).not.toContain('izy');
        probe.stop();
    });

    it('falls back to the status when there is no XML', async () => {
        const probe = createFilesProbe(storageThat(), { fetchImpl: async () => reply(500, '') });
        await probe.check();
        expect(probe.state()).toBe('unreachable: HTTP 500');
        probe.stop();
    });

    it('notices a refused DELETE, which fails in the direction nobody checks', async () => {
        /* Without s3:DeleteObject the retention purge marks a photograph
           disposed while it is still in the bucket. The write passing is
           not enough to call the bucket good. */
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: async (_url, init) => (init.method === 'PUT'
                ? reply(204)
                : reply(403, '<Error><Code>AccessDenied</Code></Error>')),
        });
        await probe.check();
        expect(probe.state()).toBe('unreachable: delete AccessDenied');
        probe.stop();
    });

    it('treats a missing probe object on delete as fine', async () => {
        /* A lifecycle rule or a previous run may have removed it already.
           That is not a permissions problem. */
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: async (_url, init) => (init.method === 'PUT' ? reply(204) : reply(404)),
        });
        await probe.check();
        expect(probe.state()).toBe('ok');
        probe.stop();
    });

    it('survives the network being gone', async () => {
        /* A health endpoint that 500s because S3 is slow is worse than one
           that says S3 is slow. */
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: async () => { throw Object.assign(new Error('getaddrinfo'), { name: 'TypeError' }); },
        });
        await probe.check();
        expect(probe.state()).toBe('unreachable: TypeError');
        probe.stop();
    });
});

describe('what /health reads', () => {
    it('is checking until the first probe lands, not ok', async () => {
        /* Honest rather than optimistic: a boot answers health checks
           before S3 has replied, and reporting ok in that window is the
           same guess this whole file exists to remove. */
        let settle;
        const probe = createFilesProbe(storageThat(), {
            fetchImpl: () => new Promise((r) => { settle = () => r(reply(204)); }),
        });
        expect(probe.state()).toBe('checking');
        settle();
        probe.stop();
    });

    it('is a cached read that touches nothing', async () => {
        /* A platform hits /health every few seconds. */
        const fetchImpl = vi.fn(async () => reply(204));
        const probe = createFilesProbe(storageThat(), { fetchImpl });
        await probe.check();
        const before = fetchImpl.mock.calls.length;
        for (let i = 0; i < 50; i += 1) probe.state();
        expect(fetchImpl.mock.calls.length).toBe(before);
        probe.stop();
    });
});
