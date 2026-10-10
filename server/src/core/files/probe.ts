/* Does the bucket actually take a write?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, WHICH IS A STORY ABOUT A GREEN HEALTH CHECK.
 *
 * /health reported `files: "configured"` for weeks against a bucket that
 * refused every upload. `createFileStorage` returns available: true when
 * the five S3 environment values are present; it never contacts AWS. So
 * the field said the configuration was filled in and was read by everybody
 * as "proof of delivery photographs work".
 *
 * The first thing that ever touched S3 was a production dry run three
 * weeks before go-live, which came back `403 AccessDenied` -- the KMS key
 * policy had not been applied, which docs/infra/s3-bucket.md §5b predicts
 * in as many words. A probe on boot would have put that in Render's log
 * the day the values went in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY S3 IS PROBED WHEN MAIL AND SMS ARE NOT.
 *
 * core/http/health.ts refuses to prove SES or Twilio answer, and is right
 * to: the only way to know an email service works is to send an email, and
 * a health check that sends email is a health check that mails a hospital
 * every thirty seconds.
 *
 * S3 has no such problem. The whole cost of proving it is a zero-byte
 * object, written to a reserved key and deleted again, read by nobody and
 * containing nothing. The asymmetry is in what the proof costs, not in how
 * much the two matter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT WRITES, BECAUSE WRITING IS THE THING THAT WAS BROKEN.
 *
 * A HEAD on the bucket would be cheaper and would have proved nothing
 * here: the IAM policy deliberately does not grant s3:ListBucket, so a
 * HeadBucket fails on a correctly configured bucket. A GET of a missing
 * object would exercise the read path and not the KMS write path, which is
 * the half that failed.
 *
 * So the probe signs exactly what a courier's phone signs -- a PUT with
 * `x-amz-server-side-encryption: aws:kms` and the key id -- and then
 * deletes it. That covers s3:PutObject, kms:GenerateDataKey, the key's own
 * resource policy, the bucket policy's encryption condition, and
 * s3:DeleteObject, which the retention purge needs and which fails in the
 * direction nobody checks.
 *
 * ONE FIXED KEY, overwritten each time. A random key would accumulate one
 * object per boot in a bucket holding patient photographs if a delete ever
 * failed quietly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEVER ON THE REQUEST PATH.
 *
 * A platform hits /health every few seconds. The probe runs at boot and on
 * a timer, and the endpoint reads a cached answer, so S3 is touched a few
 * times an hour however often anybody asks.
 */

import type { FileStorage } from './storage';

/** The reserved key. Zero bytes, written and deleted, never a photograph. */
export const PROBE_KEY = '_health/bucket-probe';

export type FilesHealth =
    | 'off'
    /** Configured, and the first probe has not finished. Honest rather than
     *  optimistic: a boot answers health checks before S3 has replied. */
    | 'checking'
    | 'ok'
    /** Configured and refusing, with S3's own error code appended. */
    | `unreachable: ${string}`;

export interface FilesProbe {
    /** The cached answer. Never touches the network. */
    state(): FilesHealth;
    /** Run one probe now. Resolves when the state has been updated. */
    check(): Promise<void>;
    stop(): void;
}

/** S3 answers failures with XML naming the fault. The CODE only: a message
 *  carries ARNs and the bucket name, and this endpoint's standing rule is
 *  that it says whether something works, never what it is called. */
function codeOf(status: number, xml: string): string {
    const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
    return code ?? `HTTP ${status}`;
}

export function createFilesProbe(
    storage: FileStorage,
    { everyMs = 15 * 60 * 1000, fetchImpl = fetch }: { everyMs?: number; fetchImpl?: typeof fetch } = {},
): FilesProbe {
    if (!storage.available) {
        return { state: () => 'off', check: async () => {}, stop: () => {} };
    }

    let current: FilesHealth = 'checking';

    const check = async (): Promise<void> => {
        try {
            /* Presigned carries the url and the exact headers, not the
               verb: which verb it is was decided by choosing the
               presigner, and sending a different one breaks the
               signature. */
            const put = storage.presignUpload(PROBE_KEY, 'text/plain');
            const written = await fetchImpl(put.url, {
                method: 'PUT',
                headers: put.headers,
                body: '',
            });
            if (!written.ok) {
                const xml = await written.text().catch(() => '');
                current = `unreachable: ${codeOf(written.status, xml)}`;
                return;
            }

            /* The delete is part of the test, not tidying up. Without
               s3:DeleteObject the retention purge marks a photograph
               disposed while it is still in the bucket, which is the
               disagreement docs/infra/s3-bucket.md warns about. */
            const gone = storage.presignDelete(PROBE_KEY);
            const removed = await fetchImpl(gone.url, { method: 'DELETE', headers: gone.headers });
            if (!removed.ok && removed.status !== 404) {
                const xml = await removed.text().catch(() => '');
                current = `unreachable: delete ${codeOf(removed.status, xml)}`;
                return;
            }

            current = 'ok';
        } catch (err) {
            /* A DNS failure, a timeout, a bad region. Never throws: a
               health endpoint that 500s because S3 is slow is worse than
               one that says S3 is slow. */
            current = `unreachable: ${err instanceof Error ? err.name : 'error'}`;
        }
    };

    const timer = setInterval(() => { void check(); }, everyMs);
    /* Unreferenced, so a probe timer cannot hold the process open and a
       test does not have to remember to stop it. */
    timer.unref?.();

    void check();

    return {
        state: () => current,
        check,
        stop: () => clearInterval(timer),
    };
}
