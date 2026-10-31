/* What counts as a photograph, in one place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT `file.type` AT FIVE CALL SITES.
 *
 * Every upload on the driver's side read `file.type` and sent it to the
 * server as the content type. That is the browser's guess, and for a file
 * chosen from the photo library it is a good one: the library knows what it
 * stored. For a file handed back by a CAMERA it is not.
 *
 * Android cameras return `image/jpg` (not a real MIME type), and some
 * return an empty string because the picture was passed back as a stream
 * with no declared type. iOS can hand back HEIC. The server's allow-list
 * takes `image/jpeg`, `image/png`, `image/webp` and `image/heic`, so an
 * empty type or `image/jpg` is refused with "unsupported file type" --
 * surfacing, after the idempotency fix, as "Invalid request
 * (contentType: unsupported file type)".
 *
 * That is why choosing from the library worked and taking a picture did
 * not. Same screen, same button, different source of the same field.
 *
 * So: the type is DECIDED here rather than trusted. From the browser when
 * it says something we accept, from the file name when it does not, and
 * null when neither can tell -- which is a refusal the courier can act on
 * instead of a four-hundred from the far end of a pharmacy car park.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE `accept` ATTRIBUTE IS NOT A SECURITY CONTROL.
 *
 * It is a hint to the file chooser. On Android it also decides which apps
 * the chooser offers: a list of explicit MIME types narrows the intent and
 * is a documented way to end up with a camera that is missing, or that
 * returns something the same list then rejects. `image/*` is the broad,
 * well-trodden path, and the real check is this module, run against the
 * file that actually arrives.
 */

/** What the server's bucket will take. Mirrors ALLOWED_CONTENT_TYPES in
 *  server/src/core/files/storage.ts; a type missing from either is refused
 *  by the other, so they are worth reading together. */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** A phone photo is a couple of megabytes; twenty is a mistake or an attack. */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** What a chooser should offer. See the header: broad on purpose. */
export const PHOTO_ACCEPT = 'image/*';

/* The spellings a camera actually produces, against what the server calls
   them. `image/jpg` is not a registered type and cameras emit it anyway. */
const SYNONYMS: Record<string, string> = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png',
    'image/heif': 'image/heic',
    'image/heic-sequence': 'image/heic',
    'image/heif-sequence': 'image/heic',
};

/* The last resort, when the browser declared nothing at all. */
const BY_EXTENSION: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heic',
};

const allowed = (t: string): boolean => (PHOTO_TYPES as readonly string[]).includes(t);

/**
 * The content type to send for this file, or null if it is not a photograph
 * this application can store.
 *
 * Null is a real answer and the caller must handle it: it means the file
 * named nothing we recognise and had no usable extension either, which is
 * worth saying to the courier before anything is uploaded.
 */
export function photoType(file: { type?: string; name?: string }): string | null {
    const declared = (file.type ?? '').trim().toLowerCase();
    if (allowed(declared)) return declared;

    const synonym = SYNONYMS[declared];
    if (synonym !== undefined) return synonym;

    /* Nothing usable from the browser. The name is all that is left, and a
       camera that declares no type usually still names the file. */
    const dot = (file.name ?? '').lastIndexOf('.');
    if (dot > -1) {
        const ext = (file.name ?? '').slice(dot + 1).toLowerCase();
        const byExt = BY_EXTENSION[ext];
        if (byExt !== undefined) return byExt;
    }

    /* A camera that gave neither a type nor a name. Rather than refuse a
       photograph that is almost certainly a JPEG -- and leave a courier at
       a door unable to record anything -- send the type the overwhelming
       majority of phone cameras produce. The server still validates the
       bytes it is handed, and a wrong guess fails there rather than here,
       which is the better place for it to fail. */
    if (declared === '' && (file.name ?? '') === '') return 'image/jpeg';

    return null;
}

/** Why this file cannot be used, in words a courier can act on. */
export function photoProblem(file: { type?: string; name?: string; size?: number }): string | null {
    if (photoType(file) === null) {
        return 'That is not a photo this app can store. Take one with the camera, or pick a JPEG or PNG.';
    }
    if ((file.size ?? 0) > MAX_PHOTO_BYTES) {
        return 'That photo is too large to send. Take another.';
    }
    return null;
}
