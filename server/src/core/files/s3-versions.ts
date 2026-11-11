/* Reading a ListObjectVersions response.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT SIX LINES INSIDE THE SCRIPT THAT USES IT.
 *
 * scripts/restore-pods.mjs removes delete markers to bring deleted
 * proof-of-delivery photographs back. The call it makes to do that --
 * `DELETE /key?versionId=...` -- is the one S3 operation that destroys data
 * permanently and that nothing can undo. Aimed at a delete marker it is a
 * restore. Aimed at a real version it is the loss this was written to
 * repair, done again and for good.
 *
 * The only thing standing between those two outcomes is whether this parse
 * put an id in the right list. That is worth testing, and a script that
 * exits on import cannot be.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY REGULAR EXPRESSIONS AND NOT AN XML PARSER.
 *
 * The repository has no AWS SDK on purpose -- sigv4.ts opens with the
 * reason: on a system holding PHI, dependency surface is a security
 * property. Adding an XML parser to read two fixed element shapes would be
 * an odd place to break that.
 *
 * What makes this safe is not the parsing, which is ordinary. It is that
 * <Version> and <DeleteMarker> are read by two separate passes into two
 * separate arrays, so there is no path by which a real version's id can be
 * mistaken for a marker's. The caller asserts it again before it deletes.
 */

export interface S3Version {
    key: string;
    versionId: string;
    isLatest: boolean;
    lastModified: string;
    size: number;
}

export interface S3DeleteMarker {
    key: string;
    versionId: string;
    isLatest: boolean;
    lastModified: string;
    /** Carried so the caller can assert on it at the point of deletion.
     *  A literal, so a S3Version cannot be passed off as one of these. */
    kind: 'DeleteMarker';
}

export interface VersionPage {
    versions: S3Version[];
    markers: S3DeleteMarker[];
    /** Both markers are needed to page: a key with many versions can
     *  straddle a page boundary, and carrying only the key marker would
     *  re-read that key for ever. */
    truncated: boolean;
    nextKeyMarker: string;
    nextVersionIdMarker: string;
}

const first = (xml: string, tag: string): string => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m === null ? '' : (m[1] ?? '');
};

/* `<Version>` does not match `<VersionId>` and `</Version>` does not match
   `</VersionId>`: both need the angle bracket immediately after the name. */
const blocks = (xml: string, tag: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '');
    return out;
};

/** &amp; last, or an escaped entity would be unescaped twice. */
export const unescapeXml = (s: string): string => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export function parseVersionPage(xml: string): VersionPage {
    const versions: S3Version[] = blocks(xml, 'Version').map((b) => ({
        key: unescapeXml(first(b, 'Key')),
        versionId: first(b, 'VersionId'),
        isLatest: first(b, 'IsLatest') === 'true',
        lastModified: first(b, 'LastModified'),
        size: Number(first(b, 'Size') || 0),
    }));

    const markers: S3DeleteMarker[] = blocks(xml, 'DeleteMarker').map((b) => ({
        key: unescapeXml(first(b, 'Key')),
        versionId: first(b, 'VersionId'),
        isLatest: first(b, 'IsLatest') === 'true',
        lastModified: first(b, 'LastModified'),
        kind: 'DeleteMarker',
    }));

    return {
        versions,
        markers,
        truncated: first(xml, 'IsTruncated') === 'true',
        nextKeyMarker: unescapeXml(first(xml, 'NextKeyMarker')),
        nextVersionIdMarker: first(xml, 'NextVersionIdMarker'),
    };
}

export type Verdict =
    /** A delete marker on top and a real version under it. Restorable. */
    | 'hidden'
    /** The object is current. Opening it works; nothing to do. */
    | 'current'
    /** A marker, but nothing underneath. Expired or never uploaded. */
    | 'gone'
    /** The bucket has never heard of this key at all. */
    | 'absent';

/**
 * What state one key is in, given everything the bucket said about it.
 *
 * Deliberately total: every combination returns something named, including
 * the one S3 should not produce (no current marker and no current version),
 * which reads as 'gone' because that is what it looks like to a browser.
 */
export function verdictFor(versions: readonly S3Version[], markers: readonly S3DeleteMarker[]): Verdict {
    const hiddenBy = markers.some((m) => m.isLatest);
    if (hiddenBy) return versions.length > 0 ? 'hidden' : 'gone';
    if (versions.some((v) => v.isLatest)) return 'current';
    if (versions.length === 0 && markers.length === 0) return 'absent';
    return 'gone';
}
