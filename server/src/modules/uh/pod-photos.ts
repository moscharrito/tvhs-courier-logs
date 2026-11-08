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

/** The return sheet supplied AFTER the hand-back was recorded, bound to the
 *  one order it was attached to rather than to a batch. See returnPhoto. */
export const RETURN_KIND = ['return_form'] as const;

/** Why a stop could not be completed, photographed at the door. Always one
 *  order's own picture: a dry run is a thing that happened at one address,
 *  so there is no batch path here and none of batchPhotoOn's complications. */
export const ATTEMPT_KIND = ['exception'] as const;

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
 * The collection form: the paper the PHARMACY signed when it handed the
 * packages over, photographed at the counter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT NEEDS ITS OWN QUERY INSTEAD OF JUST ANOTHER `kind`.
 *
 * One form covers the whole trolley. A courier collecting eleven orders
 * photographs one sheet, so the `files` row is written with order_id NULL
 * -- deliberately, because it does not belong to any single delivery -- and
 * the collection flow put its id on EVERY order's `picked_up` custody
 * event instead. That is the correct shape for the fact being recorded.
 *
 * `storedPhoto` above looks photographs up with `WHERE order_id = ?`. So
 * the collection form was referenced by the chain of custody and could not
 * be found by the document that prints the chain of custody. Nothing threw
 * and nothing was lost; the picture simply was not there, and because a
 * form photographed AT THE DOOR does carry an order id and did appear, the
 * common case looked right and this went unnoticed until somebody
 * collected at a counter and went looking for the picture afterwards.
 *
 * So this walks the other way round: from the order's custody events to
 * the file they name. It is the only path that reaches a batch document.
 *
 * NEWEST EVENT WINS, and ordered by id rather than by `at`: `at` is a claim
 * a phone made and id is the append order, which is the chain. A courier
 * who collected, was turned back, and collected again has two pickups, and
 * the second one's form is the one that describes the packages in the van.
 */
export async function collectionPhoto(
    client: Client, projectId: number, orderId: number,
): Promise<StoredPhoto | null> {
    return batchPhotoOn(client, projectId, orderId, 'picked_up');
}

/**
 * The return form: the paper the PHARMACY signed when undelivered packages
 * came BACK over the counter, photographed by the courier.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE OTHER END OF THE SAME JOURNEY, AND IT WAS WEARING THE WRONG LABEL.
 *
 * Returns have photographed part 3 of the docket since the signature came
 * off glass, and the picture goes in exactly the shape a collection does:
 * `files.order_id` NULL, because one sheet covers everything handed back
 * together, with its id on every order's `returned` custody event.
 *
 * Which meant `collectionPhoto` found it. That query asked for "the newest
 * custody event naming an unbound file", and on a returned delivery the
 * newest one is the return, not the collection -- so the document printed
 * the return form under the heading "The pharmacy's collection form", over
 * a caption saying it was signed when the pharmacy HANDED THE PACKAGES
 * OVER. The one document whose job is to say what happened to a delivery
 * described the end of its life as the beginning.
 *
 * Both now name the event they mean. A delivery that was collected at a
 * counter and later came back has two batch forms and shows both, which is
 * the truth: two handovers happened and each has its own sheet.
 */
export async function returnPhoto(
    client: Client, projectId: number, orderId: number,
): Promise<StoredPhoto | null> {
    /* THE ATTACHED SHEET WINS OVER THE BATCH ONE, and that order is the
       point rather than an accident of which query runs first.

       Nobody attaches a return form to an order that already has a good
       one. The only reasons to reach for that path are that the batch
       photograph is missing -- the upload failed at the counter and the
       courier was offered the choice to carry on rather than stand there
       holding medication -- or that it is unreadable. Either way the later
       picture is the better evidence, which is this file's standing rule:
       "a courier who photographed twice did so because the first one was
       no good". Replacement by appending, same as everywhere else. */
    const attached = await storedPhoto(client, projectId, orderId, RETURN_KIND);
    if (attached) return attached;
    return batchPhotoOn(client, projectId, orderId, 'returned');
}

/**
 * The photograph a courier took when a stop could not be completed.
 *
 * No batch half, unlike the two forms above: those are one sheet covering a
 * trolley, and this is a closed door at one address. Newest wins, for the
 * standing reason in this file -- a courier who photographed twice did so
 * because the first one was no good.
 */
export async function attemptPhoto(
    client: Client, projectId: number, orderId: number,
): Promise<StoredPhoto | null> {
    return storedPhoto(client, projectId, orderId, ATTEMPT_KIND);
}

/**
 * What to tell a screen about the attempt photograph.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS OPTIONAL, AND THAT CHANGES THE THIRD ANSWER.
 *
 * returnFormStatus below says "something came back and no sheet was
 * recorded", because a return with no signed sheet is a gap worth naming.
 * A dry run with no photograph is not: there is nothing to photograph at an
 * address that does not exist, and a card on every failed delivery saying
 * so would train people to read past it.
 *
 * So the absence is silent, and the only thing said out loud is a
 * photograph that exists and cannot be served -- which is a fault on this
 * server, not a fact about the stop, and the one case where "there is no
 * photograph" would be a lie.
 */
