/* The drop box: files a pharmacy has handed over, waiting for dispatch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE COMPONENT, TWO READERS, AND THEY SEE DIFFERENT THINGS.
 *
 * A pharmacy opens this to hand a list over and to check we got it. Dispatch
 * opens it to see what has come in, take the file away and mark it dealt
 * with. The difference is not drawn here by role: the SERVER scopes the rows
 * to the counters a membership names, and only the Done button is gated, by
 * `canHandle`, because marking our own work finished is dispatch's word and
 * not the pharmacy's.
 *
 * NOTHING HERE IMPORTS ANYTHING, and the screen says so in as many words.
 * A pharmacist who has used the import screen will reasonably expect
 * deliveries to appear, and finding out they have not — at four in the
 * afternoon, by telephone — is the failure this sentence exists to stop.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { Section } from '../../app/Section';
import { Loading } from '../../app/Loading';
import { Pager, usePaged } from '../../app/Pager';
import { clockFor } from '../../lib/when';

export interface DropSite { id: number; name: string; code: string }

interface Drop {
    id: number;
    siteId: number;
    pharmacy: string;
    pharmacyCode: string;
    serviceDate: string;
    filename: string;
    contentType: string;
    bytes: number;
    /** First twelve of the SHA-256, so two counters sending the identical
     *  sheet is visible without downloading both. */
    fingerprint: string;
    note: string;
    uploadedBy: string;
    uploadedAt: string;
    handledAt: string | null;
    handledBy: string;
    handled: boolean;
}

interface Listing {
    drops: Drop[];
    total: number;
    returned: number;
    pharmacies: DropSite[];
    status: 'outstanding' | 'handled' | 'all';
}

/** Bytes as a person reads them. Nothing here is ever near a gigabyte. */
function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TYPES = '.xlsx,.xls,.csv';

