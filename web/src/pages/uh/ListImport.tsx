/* Daily list import.
 *
 * Three steps in one card: choose the file and the site, review what the
 * server made of it, then commit. The review step is the point of the
 * screen. A courier manifest that imports silently and wrongly sends
 * medication to the wrong address, so nothing is imported until a person has
 * seen the rows and the count they are about to create.
 *
 * The file is uploaded twice, once to preview and once to commit. That is
 * deliberate: the server stages nothing, so an operator who previews a list
 * and closes the tab leaves no patient data behind.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PHARMACY PORTAL RENDERS THIS SAME COMPONENT.
 *
 * A pharmacy uploads its own list now, and the review step is the reason this
 * is not a second screen: a list that imports silently and wrongly sends
 * medication to the wrong address, and that is as true at a counter as it is
 * at a dispatch desk. A client-facing copy of this flow would drift, and this
 * codebase has fixed the same bug in one copy and not the other before.
 *
 * Two things differ, and both arrive as props rather than as a role check in
 * here. The pharmacy list is INJECTED, because GET /sites carries every UH
 * site's address and contact and is deliberately closed to the pharmacy role;
 * the portal passes the pharmacies its own account is scoped to. And the
 * wording is passed in, because "a pharmacy's delivery list" is the right
 * phrase at a dispatch desk and the wrong one when the reader is the
 * pharmacy.
 *
 * Nothing here is a permission. The server scopes every call to the sites on
 * the caller's membership and sets the received time itself; this component
 * could ask for another counter and be refused.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { clockFor, todayIn } from '../../lib/when';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';
import { displayName } from '../../lib/people';
import type { Site } from './Sites';

interface Issue { row: number; field: string; code: string; severity: 'error' | 'warning'; message: string }

interface PreviewRow {
    /* How the pharmacy is handing it over (drizzle/0051). Shown on the
       preview because this is the screen where somebody confirms the list,
       and confirming a Medicare controlled-substance delivery without being
       shown that is what it is makes the review a formality.
    
       Optional: a page served by a server older than this build still has a
       preview to render. */
    handlingFlags?: string[];
    authorisedSigners?: string;
    /** Sheet rows folded into this one as other boxes of the same delivery. */
    mergedRows?: number[];
    row: number;
    recipientName: string; recipientPhone: string; address: string;
    city: string; state: string; zip: string;
    serviceType: string; quantity: number; description: string; deliveryNotes: string;
    externalRef: string; signatureRequired: boolean;
    zone: number | null; dueAt: string | null;
    issues: Issue[];
    duplicateOfRow: number | null; duplicateOfOrderId: number | null;
    willImport: boolean;
}

interface Summary { total: number; willImport: number; blocked: number; duplicates: number; outOfArea: number; warnings: number }

interface Preview {
    site: { id: number; code: string; name: string };
    serviceDate: string;
    receivedAt: string;
    sheetName: string;
    headers: string[];
    mapping: Record<string, string>;
    mappingSource: 'request' | 'saved' | 'detected';
    missingRequired: string[];
    alreadyImportedListId: number | null;
    summary: Summary;
    rows: PreviewRow[];
}

interface ImportSummary {
    id: number;
    site: { id: number; code: string; name: string };
    serviceDate: string;
    status: string;
    receivedAt: string;
    sourceFilename: string;
    rowCount: number; orderCount: number; skippedCount: number;
    importedBy: string;
    /** Optional: a server older than this build does not send it. */
    importedByName?: string;
}

/* Every column the importer understands, in the pharmacy's own words.
 *
 * THIS LIST HAD DRIFTED. The parser has understood `idRequired` under nine
 * spellings since ticket 0038 and this screen never offered it, so an
 * operator whose sheet headed the column something the guesser did not
 * recognise had no way to say which column it was -- the row simply was not
 * on the page. The handling columns from drizzle/0051 would have joined it.
 *
 * The labels are what a pharmacist calls the thing, not what the database
 * calls it: "Medicare / who signs" rather than "signatureRule", because the
 * person reading this is matching it against their own spreadsheet. */
const FIELD_LABELS: Record<string, string> = {
    externalRef: 'Reference', recipientName: 'Recipient name', recipientPhone: 'Phone',
    addressLine: 'Address', addressLine2: 'Address line 2', city: 'City', state: 'State',
    zip: 'ZIP', serviceType: 'Service type', quantity: 'Packages', description: 'Description',
    deliveryNotes: 'Notes', signatureRequired: 'Signature required',
    idRequired: 'ID required',
    signatureRule: 'Medicare / who may sign',
    authorisedSigners: 'Caregiver who may sign',
    refrigerated: 'Refrigerated',
    controlled: 'Controlled substance',
};
const ALL_FIELDS = Object.keys(FIELD_LABELS);
const REQUIRED = ['recipientName', 'addressLine', 'zip'];

