/* The file service: where a proof of delivery goes and how it comes back.
 *
 * Bytes never pass through this server. The browser is handed a signed PUT
 * and uploads straight to S3; reading is a signed GET that expires in five
 * minutes. That is not only a bandwidth decision. A photo of a patient's
 * front door that never touches the application server cannot end up in a
 * request log, a heap dump or a crash report.
 *
 * Three rules the bucket must enforce and this module assumes:
 *
 *   SSE-KMS      The encryption headers are part of the signature, so a PUT
 *                that omits them does not match and S3 rejects it. With the
 *                matching bucket policy in docs/infra/s3-bucket.md, there is
 *                no way to write an unencrypted object.
 *   No public    Nothing is ever public-read. Every read is a fresh signed
 *                URL scoped to one key.
 *   Lifecycle    Pending uploads that never completed expire on their own.
 *
 * When S3 is not configured, every operation refuses and says so, rather
 * than pretending to store something. An upload that silently goes nowhere
 * is worse than one that fails loudly at the counter.
 */

import crypto from 'node:crypto';
import type { Config } from '../../config';
import { presign, type Presigned } from './sigv4';

/** Five minutes, per the ticket. Long enough to open, short enough that a
 *  URL copied out of a browser is worthless by the time it is pasted. */
export const READ_URL_SECONDS = 5 * 60;
/** Longer: a courier on cellular uploading a photo needs the headroom. */
export const WRITE_URL_SECONDS = 15 * 60;

/** What a courier's phone can actually produce, and nothing else. */
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'application/pdf': 'pdf',
};

/** A phone photo is a couple of megabytes; twenty is a mistake or an attack. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class FilesUnavailableError extends Error {
    readonly code = 'files.notConfigured';
    constructor() {
        super('File storage is not configured. Set FILES_ENABLED and the S3 values, using a bucket covered by a signed AWS BAA.');
        this.name = 'FilesUnavailableError';
    }
}

export interface KeyParts {
    projectCode: string;
    serviceDate: string;
    orderId: number | null;
    kind: string;
}

/* Only characters this builder produces are ever in a key, so the signer
 * never has to handle a surprising one. A client cannot influence it: there
 * is no filename in here, which also means a patient's name cannot arrive in
 * an object key by way of a helpfully named photo. */
const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40);

/** project/date/order/kind/uuid.ext, as the ticket specifies. */
export function buildKey(parts: KeyParts, extension: string, uuid = crypto.randomUUID()): string {
    const order = parts.orderId === null ? 'unassigned' : `order-${parts.orderId}`;
    return [safe(parts.projectCode), safe(parts.serviceDate), safe(order), safe(parts.kind), `${uuid}.${safe(extension)}`].join('/');
}

export interface FileStorage {
    readonly available: boolean;
    /** Why it is unavailable, for a message a person can act on. */
    readonly reason: string | null;
    presignUpload(key: string, contentType: string, at?: Date): Presigned;
    presignDownload(key: string, at?: Date): Presigned;
}

export function createFileStorage(config: Config): FileStorage {
    const s3 = config.files.enabled ? config.files.s3 : undefined;

    if (!s3) {
        const reason = config.files.enabled
            ? 'FILES_ENABLED is set but the S3 values are incomplete.'
            : 'FILES_ENABLED is false.';
        const refuse = (): never => { throw new FilesUnavailableError(); };
        return { available: false, reason, presignUpload: refuse, presignDownload: refuse };
    }

    const base = {
        bucket: s3.bucket,
        region: s3.region,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
    };

    return {
        available: true,
        reason: null,

        presignUpload(key: string, contentType: string, at = new Date()): Presigned {
            /* These headers are signed, so the browser must send exactly
             * these and no others. That is what makes unencrypted writes
             * impossible rather than merely discouraged. */
            const headers: Record<string, string> = {
                'content-type': contentType,
                'x-amz-server-side-encryption': 'aws:kms',
            };
            if (s3.kmsKeyId) headers['x-amz-server-side-encryption-aws-kms-key-id'] = s3.kmsKeyId;

            return presign({ ...base, method: 'PUT', key, expiresIn: WRITE_URL_SECONDS, at, headers });
        },

        presignDownload(key: string, at = new Date()): Presigned {
            return presign({ ...base, method: 'GET', key, expiresIn: READ_URL_SECONDS, at });
        },
    };
}
