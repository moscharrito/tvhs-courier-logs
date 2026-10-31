/* What a camera hands back, and what the server will take.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE REPORT THIS EXISTS FOR.
 *
 * 31 October, from a real handset: choosing a photo from the library
 * worked and taking one with the camera did not. Same screen, same button,
 * same upload path -- the only difference being where the File came from.
 *
 * `file.type` is the browser's guess. A file out of the photo library
 * carries a good one, because the library knows what it stored. A file out
 * of a camera often carries `image/jpg`, which is not a registered MIME
 * type and which no allow-list contains, or an empty string because the
 * picture came back as a stream with nothing declared.
 *
 * So the code refused a photograph for not being a photograph, and the
 * server refused it a second time for an unsupported content type. Every
 * case below is a spelling a real camera produces; none of it is theory.
 */

import { describe, it, expect } from 'vitest';
import { photoType, photoProblem, PHOTO_ACCEPT, PHOTO_TYPES, MAX_PHOTO_BYTES } from './photos';

const file = (type: string, name = 'IMG_0001.jpg', size = 1024) => ({ type, name, size });

describe('deciding a photo\'s content type', () => {
    it('keeps what the browser says when the server would take it', () => {
        for (const t of PHOTO_TYPES) expect(photoType(file(t))).toBe(t);
    });

    it('translates the spellings cameras actually emit', () => {
        /* image/jpg is the one that bit us: not a registered type, and
           emitted by Android cameras all the same. */
        expect(photoType(file('image/jpg'))).toBe('image/jpeg');
        expect(photoType(file('image/pjpeg'))).toBe('image/jpeg');
        expect(photoType(file('image/x-png', 'shot.png'))).toBe('image/png');
        expect(photoType(file('image/heif', 'IMG_0002.heic'))).toBe('image/heic');
    });

    it('is not fooled by case or stray whitespace', () => {
        expect(photoType(file('IMAGE/JPEG'))).toBe('image/jpeg');
        expect(photoType(file(' image/png ', 'a.png'))).toBe('image/png');
    });

    it('falls back to the file name when the browser declares nothing', () => {
        /* The empty-type camera. The name is all that is left. */
        expect(photoType(file('', 'IMG_2291.JPG'))).toBe('image/jpeg');
        expect(photoType(file('', 'doorstep.png'))).toBe('image/png');
        expect(photoType(file('', 'counter.HEIC'))).toBe('image/heic');
        expect(photoType(file('', 'form.webp'))).toBe('image/webp');
    });

    it('assumes a JPEG when a camera gives neither a type nor a name', () => {
        /* Deliberate, and the comment in photos.ts argues it: the
           alternative is a courier at a door who cannot record anything,
           and a wrong guess fails on the server rather than here. */
        expect(photoType({ type: '', name: '' })).toBe('image/jpeg');
        expect(photoType({})).toBe('image/jpeg');
    });

    it('still refuses something that is plainly not a photograph', () => {
        /* The check has to keep meaning something. A PDF and a spreadsheet
           both name themselves clearly and neither belongs in this field. */
        expect(photoType(file('application/pdf', 'docket.pdf'))).toBeNull();
        expect(photoType(file('text/csv', 'list.csv'))).toBeNull();
        expect(photoType(file('', 'list.csv'))).toBeNull();
    });
});

describe('what the courier is told', () => {
    it('says nothing when the file is usable', () => {
        expect(photoProblem(file('image/jpg'))).toBeNull();
        expect(photoProblem(file('', 'IMG_1.JPG'))).toBeNull();
    });

    it('names the problem for a file that is not a photo', () => {
        expect(photoProblem(file('application/pdf', 'docket.pdf'))).toMatch(/not a photo/);
    });

    it('names the problem for one too large to send', () => {
        expect(photoProblem({ ...file('image/jpeg'), size: MAX_PHOTO_BYTES + 1 })).toMatch(/too large/);
    });
});

describe('what the chooser is asked for', () => {
    it('is broad, because the accept attribute is a hint and not a check', () => {
        /* A list of explicit MIME types narrows the Android intent and is a
           documented way to end up with a camera that is missing, or that
           returns something the same list then rejects. The real check is
           photoProblem, run against the file that actually arrives. */
        expect(PHOTO_ACCEPT).toBe('image/*');
    });
});