export function ListDrops({ projectCode, timezone, canHandle, canUpload }: {
    projectCode: string;
    timezone: string;
    /** Dispatch and an administrator mark one dealt with. A pharmacy does not. */
    canHandle: boolean;
    /** Whether to offer the hand-over form at all. */
    canUpload: boolean;
}) {
    const base = `/api/projects/${projectCode}/uh/list-drops`;
    const clock = clockFor(timezone);

    const [data, setData] = useState<Listing | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const [status, setStatus] = useState<'outstanding' | 'handled' | 'all'>('outstanding');
    const [siteId, setSiteId] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [search, setSearch] = useState('');

    /* The hand-over form. */
    const [upSite, setUpSite] = useState('');
    const [upDate, setUpDate] = useState('');
    const [note, setNote] = useState('');
    const file = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        const params = new URLSearchParams({ status });
        if (siteId) params.set('siteId', siteId);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (search.trim()) params.set('q', search.trim());
        try {
            const got = await api<Listing>(`${base}?${params.toString()}`);
            setData(got);
            /* The picker defaults to the only counter it offers, which is
               every pharmacy's case and saves them a decision they have no
               choice in. */
            if (got.pharmacies.length === 1 && !upSite) setUpSite(String(got.pharmacies[0]!.id));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not read the list.' });
        }
    }, [base, status, siteId, from, to, search, upSite]);

    useEffect(() => { void load(); }, [load]);

    const paged = usePaged(data?.drops ?? []);

    async function handOver(e: FormEvent) {
        e.preventDefault();
        const chosen = file.current?.files?.[0];
        if (!chosen || !upSite || !upDate) return;
        setBusy(true);
        setMsg(null);
        try {
            const options = encodeURIComponent(JSON.stringify({
                siteId: Number(upSite), serviceDate: upDate, note: note.trim(),
            }));
            /* The raw file as the body, like the import screen: a browser
               PUTs the spreadsheet, there is no form to post. */
            const res = await api<{ filename: string; pharmacy: string }>(`${base}?options=${options}`, {
                method: 'POST',
                headers: {
                    'Content-Type': chosen.type || 'application/octet-stream',
                    'X-Upload-Filename': chosen.name,
                },
                body: chosen,
            });
            setMsg({
                kind: 'ok',
                text: `${res.filename || 'The file'} is with dispatch. It creates no deliveries — `
                    + 'dispatch will take it from here.',
            });
            if (file.current) file.current.value = '';
            setNote('');
            await load();
        } catch (err) {
            setMsg({
                kind: 'error',
                text: err instanceof ApiError ? err.message : 'The file could not be handed over. Nothing was recorded.',
            });
        } finally {
            setBusy(false);
        }
    }

    async function mark(drop: Drop, handled: boolean) {
        setBusy(true);
        setMsg(null);
        try {
            await api(`${base}/${drop.id}/handled`, { method: 'POST', json: { handled } });
            await load();
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not update it.' });
        } finally {
            setBusy(false);
        }
    }

    const sites = data?.pharmacies ?? [];

    return (
        <Section
            id="uh.listDrops"
            title="Lists handed over"
            summary={data ? `${data.total} ${data.status === 'outstanding' ? 'waiting' : 'in view'}` : ''}
            intro={
                'Spreadsheets a pharmacy has sent across, kept exactly as they arrived. '
                + 'Nothing here is imported: no delivery exists until dispatch downloads the file '
                + 'and brings it in through Daily list import.'
            }
        >
            {msg && (
                <div className={`izy-alert ${msg.kind === 'error' ? 'error' : ''}`} role="status">{msg.text}</div>
            )}

            {canUpload && (
                <form className="izy-card" onSubmit={handOver}>
                    <h3>Hand a list over</h3>
                    <div className="izy-row">
                        <label className="izy-field">Pharmacy
                            <select value={upSite} onChange={(e) => setUpSite(e.target.value)} required>
                                <option value="">Choose</option>
                                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                        <label className="izy-field">For the day
                            <input type="date" value={upDate} onChange={(e) => setUpDate(e.target.value)} required />
                        </label>
                        <label className="izy-field">File
                            <input type="file" ref={file} accept={TYPES} required />
                        </label>
                    </div>
                    <label className="izy-field">Anything we should know
                        <input
                            type="text"
                            value={note}
                            maxLength={300}
                            placeholder="Two STATs at the top"
                            onChange={(e) => setNote(e.target.value)}
                        />
                    </label>
                    <button className="izy-btn" type="submit" disabled={busy}>
                        {busy ? 'Sending…' : 'Hand it over'}
                    </button>
                </form>
            )}

            <div className="izy-row">
                <label className="izy-field">Status
                    <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                        <option value="outstanding">Still to do</option>
                        <option value="handled">Dealt with</option>
                        <option value="all">Everything</option>
                    </select>
                </label>
                {sites.length > 1 && (
                    <label className="izy-field">Pharmacy
                        <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                            <option value="">Every pharmacy</option>
                            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </label>
                )}
                <label className="izy-field">From
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="izy-field">To
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
                <label className="izy-field">File name
                    <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="monday" />
                </label>
            </div>

            {!data ? <Loading label="Reading the drop box" /> : data.drops.length === 0 ? (
                <p className="izy-muted">
                    {status === 'outstanding'
                        ? 'Nothing waiting. Every list handed over has been dealt with.'
                        : 'Nothing matches those filters.'}
                </p>
            ) : (
                <>
                    <table className="izy-table">
                        <thead>
                            <tr>
                                <th>File</th><th>Pharmacy</th><th>For</th>
                                <th>Handed over</th><th>Status</th><th />
                            </tr>
                        </thead>
                        <tbody>
                            {paged.rows.map((d) => (
                                <tr key={d.id}>
                                    <td>
                                        {d.filename || <span className="izy-muted">unnamed</span>}
                                        <br />
                                        <span className="izy-muted">{size(d.bytes)} · {d.fingerprint}</span>
                                        {d.note && <><br /><span className="izy-muted">{d.note}</span></>}
                                    </td>
                                    <td>{d.pharmacy}</td>
                                    <td>{d.serviceDate}</td>
                                    <td className="izy-muted">
                                        {clock(d.uploadedAt)}
                                        {d.uploadedBy && <><br />{d.uploadedBy}</>}
                                    </td>
                                    <td>
                                        {d.handled ? (
                                            <>
                                                <span className="izy-pill">Dealt with</span>
                                                {d.handledBy && <><br /><span className="izy-muted">{d.handledBy}</span></>}
                                            </>
                                        ) : <span className="izy-pill warn">Waiting</span>}
                                    </td>
                                    <td>
                                        {/* A plain link, not a fetch and a blob: the browser
                                            knows how to save a file, and a blob URL keeps a
                                            copy of a pharmacy's patients alive in the tab. */}
                                        <a className="izy-btn secondary small" href={`${base}/${d.id}/file`}>
                                            Download
                                        </a>
                                        {canHandle && (
                                            <button
                                                className="izy-btn secondary small"
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void mark(d, !d.handled)}
                                            >
                                                {d.handled ? 'Reopen' : 'Done'}
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <Pager of={paged} noun="lists" />
                    {data.returned < data.total && (
                        <p className="izy-muted">
                            Showing {data.returned} of {data.total}. Narrow the dates to see the rest.
                        </p>
                    )}
                </>
            )}
        </Section>
    );
}
