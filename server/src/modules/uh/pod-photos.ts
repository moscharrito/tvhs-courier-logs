/* The photographs that belong to a proof of delivery.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE.
 *
 * Two routes build this document: the client portal's, which University
 * Health read, and the administrator's, which is our own copy of the same
 * record. They are supposed to be identical, and they were not.
 *
 * The client's learned to carry photographs. The administrator's still passed
 * `photoAvailable: false`, a line that was correct before there was a file
 * service and became a lie the moment one existed. So dispatch downloaded a
 * proof of delivery with no picture in it while the client downloaded the same
 * delivery with two, and nothing anywhere said they should match.
 *
 * Both now call the function below. A second copy of "find the photographs
 * for a delivery" is exactly the thing that drifted, and one of the copies is
 * always the one somebody forgets.
 *
 * NEVER THROWS. A proof of delivery missing its photograph is worth printing;
 * a 500 in place of one is not. Every failure here leaves the document without
 * the picture and lets the rest of it through.
 */

import type { Client } from '@libsql/client';
import type { FileStorage } from '../../core/files/storage';
import type { PodData } from './pod';

/** What proves a handover, newest first. The signed paper form replaced the
 *  drawn signature; a doorstep picture proves a drop where nobody answered. */
export const PROOF_KINDS = ['courier_form', 'doorstep'] as const;

/** Identification, photographed where the pharmacy stamped the form. */
export const ID_KIND = ['patient_id'] as const;

export interface StoredPhoto {
    id: number;
    key: string;
    contentType: string;
}

/**
 * The newest stored photograph of the given kinds for one delivery.
 *
 * `status = 'stored'` matters: a pending row is an upload that started and
 * never finished, and putting one in a document produces a page that will not
 * render rather than a picture.
 *
 * Newest wins. A courier who photographed twice did so because the first one
 * was no good.
 */
export async function storedPhoto(
    client: Client, projectId: number, orderId: number, kinds: readonly string[] = PROOF_KINDS,
): Promise<StoredPhoto | null> {
    const list = kinds.map(() => '?').join(',');
    const rs = await client.execute({
        sql: `SELECT id, s3_key, content_type FROM files
              WHERE project_id = ? AND order_id = ? AND kind IN (${list}) AND status = 'stored'
              ORDER BY id DESC LIMIT 1`,
        args: [projectId, orderId, ...kinds],
    });
    const row = rs.rows[0];
    return row
        ? { id: Number(row['id']), key: String(row['s3_key']), contentType: String(row['content_type']) }
        : null;
}

/**
 * The JPEG behind a stored key, or undefined.
 *
 * Through the same presigned GET a browser would use, rather than a second
 * code path with its own credentials: whatever is true of one is true of the
 * other, and there is one place where an expiry or a key policy can be wrong.
 */
export async function fetchPhoto(storage: FileStorage, key: string): Promise<Buffer | undefined> {
    try {
        const signed = storage.presignDownload(key);
        const res = await fetch(signed.url);
        if (!res.ok) return undefined;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return undefined;
    }
}

/** Whether a proof photograph exists, asked before the document is built,
 *  because it decides what the document SAYS as well as what it carries. */
export async function hasProofPhoto(client: Client, projectId: number, orderId: number): Promise<boolean> {
    try {
        return (await storedPhoto(client, projectId, orderId)) !== null;
    } catch {
        return false;
    }
}

/**
 * Put the photographs into a document that has already been loaded.
 *
 * Mutates rather than returns a copy: PodData is large, and a caller that
 * forgot to use the returned value would silently print a document with no
 * pictures, which is the failure this file exists to stop happening twice.
 */
export async function attachPhotos(
    client: Client, storage: FileStorage, projectId: number, orderId: number, data: PodData,
): Promise<void> {
    if (!storage.available) return;
    try {
        const proof = await storedPhoto(client, projectId, orderId);
        if (proof && data.photo.available) data.photo.bytes = await fetchPhoto(storage, proof.key);

        const ident = await storedPhoto(client, projectId, orderId, ID_KIND);
        if (ident) data.idPhoto = { bytes: await fetchPhoto(storage, ident.key) };
    } catch {
        /* See the header. The record is worth more than the pictures. */
    }
}
