/* Presigned S3 URLs, signed here rather than by the AWS SDK.
 *
 * Why not the SDK: presigning is the only AWS operation this platform
 * performs, and @aws-sdk/client-s3 plus the presigner is tens of megabytes of
 * transitive dependencies to reach it. On a system holding PHI, dependency
 * surface is a security property, not a packaging preference.
 *
 * The obvious risk in hand-rolling a signature is getting it subtly wrong in
 * a way that only shows up against real AWS. That is answered by AWS's own
 * published worked example: the test suite reproduces the exact signature
 * from the "Authenticating Requests: Using Query Parameters" documentation,
 * byte for byte. If the canonical request, the string to sign and the key
 * derivation are all right for that vector, they are right.
 *
 * What this deliberately does NOT support, because nothing here needs it:
 * temporary STS credentials (no x-amz-security-token), path-style addressing,
 * or keys containing characters outside the set the key builder produces.
 */

import crypto from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** Presigned URLs never sign the body: the browser has not produced it yet. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * RFC 3986 encoding, which is not what encodeURIComponent does.
 *
 * encodeURIComponent leaves ! ' ( ) * alone; AWS expects them percent-encoded,
 * and a signature computed over a differently encoded string is simply wrong.
 */
export function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Each path segment is encoded; the separators are not. */
export function encodeKeyPath(key: string): string {
    return `/${key.split('/').map(uriEncode).join('/')}`;
}

/** 20130524T000000Z and 20130524, the two forms AWS wants. */
export function amzDates(at: Date): { amzDate: string; dateStamp: string } {
    const amzDate = `${at.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface PresignInput {
    method: 'GET' | 'PUT' | 'DELETE';
    bucket: string;
    region: string;
    key: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Seconds. S3 caps this at seven days. */
    expiresIn: number;
    at: Date;
    /** Headers the caller will send and that must therefore be signed. */
    headers?: Record<string, string>;
    /** Endpoint override, for a test double. Host only, no scheme. */
    host?: string;
}

export interface Presigned {
    url: string;
    /** Exactly the headers the caller must send, or the signature will not match. */
    headers: Record<string, string>;
    expiresAt: string;
}

/** us-east-1 has no region in the host; every other region does. */
export function bucketHost(bucket: string, region: string): string {
    return region === 'us-east-1'
        ? `${bucket}.s3.amazonaws.com`
        : `${bucket}.s3.${region}.amazonaws.com`;
}

export function presign(input: PresignInput): Presigned {
    const host = input.host ?? bucketHost(input.bucket, input.region);
    const { amzDate, dateStamp } = amzDates(input.at);
    const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

    /* Host is always signed. Anything else the caller will send has to be
     * signed too: S3 rejects a PUT whose encryption headers were not part of
     * the signature, which is exactly what we want, because it means the
     * bucket cannot be written to without SSE-KMS. */
    const headers: Record<string, string> = { host, ...(input.headers ?? {}) };
    const canonicalHeaderNames = Object.keys(headers)
        .map((h) => h.toLowerCase())
        .sort();
    const byLowerName = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonicalHeaders = `${canonicalHeaderNames.map((h) => `${h}:${byLowerName.get(h)}`).join('\n')}\n`;
    const signedHeaders = canonicalHeaderNames.join(';');

    const query: Record<string, string> = {
        'X-Amz-Algorithm': ALGORITHM,
        'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(input.expiresIn),
        'X-Amz-SignedHeaders': signedHeaders,
    };
    const canonicalQuery = Object.keys(query)
        .sort()
        .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
        .join('&');

    const canonicalRequest = [
        input.method,
        encodeKeyPath(input.key),
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, input.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
        url: `https://${host}${encodeKeyPath(input.key)}?${canonicalQuery}&X-Amz-Signature=${signature}`,
        headers: input.headers ?? {},
        expiresAt: new Date(input.at.getTime() + input.expiresIn * 1000).toISOString(),
    };
}

/** Exposed so the tests can check the intermediate values, not just the end. */
export function canonicalPartsForTest(input: PresignInput) {
    const host = input.host ?? bucketHost(input.bucket, input.region);
    const { amzDate, dateStamp } = amzDates(input.at);
    const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
    const headers: Record<string, string> = { host, ...(input.headers ?? {}) };
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const byLowerName = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const signedHeaders = names.join(';');
    const query: Record<string, string> = {
        'X-Amz-Algorithm': ALGORITHM,
        'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(input.expiresIn),
        'X-Amz-SignedHeaders': signedHeaders,
    };
    const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`).join('&');
    const canonicalRequest = [
        input.method, encodeKeyPath(input.key), canonicalQuery,
        `${names.map((h) => `${h}:${byLowerName.get(h)}`).join('\n')}\n`, signedHeaders, UNSIGNED_PAYLOAD,
    ].join('\n');
    return {
        canonicalRequest,
        stringToSign: [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n'),
    };
}

/* ─────────────────────────────── signing a request you send yourself ──────
 *
 * Presigning above hands a URL to somebody else's browser, so the body is
 * unknown and the signature travels in the query string. Amazon Location is
 * the other shape: this process makes the call itself, over a JSON body it
 * has in its hand, and AWS wants the signature in an Authorization header
 * with the body's hash inside it.
 *
 * Everything underneath is the same and is deliberately not duplicated: the
 * canonical request, the string to sign and the four-step key derivation are
 * the functions above, proved byte for byte against AWS's own published
 * worked example. What differs is three things -- the payload is hashed
 * rather than declared UNSIGNED-PAYLOAD, x-amz-date and x-amz-content-sha256
 * are signed headers rather than query parameters, and the result goes in a
 * header. Getting a fourth thing to differ is the bug this comment exists to
 * make obvious in review.
 *
 * STILL NO TEMPORARY CREDENTIALS. Same as above: no x-amz-security-token, so
 * this wants a long-lived access key, which is what the Render environment
 * already holds for the bucket.
 */

export interface SignedRequestInput {
    method: 'GET' | 'POST';
    /** Full host, no scheme. */
    host: string;
    /** Absolute path, already encoded. */
    path: string;
    region: string;
    /** The AWS service name in the credential scope: 'geo', 's3', and so on. */
    service: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** The exact bytes that will be sent. '' for a GET. */
    body: string;
    at: Date;
    /** Extra headers to send and therefore to sign. */
    headers?: Record<string, string>;
}

/**
 * The headers to send with a request, Authorization included.
 *
 * Send exactly these and exactly this body. A header added afterwards that
 * was not signed, or a body re-serialised into different bytes, produces a
 * signature mismatch and AWS answers 403 with nothing useful in it.
 */
export function signedHeaders(input: SignedRequestInput): Record<string, string> {
    const { amzDate, dateStamp } = amzDates(input.at);
    const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
    const payloadHash = sha256Hex(input.body);

    const headers: Record<string, string> = {
        host: input.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        ...(input.headers ?? {}),
    };

    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const byLowerName = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonicalHeaders = `${names.map((h) => `${h}:${byLowerName.get(h)}`).join('\n')}\n`;
    const signed = names.join(';');

    const canonicalRequest = [
        input.method,
        input.path,
        /* No query string on any call this makes. Kept explicit rather than
           omitted, because the canonical request has a line for it either
           way and a missing newline is a silent 403. */
        '',
        canonicalHeaders,
        signed,
        payloadHash,
    ].join('\n');

    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, input.region);
    const serviceKey = hmac(regionKey, input.service);
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
        ...headers,
        Authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, `
            + `SignedHeaders=${signed}, Signature=${signature}`,
    };
}
