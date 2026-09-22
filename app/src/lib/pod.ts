/* Proof of delivery: a photograph taken at the door.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PHOTOGRAPH IS NEVER WRITTEN TO THE OUTBOX, and that is the whole shape
 * of this file.
 *
 * Every other courier write goes through lib/queue: it is persisted to disk,
 * retried for as long as it takes, and a pharmacy basement with no signal
 * records the handover at the time it happened. That is exactly the wrong
 * behaviour here. A doorstep photograph shows a patient's front door, often
 * with their name on the package in shot, and the outbox is a file on a
 * handset that couriers share. A queued photo is PHI sitting on a phone for
 * as long as the signal stays bad.
 *
 * So the photo is uploaded now or not at all. It goes straight from the
 * camera to S3 through a presigned PUT, and if that fails the delivery is
 * recorded without it and the courier is told. A delivery with no photo is a
 * delivery; a photo left on a phone is an incident.
 *
 * THE BYTES NEVER TOUCH OUR SERVER. Three steps, which is the contract
 * core/files/routes.ts already defines: ask for a signed PUT, send the bytes
 * to S3, say it worked. The server records what is about to exist and what
 * did exist, and never handles the image itself.
 *
 * NOTHING IS OFFERED UNTIL STORAGE IS REAL. `podAvailable` asks the server,
 * which answers from its own configuration; while FILES_ENABLED is false it
 * says no, the step is not drawn, and no camera is ever opened. The server
 * refuses the upload at the same gate even if a client asks anyway. Both of
 * those stay true until the AWS BAA in ticket 0.10 is signed and the bucket
 * is configured, because until then there is nowhere lawful to put it.
 * ───────────────────────────────────────────────────────────────────────── */

import * as ImagePicker from 'expo-image-picker';
import { get, post } from './api';

/** What the server says about its own storage. */
export interface PodCapability {
    available: boolean;
    reason: string | null;
}

export async function podAvailable(token: string, code: string): Promise<PodCapability> {
    try {
        return await get<PodCapability>(`/api/projects/${code}/uh/files/status/check`, token);
    } catch {
        /* Unreachable or refused: treat as unavailable. Guessing "yes" here
           would open a camera and then throw the photo away. */
        return { available: false, reason: 'Could not ask the server about photo storage.' };
    }
}

export interface Captured {
    uri: string;
    contentType: string;
    bytes: number;
}

export type CaptureResult =
    | { kind: 'captured'; photo: Captured }
    | { kind: 'cancelled' }
    | { kind: 'refused'; message: string };

/**
 * The camera, not the photo library.
 *
 * A picture chosen from the roll is not proof that anybody stood at a door,
 * and offering the library invites a courier to attach whatever is to hand
 * when they are in a hurry. This asks for permission first and says plainly
 * what a refusal means rather than failing silently at the shutter.
 */
export async function capturePhoto(): Promise<CaptureResult> {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
        return {
            kind: 'refused',
            message: permission.canAskAgain
                ? 'The camera is needed for a proof of delivery photo.'
                : 'Camera access is off for this app. Turn it on in Settings to add a photo.',
        };
    }

    const shot = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        /* Compressed hard on purpose. A doorstep photo is evidence that a
           parcel reached a door, not a portrait: 0.5 keeps it legible at a
           couple of hundred kilobytes, which matters on a courier's data
           allowance and keeps the upload inside a bad signal. */
        quality: 0.5,
        exif: false,
        allowsEditing: false,
    });

    if (shot.canceled || shot.assets.length === 0) return { kind: 'cancelled' };
    const asset = shot.assets[0]!;
    return {
        kind: 'captured',
        photo: {
            uri: asset.uri,
            contentType: asset.mimeType ?? 'image/jpeg',
            bytes: asset.fileSize ?? 0,
        },
    };
}

interface UploadTicket {
    id: number;
    upload: { method: string; url: string; headers: Record<string, string> };
}

export type UploadResult =
    | { kind: 'stored'; fileId: number }
    | { kind: 'failed'; message: string };

/**
 * Camera roll to S3, in the three steps the server defines.
 *
 * `bytes` is sent up front so an oversized photo is refused before it burns
 * a courier's data rather than after. Some platforms do not report a size on
 * the asset, so it is measured from the blob when it comes back as zero.
 */
export async function uploadPhoto(
    token: string, code: string, orderId: number, photo: Captured,
): Promise<UploadResult> {
    try {
        const blob = await (await fetch(photo.uri)).blob();
        const bytes = photo.bytes > 0 ? photo.bytes : blob.size;
        if (bytes <= 0) return { kind: 'failed', message: 'The photo came back empty.' };

        const ticket = await post<UploadTicket>(`/api/projects/${code}/uh/files`, token, {
            kind: 'doorstep',
            contentType: photo.contentType,
            bytes,
            orderId,
        });

        /* Exactly the headers the server signed, and no others, or S3
           refuses the write. That is what makes an unencrypted object
           impossible rather than merely discouraged. */
        const put = await fetch(ticket.upload.url, {
            method: ticket.upload.method,
            headers: ticket.upload.headers,
            body: blob,
        });
        if (!put.ok) {
            return { kind: 'failed', message: `The photo could not be sent (${put.status}).` };
        }

        await post(`/api/projects/${code}/uh/files/${ticket.id}/stored`, token, { bytes });
        return { kind: 'stored', fileId: ticket.id };
    } catch (err) {
        /* The row left behind says pending, which is exactly what it is: an
           upload that never finished. The bucket lifecycle rule expires the
           object that was never written. Nothing here retries, because
           retrying means holding the photo. */
        return {
            kind: 'failed',
            message: err instanceof Error ? err.message : 'The photo could not be sent.',
        };
    }
}
