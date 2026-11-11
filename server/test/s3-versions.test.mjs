/* Reading a ListObjectVersions response.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL.
 *
 * scripts/restore-pods.mjs brings back proof-of-delivery photographs by
 * removing the delete markers hiding them. The call it makes --
 * `DELETE /key?versionId=...` -- is the one S3 operation that destroys data
 * permanently and that nothing can undo. Pointed at a delete marker it is a
 * restore. Pointed at a real version it is the 9 November loss happening
 * again, deliberately, and for good.
 *
 * The only thing between those two outcomes is whether this parse put an id
 * in the right list. So these are not tests of a convenience helper; they
 * are the tests of the safety property.
 */

import { describe, it, expect } from 'vitest';
import { parseVersionPage, verdictFor, unescapeXml } from '../src/core/files/s3-versions.ts';

/* A response in the shape S3 actually sends: one key whose real version is
   still there with a delete marker on top of it, one key that is current,
   and the markers interleaved rather than grouped, which is how S3 orders
   them -- by key, newest first, regardless of which kind each entry is. */
const PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>izy-pods</Name>
  <Prefix>uh/2026-11-05/</Prefix>
  <KeyMarker></KeyMarker>
  <VersionIdMarker></VersionIdMarker>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <DeleteMarker>
    <Key>uh/2026-11-05/order-4123/pod/aaaa-1111.jpg</Key>
    <VersionId>MARKER_VERSION_ID</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2026-11-09T12:08:47.000Z</LastModified>
    <Owner><ID>abc</ID></Owner>
  </DeleteMarker>
  <Version>
    <Key>uh/2026-11-05/order-4123/pod/aaaa-1111.jpg</Key>
    <VersionId>REAL_VERSION_ID</VersionId>
    <IsLatest>false</IsLatest>
    <LastModified>2026-11-05T20:45:04.000Z</LastModified>
    <ETag>&quot;9b2cf5&quot;</ETag>
    <Size>184320</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
  <Version>
    <Key>uh/2026-11-05/order-4124/pod/bbbb-2222.jpg</Key>
    <VersionId>UNTOUCHED_VERSION_ID</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2026-11-05T21:02:11.000Z</LastModified>
    <ETag>&quot;771aa0&quot;</ETag>
    <Size>201114</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
</ListVersionsResult>`;

describe('parsing a page of object versions', () => {
    it('keeps real versions and delete markers in separate lists', () => {
        /* THE ONE THAT MATTERS. If a <Version> can arrive in `markers`, the
           script deletes a photograph instead of restoring it. */
        const page = parseVersionPage(PAGE);

        expect(page.versions.map((v) => v.versionId))
            .toEqual(['REAL_VERSION_ID', 'UNTOUCHED_VERSION_ID']);
        expect(page.markers.map((m) => m.versionId)).toEqual(['MARKER_VERSION_ID']);
    });

    it('never lets a real version id appear among the markers', () => {
        const page = parseVersionPage(PAGE);
        const markerIds = new Set(page.markers.map((m) => m.versionId));
        for (const v of page.versions) expect(markerIds.has(v.versionId)).toBe(false);
        /* And every marker says so in its own type, which is what the
           delete call asserts on rather than trusting its caller. */
        for (const m of page.markers) expect(m.kind).toBe('DeleteMarker');
    });

    it('does not mistake <VersionId> for a <Version> block', () => {
        /* `<Version>` and `<VersionId>` share six characters and the second
           appears inside the first. Two versions here, not four. */
        expect(parseVersionPage(PAGE).versions).toHaveLength(2);
    });

    it('reads IsLatest, which is what says a key is hidden right now', () => {
        const page = parseVersionPage(PAGE);
        expect(page.markers[0].isLatest).toBe(true);
        expect(page.versions[0].isLatest).toBe(false);
        expect(page.versions[1].isLatest).toBe(true);
    });

    it('reads the dates, because the thirty-day clock is computed off them', () => {
        expect(parseVersionPage(PAGE).markers[0].lastModified).toBe('2026-11-09T12:08:47.000Z');
    });

    it('reads size, so an empty object cannot look like a restored photograph', () => {
        expect(parseVersionPage(PAGE).versions[0].size).toBe(184320);
    });

    it('says when there is another page, and carries BOTH markers', () => {
        /* Key marker alone is not enough: a key with more versions than fit
           on a page straddles the boundary, and paging on the key alone
           re-reads that key for ever. */
        const truncated = PAGE
            .replace('<IsTruncated>false</IsTruncated>',
                '<IsTruncated>true</IsTruncated>'
                + '<NextKeyMarker>uh/2026-11-05/order-4124/pod/bbbb-2222.jpg</NextKeyMarker>'
                + '<NextVersionIdMarker>UNTOUCHED_VERSION_ID</NextVersionIdMarker>');
        const page = parseVersionPage(truncated);
        expect(page.truncated).toBe(true);
        expect(page.nextKeyMarker).toBe('uh/2026-11-05/order-4124/pod/bbbb-2222.jpg');
        expect(page.nextVersionIdMarker).toBe('UNTOUCHED_VERSION_ID');
    });

    it('is empty and not truncated for a prefix with nothing under it', () => {
        const page = parseVersionPage(
            '<?xml version="1.0"?><ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>');
        expect(page.versions).toEqual([]);
        expect(page.markers).toEqual([]);
        expect(page.truncated).toBe(false);
    });
});

describe('unescaping what S3 sends', () => {
    it('turns the five entities back into characters', () => {
        expect(unescapeXml('a&lt;b&gt;c&quot;d&#39;e&amp;f')).toBe('a<b>c"d\'e&f');
    });

    it('does the ampersand last, so an escaped entity is not unescaped twice', () => {
        /* &amp;lt; is the text "&lt;", not the character "<". Doing & first
           would produce "<" and silently corrupt a key. */
        expect(unescapeXml('&amp;lt;')).toBe('&lt;');
    });
});

describe('what state a key is in', () => {
    const version = (isLatest) => ({ key: 'k', versionId: 'v', isLatest, lastModified: '', size: 1 });
    const marker = (isLatest) => ({ key: 'k', versionId: 'm', isLatest, lastModified: '', kind: 'DeleteMarker' });

    it('is hidden when a marker is on top and a version is underneath', () => {
        expect(verdictFor([version(false)], [marker(true)])).toBe('hidden');
    });

    it('is current when the newest thing is a real version', () => {
        expect(verdictFor([version(true)], [])).toBe('current');
    });

    it('is current when an old marker sits UNDER a newer version', () => {
        /* Deleted, then uploaded again. The marker is still in the version
           list and is not latest, and this key needs nothing done to it. */
        expect(verdictFor([version(true)], [marker(false)])).toBe('current');
    });

    it('is gone when a marker has nothing under it', () => {
        /* The thirty days ran out, or the upload never completed. Either
           way there is nothing to bring back and the script must not count
           it as work it can do. */
        expect(verdictFor([], [marker(true)])).toBe('gone');
    });

    it('is absent when the bucket has never heard of the key', () => {
        expect(verdictFor([], [])).toBe('absent');
    });

    it('calls the shape S3 should not produce gone, not current', () => {
        /* Versions exist but none is latest and no marker is latest. It
           cannot be opened, so it is not current -- erring towards "this
           needs looking at" rather than "nothing to see". */
        expect(verdictFor([version(false)], [])).toBe('gone');
    });
});