/** What this screen needs to know about a pharmacy, and no more. */
export interface ImportSite { id: number; code: string; name: string; status?: string }

/** A mapping's identity, independent of the order keys were set in.
 *
 *  JSON.stringify follows insertion order, so unmapping a column and then
 *  choosing the same one again would produce a different string for an
 *  identical mapping -- and the screen would insist on a re-read that would
 *  change nothing. Sorted, the fingerprint is about content only. */
const mappingKey = (m: Record<string, string>): string =>
    JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));

/**
 * What to say once a list has been committed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT USED TO SAY ONLY WHAT WENT IN, IN GREEN.
 *
 * "Imported 1 orders as list 57." That was the whole message on 2 November
 * for a ninety-two row Southeast file: ninety-one rows were skipped as
 * duplicates and the sentence did not contain the number 91, or the word
 * skipped, or any hint that the file had more in it than the list did.
 *
 * The feedback that came back called it a capacity limit -- "approximately
 * 102 entries per upload" -- because from the counter that is exactly what
 * it looks like. There is no such limit: a 260-row list previews, imports
 * and reads back whole (server/test/import-capacity.test.mjs). What there
 * was, was a success message that could not count.
 *
 * So the number that matters is now N OF M, the reasons are named, and it
 * stops being green the moment they differ. A pharmacist who sends ninety-two
 * and is told ninety-two arrived has been told something; one who is told
 * "1 of 92" goes and looks, which is the entire point.
 */
export function importOutcome(done: { id: number; summary: Summary & { imported: number } }): {
    kind: 'ok' | 'warn'; text: string; details?: string[];
} {
    const { imported, total, blocked, duplicates } = done.summary;
    const missing = Math.max(0, total - imported);
    if (missing === 0) {
        return { kind: 'ok', text: `Imported all ${total} ${total === 1 ? 'row' : 'rows'} as list ${done.id}.` };
    }

    /* Named rather than totalled. "91 rows did not import" invites a guess;
       "91 were already on this day's list" is a thing somebody can act on,
       and the two reasons need opposite actions -- a duplicate is accepted
       on the preview, a blocked row is fixed in the file. */
    const why: string[] = [];
    if (duplicates > 0) {
        why.push(`${duplicates} ${duplicates === 1 ? 'was' : 'were'} already on this pharmacy's list for that day. `
            + 'Re-read the file and tick them if they are genuinely new.');
    }
    if (blocked > 0) {
        why.push(`${blocked} ${blocked === 1 ? 'has' : 'have'} a problem that stops it being delivered -- `
            + 'usually a missing name, street or ZIP. Fix those rows and send the file again.');
    }
    const named = duplicates + blocked;
    if (missing > named) {
        why.push(`${missing - named} did not import and the reasons above do not cover ${missing - named === 1 ? 'it' : 'them'}. `
            + 'Download the sheet and compare it against what you sent.');
    }

    return {
        kind: 'warn',
        text: `Imported ${imported} of ${total} rows as list ${done.id}. `
            + `${missing} ${missing === 1 ? 'row is' : 'rows are'} not on it.`,
        details: why,
    };
}

/** A driver, as the roster endpoint describes one. The three fields the
 *  dropdown needs and nothing else. */
interface RosterDriver {
    username: string;
    name: string;
    homeSiteId: number | null;
    alsoCovers?: number[];
    onShift: boolean;
}