export async function attemptPhotoStatus(
    client: Client, storage: FileStorage, projectId: number, orderId: number,
): Promise<{ available: boolean; reason: string }> {
    const found = await attemptPhoto(client, projectId, orderId);
    if (!found) return { available: false, reason: '' };
    if (!storage.available) {
        return {
            available: false,
            reason: 'The courier photographed why this could not be delivered. File storage is not '
                + 'configured on this server, so it cannot be shown.',
        };
    }
    return { available: true, reason: '' };
}

/**
 * What to tell a screen about the return form.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THREE ANSWERS, AND THEY ARE GENUINELY DIFFERENT TO A READER.
 *
 *   nothing came back, so there is nothing to say;
 *   something came back and here is the signed sheet;
 *   something came back and the sheet cannot be served from here.
 *
 * The third is why this asks storage instead of assuming. A flag the server
 * guesses is a link to a 404, and "there is no photograph" told to somebody
 * when the truth is "this server cannot reach the bucket" makes them stop
 * asking about medication that may genuinely be missing.
 *
 * `returnedAt` rather than the status: a return is a custody fact and never
 * an outcome, so a failed delivery sitting in a van and one already back on
 * a counter share a status and are not the same thing. See
 * modules/uh/returns.ts.
 *
 * HERE RATHER THAN IN EITHER ROUTER, because both the pharmacy's copy and
 * ours show this and they are supposed to agree. The last time one copy
 * learned about a photograph and the other did not, dispatch spent a
 * fortnight downloading a proof of delivery with nothing in it. That is the
 * whole reason this file exists.
 */
export async function returnFormStatus(
    client: Client, storage: FileStorage, projectId: number, orderId: number, returnedAt: string | null,
): Promise<{ available: boolean; reason: string }> {
    if (!returnedAt) return { available: false, reason: '' };
    const found = await returnPhoto(client, projectId, orderId);
    if (!found) {
        return {
            available: false,
            reason: 'This came back to a pharmacy, but no photograph of the signed return form was recorded.',
        };
    }
    if (!storage.available) {
        return {
            available: false,
            reason: 'The signed return form was photographed. File storage is not configured on this '
                + 'server, so it cannot be shown.',
        };
    }
    return { available: true, reason: '' };
}

/**
 * The newest unbound photograph named by a custody event of one type.
 *
 * `f.order_id IS NULL` is the half that keeps this from printing the same
 * picture twice: a form photographed at the door is bound to the order, is
 * already found by storedPhoto, and is a different page of this document.
 * Only the unbound batch ones come through here.
 *
 * Ordered by id rather than by `at`: `at` is a claim a phone made and id is
 * the append order, which is the chain. A courier who collected, was turned
 * back, and collected again has two pickups, and the second one's form is
 * the one that describes the packages in the van.
 */
async function batchPhotoOn(
    client: Client, projectId: number, orderId: number, type: 'picked_up' | 'returned',
): Promise<StoredPhoto | null> {
    const rs = await client.execute({
        /* Joined to `files` so a dangling id -- a row removed by retention,
           an upload that never completed -- comes back as no photograph
           rather than as a key that fetches nothing. */
        sql: `SELECT f.id, f.s3_key, f.content_type
                FROM custody_events e
                JOIN files f ON f.id = e.file_id
               WHERE e.project_id = ? AND e.order_id = ? AND e.type = ?
                 AND e.file_id IS NOT NULL
                 AND f.status = 'stored'
                 AND f.order_id IS NULL
               ORDER BY e.id DESC LIMIT 1`,
        args: [projectId, orderId, type],
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

        /* The pharmacy's end of the chain. Not gated on data.photo.available
           -- that flag is about whether a DELIVERY photograph exists and is
           printable, and a collection form is a different fact: it can be
           the only picture on a delivery that was handed over on paper. */
        const collected = await collectionPhoto(client, projectId, orderId);
        if (collected) data.collectionPhoto = { bytes: await fetchPhoto(storage, collected.key) };

        /* The other end of the chain, and the only proof that undelivered
           medication got back to a counter. Until now this picture was
           taken on every return and printed by nothing -- or, worse,
           printed as the collection form. See returnPhoto. */
        /* WHAT HAPPENED AT THE DOOR, on a stop that did not end in a
           handover. Addendum 1 bills every item on an attempted delivery,
           so this is the picture an invoice line is defended with. */
        const why = await attemptPhoto(client, projectId, orderId);
        if (why) data.attemptPhoto = { bytes: await fetchPhoto(storage, why.key) };

        const back = await returnPhoto(client, projectId, orderId);
        if (back) data.returnPhoto = { bytes: await fetchPhoto(storage, back.key) };
    } catch {
        /* See the header. The record is worth more than the pictures. */
    }
}
