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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { clockFor, todayIn } from '../../lib/when';
import { Loading } from '../../app/Loading';
import type { Site } from './Sites';

interface Issue { row: number; field: string; code: string; severity: 'error' | 'warning'; message: string }

interface PreviewRow {
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
}

const FIELD_LABELS: Record<string, string> = {
    externalRef: 'Reference', recipientName: 'Recipient name', recipientPhone: 'Phone',
    addressLine: 'Address', addressLine2: 'Address line 2', city: 'City', state: 'State',
    zip: 'ZIP', serviceType: 'Service type', quantity: 'Quantity', description: 'Description',
    deliveryNotes: 'Notes', signatureRequired: 'Signature required',
};
const ALL_FIELDS = Object.keys(FIELD_LABELS);
const REQUIRED = ['recipientName', 'addressLine', 'zip'];

export function ListImport({ projectCode, timezone, canImport }: {
    projectCode: string; timezone: string; canImport: boolean;
}) {
    const base = `/api/projects/${projectCode}/uh/imports`;
    /* The service date is a contract day and the received time starts the
       two-hour clock, so both belong to the project's zone rather than to
       whatever this machine is set to. */
    const time = clockFor(timezone);
    const fileRef = useRef<HTMLInputElement>(null);

    const [sites, setSites] = useState<Site[] | null>(null);
    const [recent, setRecent] = useState<ImportSummary[] | null>(null);
    const [siteId, setSiteId] = useState<number | ''>('');
    const [serviceDate, setServiceDate] = useState(() => todayIn(timezone));
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [mapping, setMapping] = useState<Record<string, string>>({});
    const [skipRows, setSkipRows] = useState<number[]>([]);
    const [acceptDup, setAcceptDup] = useState<number[]>([]);
    const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] } | null>(null);

    const loadSites = useCallback(async () => {
        try { setSites(await api<Site[]>(`/api/projects/${projectCode}/uh/sites`)); } catch { setSites([]); }
    }, [projectCode]);
    const loadRecent = useCallback(async () => {
        try { setRecent(await api<ImportSummary[]>(base)); } catch { setRecent([]); }
    }, [base]);
    useEffect(() => { void loadSites(); void loadRecent(); }, [loadSites, loadRecent]);

    const reset = () => { setPreview(null); setSkipRows([]); setAcceptDup([]); setMapping({}); setMsg(null); };

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
            } else {
                const done = json as { id: number; summary: Summary & { imported: number } };
                setMsg({ kind: 'ok', text: `Imported ${done.summary.imported} orders as list ${done.id}.` });
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

    if (sites === null) return <div className="izy-card"><Loading label="Loading sites" /></div>;

    return (
        <div className="izy-card">
            <h2>Daily list import</h2>
            <p className="izy-muted">
                Upload a pharmacy's delivery list as .xlsx or .csv. Nothing is created until you review the
                rows below and confirm. The file itself is never stored; it is read in memory and discarded.
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            {!canImport ? (
                <div className="izy-muted">You need the admin role in this project to import a list.</div>
            ) : (
                <>
                    <div className="izy-row">
                        <label className="izy-field">Pharmacy
                            <select value={siteId} onChange={(e) => { setSiteId(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}>
                                <option value="">Choose a site</option>
                                {sites.filter((s) => s.status === 'active').map((s) => (
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
                                    {preview.rows.map((r) => {
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
                                                <td>{r.recipientName}{r.externalRef && <><br /><span className="izy-muted">{r.externalRef}</span></>}</td>
                                                <td>{r.address}<br /><span className="izy-muted">{r.city} {r.state} {r.zip}</span></td>
                                                <td>{r.zone !== null ? r.zone
                                                    : r.issues.some((i) => i.code === 'zone.outOfArea')
                                                        ? <span className="izy-pill warn">out of area</span>
                                                        // A row with no usable ZIP is not out of area, it is unknown.
                                                        : <span className="izy-muted">unknown</span>}</td>
                                                <td>{r.serviceType}</td>
                                                <td>{r.quantity}</td>
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

                            <div className="izy-row" style={{ marginTop: 14 }}>
                                <button
                                    className="izy-btn"
                                    type="button"
                                    disabled={busy !== null || preview.summary.willImport === 0 || preview.missingRequired.length > 0}
                                    onClick={() => { void send(false); }}
                                >
                                    {busy === 'commit' ? 'Importing' : `Import ${preview.rows.filter((r) => r.willImport && !skipRows.includes(r.row)).length} orders`}
                                </button>
                                <button className="izy-btn secondary" type="button" disabled={busy !== null} onClick={reset}>Cancel</button>
                            </div>
                        </>
                    )}
                </>
            )}

            <h3 style={{ marginTop: 24 }}>Recent imports</h3>
            {recent === null ? <Loading label="Loading imports" /> : recent.length === 0 ? (
                <div className="izy-muted">Nothing imported yet.</div>
            ) : (
                <table className="izy-table">
                    <thead><tr><th>Date</th><th>Pharmacy</th><th>Orders</th><th>Skipped</th><th>File</th><th>By</th></tr></thead>
                    <tbody>
                        {recent.map((l) => (
                            <tr key={l.id}>
                                <td>{l.serviceDate}</td>
                                <td>{l.site.name}</td>
                                <td>{l.orderCount}</td>
                                <td>{l.skippedCount}</td>
                                <td className="izy-muted">{l.sourceFilename || 'unnamed'}</td>
                                <td className="izy-muted">{l.importedBy}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