export function ListImport({ projectCode, timezone, canImport, canWithdraw, sites: given, title, intro, refusal }: {
    projectCode: string; timezone: string; canImport: boolean;
    /* DISPATCH ONLY, and separate from canImport for that reason. A pharmacy
       may send a list and read its own back; taking one off removes work from
       a board dispatch is now assigning by hand. The server enforces it --
       this only decides whether to offer a button that would be refused. */
    canWithdraw?: boolean | undefined;
    /** Supplied by the pharmacy portal, which may not read GET /sites. When
     *  absent this loads the full list, which is the dispatch case. */
    sites?: ImportSite[] | undefined;
    title?: string | undefined;
    intro?: string | undefined;
    /** What to say to somebody who may not import. */
    refusal?: string | undefined;
}) {
    const base = `/api/projects/${projectCode}/uh/imports`;
    /* The service date is a contract day and the received time starts the
       two-hour clock, so both belong to the project's zone rather than to
       whatever this machine is set to. */
    const time = clockFor(timezone);
    const fileRef = useRef<HTMLInputElement>(null);

    const [loaded, setLoaded] = useState<ImportSite[] | null>(null);
    /* Given wins. The portal has already asked the server which pharmacies
       this account covers and must not ask again through an endpoint that
       would answer with all nine. */
    const sites: ImportSite[] | null = given ?? loaded;
    const [recent, setRecent] = useState<ImportSummary[] | null>(null);
    /* WHAT THE LIST IS NARROWED TO, and it is sent to the server rather than
       applied to the rows already here. Unfiltered, the endpoint answers with
       the hundred most recent; a pharmacy asking "where is the list we sent
       on the 14th" is asking about one that may be past that edge, and
       filtering in the browser could never find it. */
    const [findSite, setFindSite] = useState<number | ''>('');
    const [findDate, setFindDate] = useState('');
    const [siteId, setSiteId] = useState<number | ''>('');
    const [serviceDate, setServiceDate] = useState(() => todayIn(timezone));
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [mapping, setMapping] = useState<Record<string, string>>({});
    const [skipRows, setSkipRows] = useState<number[]>([]);
    const [acceptDup, setAcceptDup] = useState<number[]>([]);
    /* ───────────────────────────── THE PREVIEW AND THE IMPORT CAN DISAGREE.
     *
     * Changing a column in the mapping updates `mapping`, which is what the
     * commit sends -- but it does NOT re-run the preview, so the table and
     * the warning counts on screen still describe the mapping the server
     * last parsed with. Importing from there confirms one thing and creates
     * another.
     *
     * Found on 28 October by click-through: mapping the pharmacy's "Notes"
     * column to Description left the screen reading "8 with warnings — no
     * package description" while the import would have produced eight orders
     * that each had one. Harmless that way round; the same gap with ZIP or
     * Recipient name pointed at the wrong column is a list of deliveries to
     * the wrong addresses, confirmed against a preview of the right ones.
     *
     * So the mapping the preview was built from is remembered, and Import is
     * refused while the two differ. "Re-read with these columns" was always
     * there and is now the only way forward, rather than the diligent path.
     */
    const [previewedWith, setPreviewedWith] = useState<string>('');
    const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
    /* 'warn' since 3 November: a list that imported some of its rows is
       neither a success nor an error, and colouring it as either was how
       ninety-one skipped prescriptions read as 'Imported 1 orders'. */
    const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string; details?: string[] } | null>(null);

    const loadSites = useCallback(async () => {
        if (given !== undefined) return;
        try { setLoaded(await api<Site[]>(`/api/projects/${projectCode}/uh/sites`)); } catch { setLoaded([]); }
    }, [projectCode, given]);
    const [withdrawing, setWithdrawing] = useState<number | null>(null);
    /* ─────────────────── WHO TO GIVE THE LIST TO, OPTIONALLY
     *
     * A counter uploads its own round and hands it to the driver standing
     * in front of them. Doing that as two jobs -- import here, then find
     * the list on the board and assign it -- is two screens for one act,
     * and the second one gets forgotten.
     *
     * OPTIONAL, AND NOT A GATE. Empty means import and nothing else, which
     * is exactly what this screen did before. Nothing about the upload
     * path depends on it.
     *
     * IT REUSES WHAT THE BOARD USES. The list comes from the roster
     * endpoint -- the same homeSiteId, alsoCovers and onShift the
     * assignment dropdown reads -- and the assignment itself is POST
     * /runs, the call a dispatcher makes by hand. No second way to create
     * a run, and nothing new to keep in step. */
    const [roster, setRoster] = useState<RosterDriver[] | null>(null);
    const [assignTo, setAssignTo] = useState('');

    const loadRecent = useCallback(async () => {
        const q = new URLSearchParams();
        if (findSite !== '') q.set('siteId', String(findSite));
        if (findDate !== '') q.set('serviceDate', findDate);
        const url = q.toString() === '' ? base : `${base}?${q.toString()}`;
        /* Null first, so the table says it is loading rather than showing the
           previous pharmacy's lists under the new pharmacy's name. */
        setRecent(null);
        try { setRecent(await api<ImportSummary[]>(url)); } catch { setRecent([]); }
    }, [base, findSite, findDate]);
    /* Two effects, not one. The sites are fetched once; the list is fetched
       again every time the filter moves, and loadSites would otherwise be
       re-run on each keystroke of a date. */
    useEffect(() => { void loadSites(); }, [loadSites]);
    useEffect(() => { void loadRecent(); }, [loadRecent]);

    /* THE ROSTER, ONCE. Who is on shift changes during a day, but this
       screen is open for a minute at a time and a stale dropdown is
       caught by the server: POST /runs checks membership itself, and a
       driver who went off shift between the fetch and the import is a
       refusal with a sentence rather than a silent wrong assignment.
       Failure is silent on purpose -- the dropdown simply does not
       appear, and importing without assigning is the normal case. */
    useEffect(() => {
        if (canImport !== true) return;
        let alive = true;
        void (async () => {
            try {
                const got = await api<{ drivers: RosterDriver[] }>(`/api/projects/${projectCode}/uh/roster`);
                if (alive) setRoster(got.drivers ?? []);
            } catch { if (alive) setRoster([]); }
        })();
        return () => { alive = false; };
    }, [projectCode, canImport]);

    /* ON SHIFT AND MAPPED TO THE PHARMACY THIS LIST IS FOR.
     *
     * The same two rules the board's assignment dropdown applies, and the
     * same reason for the second one: a counter's own drivers, plus the
     * ones who cover it. Wheatley is nobody's home pharmacy -- it is run
     * from Vida as one round -- so without the cover list its lists would
     * have an empty dropdown. */
    const candidates = (roster ?? []).filter((d) => {
        if (!d.onShift) return false;
        if (siteId === '') return false;
        const site = Number(siteId);
        return d.homeSiteId === site || (d.alsoCovers ?? []).includes(site);
    });

    const reset = () => { setPreview(null); setSkipRows([]); setAcceptDup([]); setMapping({}); setMsg(null); setAssignTo(''); };

    /** The list currently being taken off, so only its own button goes quiet. */

    /* TAKING A LIST BACK OFF.
     *
     * The commonest thing that goes wrong with an upload is the wrong file,
     * and the only answer used to be cancelling seventy deliveries one at a
     * time.
     *
     * IT DELETES, AND THE CONFIRMATION SAYS SO. From 4 November the server
     * removes the rows rather than cancelling them, including deliveries
     * that were collected, delivered and signed for. The old wording
     * promised the opposite -- "the deliveries stay on the record as
     * cancelled" -- and a button whose dialog describes the behaviour it
     * used to have is worse than one with no dialog at all. */
    async function withdraw(l: ImportSummary) {
        const ok = confirm(
            `Delete the ${l.serviceDate} ${l.site.name} list?\n\n`
            + `Its ${l.orderCount} ${l.orderCount === 1 ? 'delivery is' : 'deliveries are'} deleted outright, `
            + 'including any a driver has already collected, delivered or photographed. '
            + 'Their proof of delivery, photographs and chain of custody go with them.\n\n'
            + 'This cannot be undone and there is nothing to restore from. Only the audit trail '
            + 'will show the list ever existed.',
        );
        if (!ok) return;
        setWithdrawing(l.id);
        setMsg(null);
        try {
            const res = await api<{ deleted: number; filesDeleted: number; filesLeftInStorage: number }>(
                `${base}/${l.id}`, { method: 'DELETE' },
            );
            setMsg({
                kind: 'ok',
                text: `Deleted the ${l.serviceDate} ${l.site.name} list: ${res.deleted} `
                    + `${res.deleted === 1 ? 'delivery' : 'deliveries'} removed`
                    + (res.filesDeleted > 0 ? `, ${res.filesDeleted} photographs` : '')
                    /* Said out loud rather than buried: an object left in the
                       bucket is the one part of this that somebody may have
                       to go and finish by hand. */
                    + (res.filesLeftInStorage > 0
                        ? `. ${res.filesLeftInStorage} photographs could not be removed from storage`
                        : '') + '.',
            });
            await loadRecent();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not delete that list.' });
        } finally {
            setWithdrawing(null);
        }
    }

    async function send(dryRun: boolean) {
        if (!file || siteId === '') return;
        setBusy(dryRun ? 'preview' : 'commit');
        setMsg(null);
        const options = {
            siteId: Number(siteId),
            serviceDate,
            ...(Object.keys(mapping).length > 0 ? { mapping } : {}),
            skipRows,
            acceptDuplicateRows: acceptDup,
        };
        const url = `${dryRun ? `${base}/preview` : base}?options=${encodeURIComponent(JSON.stringify(options))}`;
        try {
            const body = await file.arrayBuffer();
            const res = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Upload-Filename': file.name,
                    Accept: 'application/json',
                },
                body,
            });
            const text = await res.text();
            const json: unknown = text ? JSON.parse(text) : null;
            if (!res.ok) {
                const e = (json ?? {}) as { error?: string; details?: string[] };
                throw new ApiError(res.status, e.error || `Request failed (${res.status})`, e.details ?? []);
            }
            if (dryRun) {
                const p = json as Preview;
                setPreview(p);
                setMapping(p.mapping);
                /* The mapping this preview was actually built from. See the
                   note on `mappingMoved` below. */
                setPreviewedWith(mappingKey(p.mapping));
            } else {
                const done = json as {
                    id: number;
                    summary: Summary & { imported: number };
                    orderIds?: number[];
                    site?: { id: number; code: string; name: string };
                    serviceDate?: string;
                };
                const outcome = importOutcome(done);

                /* ─── AND THEN HAND IT OVER, IF A DRIVER WAS CHOSEN.
                 *
                 * A SEPARATE CALL, AFTER THE IMPORT HAS LANDED, and that
                 * ordering is the whole safety of this. The import is
                 * already committed and reported before anything is
                 * assigned, so the worst this can do is leave a list
                 * imported and unassigned -- which is exactly what this
                 * screen produced before the dropdown existed, and what
                 * the board is for.
                 *
                 * POST /runs is the call a dispatcher makes by hand. It
                 * checks membership, it refuses an order already on
                 * another run, and it writes the custody events. Nothing
                 * here re-implements any of that. */
                const taker = assignTo;
                const ids = done.orderIds ?? [];
                if (taker !== '' && ids.length > 0) {
                    try {
                        const run = await api<{ rejected?: unknown[] }>(
                            `/api/projects/${projectCode}/uh/runs`,
                            {
                                method: 'POST',
                                json: {
                                    courierUsername: taker,
                                    label: `${done.site?.name ?? 'List'} ${done.serviceDate ?? ''}`.trim(),
                                    serviceDate: done.serviceDate,
                                    orderIds: ids,
                                },
                            },
                        );
                        const refused = (run.rejected ?? []).length;
                        const who = candidates.find((d) => d.username === taker);
                        outcome.text += refused === 0
                            ? ` Given to ${who?.name ?? taker}.`
                            : ` Given to ${who?.name ?? taker}, except ${refused} `
                                + `${refused === 1 ? 'delivery' : 'deliveries'} it would not take.`;
                    } catch (err) {
                        /* The import stands. Said as a separate sentence so
                           nobody reads "could not assign" as "did not
                           import" and uploads the file again. */
                        outcome.kind = 'warn';
                        outcome.text += ' The list is imported. It could not be given to that driver: '
                            + (err instanceof ApiError ? err.message : 'dispatch could not be reached.')
                            + ' Assign it from the board.';
                    }
                }

                setMsg(outcome);
                setAssignTo('');
                setPreview(null);
                setFile(null);
                setSkipRows([]);
                setAcceptDup([]);
                if (fileRef.current) fileRef.current.value = '';
                void loadRecent();
            }
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'The file could not be sent.' });
        } finally {
            setBusy(null);
        }
    }

    const toggle = (list: number[], set: (v: number[]) => void, row: number) =>
        set(list.includes(row) ? list.filter((r) => r !== row) : [...list, row]);

    const pagedRecent = usePaged(recent ?? []);
    /* The preview is the one list where reading every row is the job: it is
       the last look before patient addresses become orders. Paged like the
       rest on the owner's instruction, and the count above the table still
       says how many of how many will be imported. */
    const pagedPreview = usePaged(preview?.rows ?? []);
    /* True once somebody has moved a column since the preview was parsed. */
    const mappingMoved = preview !== null && mappingKey(mapping) !== previewedWith;

    if (sites === null) return <div className="izy-card"><Loading label="Loading sites" /></div>;

    return (
        <Section
            id="uh.import"
            title={title ?? 'Daily list import'}
            summary={recent && recent.length > 0 ? `last imported ${recent[0]?.serviceDate ?? ''}` : undefined}
            intro={intro ?? ("Upload a pharmacy's delivery list as .xlsx or .csv. Nothing is created until you review the "
                + 'rows below and confirm. The file itself is never stored; it is read in memory and discarded.')}
        >

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {!canImport ? (
                <div className="izy-muted">{refusal ?? 'You need the admin role in this project to import a list.'}</div>
            ) : (
                <>
                    <div className="izy-row">
                        <label className="izy-field">Pharmacy
                            <select value={siteId} onChange={(e) => { setSiteId(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}>
                                <option value="">Choose a site</option>
                                {/* An injected list carries no status: the portal
                                    sends the pharmacies this account covers and
                                    they are all live by definition. */}
                                {sites.filter((s) => s.status === undefined || s.status === 'active').map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="izy-field">Service date
                            <input type="date" value={serviceDate} onChange={(e) => { setServiceDate(e.target.value); reset(); }} />
                        </label>
                        <label className="izy-field" style={{ minWidth: 240 }}>List file
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
                            />
                        </label>
                        <button className="izy-btn" type="button" disabled={!file || siteId === '' || busy !== null} onClick={() => { void send(true); }}>
                            {busy === 'preview' ? 'Reading' : 'Review the file'}
                        </button>
                    </div>

                    {preview && (
                        <>
                            <h3 style={{ marginTop: 20 }}>Columns</h3>
                            <p className="izy-muted">
                                {preview.mappingSource === 'saved' && 'Using the mapping saved for this pharmacy. '}
                                {preview.mappingSource === 'detected' && 'Guessed from the header row. Check it before importing. '}
                                {preview.mappingSource === 'request' && 'Using the mapping you set. '}
                                Sheet {preview.sheetName || 'CSV'}, {preview.headers.length} columns.
                            </p>
                            <div className="izy-row">
                                {ALL_FIELDS.map((f) => (
                                    <label className="izy-field" key={f}>
                                        {FIELD_LABELS[f]}{REQUIRED.includes(f) ? ' *' : ''}
                                        <select
                                            value={mapping[f] ?? ''}
                                            onChange={(e) => {
                                                const next = { ...mapping };
                                                if (e.target.value === '') delete next[f]; else next[f] = e.target.value;
                                                setMapping(next);
                                            }}
                                        >
                                            <option value="">not mapped</option>
                                            {preview.headers.filter((h) => h !== '').map((h) => <option key={h} value={h}>{h}</option>)}
                                        </select>
                                    </label>
                                ))}
                                <button className="izy-btn secondary" type="button" disabled={busy !== null} onClick={() => { void send(true); }}>
                                    Re-read with these columns
                                </button>
                            </div>

                            {mappingMoved && (
                                /* Not "are you sure": the preview below is
                                   simply not about these columns any more,
                                   and no amount of care reading it would
                                   tell you what the import will do. */
                                <div className="izy-alert warn" role="status">
                                    The columns have changed since this preview was read.
                                    Choose <b>Re-read with these columns</b> to see what will actually be imported.
                                </div>
                            )}

                            {preview.missingRequired.length > 0 && (
                                <div className="izy-alert error" role="alert">
                                    No column is mapped for: {preview.missingRequired.map((f) => FIELD_LABELS[f] ?? f).join(', ')}.
                                    Pick the right columns above and re-read the file.
                                </div>
                            )}

                            {preview.alreadyImportedListId !== null && (
                                <div className="izy-alert warn" role="status">
                                    This exact file was already imported as list {preview.alreadyImportedListId}.
                                </div>
                            )}

                            <h3 style={{ marginTop: 20 }}>
                                {preview.summary.willImport} of {preview.summary.total} rows will be imported
                            </h3>
                            <p className="izy-muted">
                                {preview.summary.blocked} blocked, {preview.summary.duplicates} duplicate,
                                {' '}{preview.summary.outOfArea} out of area, {preview.summary.warnings} with warnings.
                                Received {time(preview.receivedAt)}, so scheduled deliveries are due two hours later.
                            </p>

                            <table className="izy-table">
                                <thead>
                                    <tr>
                                        <th>Row</th><th>Import</th><th>Recipient</th><th>Address</th>
                                        <th>Zone</th><th>Service</th><th>Qty</th><th>Due</th><th>Problems</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pagedPreview.rows.map((r) => {
                                        const blocked = r.issues.some((i) => i.severity === 'error');
                                        const isDup = r.duplicateOfRow !== null || r.duplicateOfOrderId !== null;
                                        return (
                                            <tr key={r.row} className={blocked ? 'izy-row-blocked' : undefined}>
                                                <td>{r.row}</td>
                                                <td>
                                                    {blocked ? <span className="izy-pill off">blocked</span> : (
                                                        <input
                                                            type="checkbox"
                                                            aria-label={`Import row ${r.row}`}
                                                            checked={r.willImport && !skipRows.includes(r.row)}
                                                            onChange={() => {
                                                                if (isDup && !acceptDup.includes(r.row)) toggle(acceptDup, setAcceptDup, r.row);
                                                                else toggle(skipRows, setSkipRows, r.row);
                                                            }}
                                                        />
                                                    )}
                                                </td>
                                                <td>
                                                    {r.recipientName}
                                                    {r.externalRef && <><br /><span className="izy-muted">{r.externalRef}</span></>}
                                                    {(r.handlingFlags ?? []).length > 0 && (
                                                        <><br />{(r.handlingFlags ?? []).map((f) => (
                                                            <span key={f} className={`izy-pill ${f === 'Fridge' ? 'warn' : ''}`}>{f}</span>
                                                        ))}</>
                                                    )}
                                                    {(r.authorisedSigners ?? '') !== '' && (
                                                        <><br /><span className="izy-muted">Also: {r.authorisedSigners}</span></>
                                                    )}
                                                </td>
                                                <td>{r.address}<br /><span className="izy-muted">{r.city} {r.state} {r.zip}</span></td>
                                                <td>{r.zone !== null ? r.zone
                                                    : r.issues.some((i) => i.code === 'zone.outOfArea')
                                                        ? <span className="izy-pill warn">out of area</span>
                                                        // A row with no usable ZIP is not out of area, it is unknown.
                                                        : <span className="izy-muted">unknown</span>}</td>
                                                <td>{r.serviceType}</td>
                                                <td>
                                                    {r.quantity}
                                                    {/* Say that rows were folded together, on the row
                                                        that absorbed them. Three boxes of one
                                                        prescription are one visit and one signature,
                                                        and a reviewer counting rows against their own
                                                        sheet needs to know why the count dropped. */}
                                                    {(r.mergedRows ?? []).length > 0 && (
                                                        <><br /><span className="izy-muted">
                                                            rows {[r.row, ...(r.mergedRows ?? [])].join(', ')}
                                                        </span></>
                                                    )}
                                                </td>
                                                <td>{time(r.dueAt)}</td>
                                                <td>
                                                    {r.issues.length === 0 ? <span className="izy-muted">none</span> : (
                                                        <ul className="izy-plain-list">
                                                            {r.issues.map((i) => (
                                                                <li key={`${i.field}.${i.code}`} className={i.severity === 'error' ? 'izy-issue-error' : undefined}>
                                                                    {i.message}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                                <Pager of={pagedPreview} noun="rows" />

                            <div className="izy-row" style={{ marginTop: 14 }}>
                                {/* ─── WHO TAKES IT, BEFORE THE BUTTON THAT
                                    SENDS IT, because that is the order the
                                    sentence runs in: give this list to
                                    somebody, then import it.

                                    OPTIONAL, AND LABELLED AS OPTIONAL.
                                    "Nobody yet" is the first option and the
                                    default, so the upload a counter has
                                    always done is still one button. Nothing
                                    about importing depends on this. */}
                                {canImport === true && candidates.length > 0 && (
                                    <label className="izy-field izy-assign-on-import">
                                        Give it to
                                        <select
                                            value={assignTo}
                                            disabled={busy !== null}
                                            onChange={(e) => setAssignTo(e.target.value)}
                                        >
                                            <option value="">Nobody yet</option>
                                            {candidates.map((d) => (
                                                <option key={d.username} value={d.username}>{d.name}</option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                                <button
                                    className="izy-btn"
                                    type="button"
                                    disabled={busy !== null || preview.summary.willImport === 0 || preview.missingRequired.length > 0 || mappingMoved}
                                    onClick={() => { void send(false); }}
                                >
                                    {busy === 'commit' ? 'Importing' : `Import ${preview.rows.filter((r) => r.willImport && !skipRows.includes(r.row)).length} orders`}
                                </button>
                                <button className="izy-btn secondary" type="button" disabled={busy !== null} onClick={reset}>Cancel</button>
                            </div>
                            {/* WHY THERE IS NO DROPDOWN, when there is none.
                                An absent control with no explanation reads as
                                a feature that is broken; this says which of
                                the two rules nobody passed, and the import is
                                unaffected either way. */}
                            {canImport === true && roster !== null && candidates.length === 0 && (
                                <p className="izy-muted">
                                    Nobody mapped to this pharmacy is on shift, so there is no one to give it to
                                    here. Import it and assign it from the board.
                                </p>
                            )}
                        </>
                    )}
                </>
            )}

            {/* THE FILTER SITS ON THE HEADING'S OWN ROW, which is where it was
                asked for and also where it belongs: it describes the table
                under it, and a control a scroll away from what it changes
                gets used by nobody. */}
            <div className="izy-row-between izy-imports-head">
                <h3 style={{ margin: 0 }}>Recent imports</h3>
                <div className="izy-row izy-imports-find">
                    {/* "Find pharmacy", not "Pharmacy". The upload form above
                        has its own Pharmacy select, and two controls with one
                        label in a document is ambiguous to a screen reader
                        reading it aloud as much as to a test querying it. */}
                    <label className="izy-field">
                        <span className="izy-muted">Find pharmacy</span>
                        <select
                            value={findSite}
                            onChange={(e) => { setFindSite(e.target.value === '' ? '' : Number(e.target.value)); }}
                        >
                            <option value="">Every pharmacy</option>
                            {/* NOT narrowed to active ones, unlike the upload
                                select above. A counter that has closed still
                                has the lists it sent, and the day somebody
                                goes looking for one is the day after it
                                closed. */}
                            {(sites ?? []).map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className="izy-field">
                        <span className="izy-muted">Find date</span>
                        <input
                            type="date"
                            value={findDate}
                            onChange={(e) => { setFindDate(e.target.value); }}
                        />
                    </label>
                    {/* Only once there is something to clear: a dead button
                        beside an unfiltered table is furniture. */}
                    {(findSite !== '' || findDate !== '') && (
                        <button
                            className="izy-btn secondary small"
                            type="button"
                            onClick={() => { setFindSite(''); setFindDate(''); }}
                        >
                            Show all
                        </button>
                    )}
                </div>
            </div>
            {recent === null ? <Loading label="Loading imports" /> : recent.length === 0 ? (
                /* THE TWO EMPTIES ARE NOT THE SAME SENTENCE. "Nothing imported
                   yet" under a filter reads as "this pharmacy has never sent
                   one", which is a different and alarming claim from "not on
                   that day". */
                <div className="izy-muted">
                    {findSite !== '' || findDate !== ''
                        ? 'No lists match that. Widen it, or Show all.'
                        : 'Nothing imported yet.'}
                </div>
            ) : (
                <>
                <table className="izy-table">
                    <thead><tr>
                        <th>Date</th><th>Pharmacy</th><th>Orders</th><th>Skipped</th><th>File</th><th>By</th><th>Sheet</th>
                        {canWithdraw === true && <th>Remove</th>}
                    </tr></thead>
                    <tbody>
                        {pagedRecent.rows.map((l) => (
                            /* A withdrawn list stays in the table rather than
                               vanishing from it. Somebody reconciling a day
                               needs to see that a list was sent and taken
                               back off; a row that disappears turns that into
                               a mystery, which is the opposite of what this
                               screen is for. Its sheet still downloads. */
                            <tr key={l.id} className={l.status === 'cancelled' ? 'izy-row-off' : undefined}>
                                <td>{l.serviceDate}</td>
                                <td>
                                    {l.site.name}
                                    {l.status === 'cancelled' && <><br /><span className="izy-muted">taken off</span></>}
                                </td>
                                <td>{l.orderCount}</td>
                                <td>{l.skippedCount}</td>
                                <td className="izy-muted">{l.sourceFilename || 'unnamed'}</td>
                                {/* The person, not their username, which for a
                                    pharmacy counter is an address. See
                                    lib/people.ts. */}
                                <td className="izy-muted">
                                    {displayName({ name: l.importedByName ?? '', username: l.importedBy })}
                                </td>
                                {/* THE DELIVERIES THIS UPLOAD MADE, as a sheet.
                                    NOT the uploaded file: nothing keeps that,
                                    because preview and commit take the same
                                    bytes and nothing is staged between them, so
                                    an operator who walks away leaves no patient
                                    addresses behind. The column is headed Sheet
                                    rather than File for that reason -- the
                                    column to its left is already the name of
                                    something we do not have.

                                    A plain link, not a fetch: the browser
                                    handles the download, carries the session
                                    cookie, and needs no JavaScript to hold a
                                    spreadsheet of patient addresses in memory
                                    on the way past. */}
                                <td>
                                    <a
                                        className="izy-btn secondary small"
                                        href={`${base}/${l.id}/export.xlsx`}
                                        aria-label={`Download the deliveries from the ${l.serviceDate} ${l.site.name} list`}
                                    >
                                        Download
                                    </a>
                                </td>
                                {canWithdraw === true && (
                                    <td>
                                        {l.status === 'cancelled' ? (
                                            <span className="izy-muted">—</span>
                                        ) : (
                                            <button
                                                className="izy-btn danger small"
                                                type="button"
                                                disabled={withdrawing !== null}
                                                aria-label={`Take the ${l.serviceDate} ${l.site.name} list off`}
                                                onClick={() => { void withdraw(l); }}
                                            >
                                                {withdrawing === l.id ? 'Removing…' : 'Delete'}
                                            </button>
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
                    <Pager of={pagedRecent} noun="imports" />
                </>
            )}
        </Section>
    );
}
