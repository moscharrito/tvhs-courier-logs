/* The applications queue: the screen that lets a person be approved.
 *
 * Ticket 8.1, and the first client of the endpoints ticket 6.1 and 6.2 built.
 * Until this existed, dispatch could not approve a single driver without
 * curl, which means the DoorDash model shipped as a server with no door.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN IS FOR, precisely: a named member of staff says "I have
 * seen this person's HIPAA training certificate" and puts their name to it.
 * Everything else here is arranging that sentence so it cannot be confused
 * with a different one.
 *
 * THE CONFUSION IT EXISTS TO PREVENT. An applicant can type a certificate
 * number into their phone (ticket 7.2). A member of staff can record having
 * seen the certificate. Those are different facts and the server keeps them
 * in different columns on purpose: `submitted_reference` is what somebody
 * typed about themselves, `reference` is what a colleague wrote down having
 * looked at the thing. If this screen rendered them in the same box, the
 * whole distinction would be a database detail with no effect on anybody,
 * and an unverified claim would look exactly like a verification to the
 * person deciding. So a claim is always labelled as a claim, always carries
 * who said it, and never sits in the field where a verification goes.
 *
 * THE SCREEN DOES NOT DECIDE CLEARANCE, and the Approve button is enabled
 * even when the five gates are not green. That looks wrong and is
 * deliberate, for two reasons. `clearance.ts` says no screen decides this;
 * a disabled button is a screen deciding. And this page's copy of the
 * clearance goes stale the moment a colleague verifies a check in another
 * tab, so a button disabled from stale state locks out the person who is
 * entitled to act. The server refuses with a sentence naming what is
 * missing, and that sentence is what the operator reads. One wasted round
 * trip, no wrong answers.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';

/* Mirrors CHECK_KINDS in server/src/core/onboarding/clearance.ts, which is
   the source of truth. Duplicated rather than fetched because these five are
   a contract obligation, not configuration: a sixth gate is a conversation
   with University Health and a migration, not a deploy. If it ever does
   change, the server's list is the one to change first. */
const KINDS = ['hipaa_training', 'confidentiality', 'background_check', 'drivers_licence', 'insurance'] as const;
export type CheckKind = (typeof KINDS)[number];

const LABEL: Record<CheckKind, string> = {
    hipaa_training: 'HIPAA training',
    confidentiality: 'Confidentiality agreement',
    background_check: 'Background check',
    drivers_licence: 'Driving licence',
    insurance: 'Insurance',
};

/* What the person verifying is actually looking at, so the box does not just
   say "Reference" and leave them guessing what to type. */
const WHAT_TO_ASK_FOR: Record<CheckKind, string> = {
    hipaa_training: 'Certificate number and the awarding body',
    confidentiality: 'Where the signed copy is filed',
    background_check: 'The vendor and their report reference',
    drivers_licence: 'Licence number and issuing state',
    insurance: 'Policy number and insurer',
};

/* EXPIRING in clearance.ts. The other two are done once, and offering an
   expiry date for a signed confidentiality agreement invites somebody to
   invent one. */
const EXPIRES: readonly CheckKind[] = ['hipaa_training', 'drivers_licence', 'insurance'];

export interface Clearance {
    ready: boolean;
    missing: CheckKind[];
    expired: CheckKind[];
    failed: CheckKind[];
    why: string;
}

export interface ApplicationCheck {
    kind: CheckKind;
    status: 'pending' | 'verified' | 'failed';
    verifiedBy: string;
    verifiedAt: string | null;
    reference: string;
    expiresAt: string | null;
    note: string;
    /* Nested by the server so this screen cannot flatten a claim into a
       verification by accident. Keep it nested here too. */
    submitted: { reference: string; note: string; at: string } | null;
}

export interface ApplicationRow {
    id: number;
    name: string;
    email: string;
    phone: string;
    claims: string;
    status: string;
    submittedAt: string | null;
    decidedAt: string | null;
    decidedBy: string;
    decisionReason: string;
    hasAccount: boolean;
    clearance: Clearance;
}

export interface ApplicationDetail extends ApplicationRow {
    checks: ApplicationCheck[];
}

const STATUS_PILL: Record<string, string> = {
    submitted: 'warn', in_review: 'warn', approved: '', rejected: 'off',
};

/** How far through the five a person is, in the queue, at a glance. */
function progress(c: Clearance): string {
    const outstanding = c.missing.length + c.expired.length + c.failed.length;
    if (outstanding === 0) return 'all five green';
    return `${KINDS.length - outstanding} of ${KINDS.length} green`;
}

export function Applications() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const base = `/api/projects/${code}/driver-applications`;

    const [status, setStatus] = useState('submitted');
    const [rows, setRows] = useState<ApplicationRow[] | null>(null);
    const [openId, setOpenId] = useState<number | null>(null);
    const [detail, setDetail] = useState<ApplicationDetail | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] } | null>(null);

    /* A courier is refused below, and asking for the list first would put a
       request for other people's licence numbers in the log under their
       name for no reason. */
    const mayRead = project === undefined || project.role === 'admin';

    const load = useCallback(async () => {
        if (!mayRead) { setRows([]); return; }
        try {
            const r = await api<{ applications: ApplicationRow[] }>(`${base}?status=${encodeURIComponent(status)}`);
            setRows(r.applications);
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load applications' });
            setRows([]);
        }
    }, [base, status, mayRead]);
    useEffect(() => { void load(); }, [load]);

    const open = useCallback(async (id: number) => {
        setOpenId(id);
        setDetail(null);
        setMsg(null);
        try {
            setDetail(await api<ApplicationDetail>(`${base}/${id}`));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load this application' });
        }
    }, [base]);

    /* Both lists are refreshed after every decision. The queue's clearance
       column is computed server-side, so a check recorded in the detail
       panel changes a row in the table behind it. */
    const reload = async (id: number) => { await load(); await open(id); };

    const paged = usePaged(rows ?? []);

    if (project && project.role !== 'admin') {
        return (
            <>
                <h1>Not yours to see</h1>
                <p className="izy-sub">
                    Applications carry somebody&apos;s licence number, their insurer and the result of a background
                    check on them. Dispatch and admin only.
                </p>
                <Link className="izy-btn secondary" to={`/projects/${code}/my-run`}>Back to your run</Link>
            </>
        );
    }

    return (
        <>
            <h1>Driver applications</h1>
            <p className="izy-sub">
                Five things have to be recorded against a name before anybody reads a patient&apos;s address.
                Approving grants a membership on <code>{code}</code>; the account already exists and has been
                able to sign in, and see nothing, since they applied.
            </p>

            {msg && (
                <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                    {msg.text}
                    {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                </div>
            )}

            <Section
                id="uh.applications"
                title="The queue"
                summary={rows === null ? undefined : `${rows.length} ${status.replace('_', ' ')}`}
                actions={(
                    <label className="izy-field inline">
                        Showing
                        <select value={status} onChange={(e) => { setStatus(e.target.value); setOpenId(null); setDetail(null); }}>
                            <option value="submitted">Waiting on us</option>
                            <option value="in_review">In review</option>
                            <option value="approved">Approved</option>
                            <option value="rejected">Rejected</option>
                        </select>
                    </label>
                )}
            >
                {rows === null ? <Loading label="Loading applications" /> : (
                    <>
                        <table className="izy-table">
                            <thead>
                                <tr><th>Applicant</th><th>Applied</th><th>Onboarding</th><th>Status</th><th /></tr>
                            </thead>
                            <tbody>
                                {paged.rows.map((a) => (
                                    <tr key={a.id}>
                                        <td>
                                            <b>{a.name}</b>
                                            <div className="izy-muted">{a.email} · {a.phone}</div>
                                        </td>
                                        <td>{a.submittedAt ? a.submittedAt.slice(0, 10) : <span className="izy-muted">not submitted</span>}</td>
                                        <td>
                                            {a.clearance.ready
                                                ? <span className="izy-pill">all five green</span>
                                                : <><span className="izy-pill warn">{progress(a.clearance)}</span>
                                                    <div className="izy-muted">{a.clearance.why}</div></>}
                                        </td>
                                        <td><span className={`izy-pill ${STATUS_PILL[a.status] ?? ''}`}>{a.status.replace('_', ' ')}</span></td>
                                        <td style={{ textAlign: 'right' }}>
                                            <button
                                                className="izy-btn secondary small"
                                                type="button"
                                                aria-expanded={openId === a.id}
                                                onClick={() => { if (openId === a.id) { setOpenId(null); setDetail(null); } else { void open(a.id); } }}
                                            >
                                                {openId === a.id ? 'Close' : 'Open'}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {rows.length === 0 && (
                                    <tr><td colSpan={5} className="izy-muted">Nothing {status.replace('_', ' ')}.</td></tr>
                                )}
                            </tbody>
                        </table>
                        <Pager of={paged} noun="applications" />
                    </>
                )}
            </Section>

            {openId !== null && (
                detail === null
                    ? <Loading label="Loading this application" />
                    : <Detail
                        base={base}
                        application={detail}
                        onDone={(text) => { setMsg({ kind: 'ok', text }); setOpenId(null); setDetail(null); void load(); }}
                        onChanged={() => { void reload(detail.id); }}
                        onError={(text, details) => setMsg({ kind: 'error', text, details })}
                    />
            )}
        </>
    );
}

/* ------------------------------------------------------------------ detail */

function Detail({ base, application, onDone, onChanged, onError }: {
    base: string;
    application: ApplicationDetail;
    onDone: (text: string) => void;
    onChanged: () => void;
    onError: (text: string, details?: string[]) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const decided = application.status === 'approved' || application.status === 'rejected';

    const byKind = new Map(application.checks.map((c) => [c.kind, c]));

    const approve = async () => {
        setBusy(true);
        try {
            const r = await api<{ username: string }>(`${base}/${application.id}/approve`, { method: 'POST', json: {} });
            onDone(`${application.name} is approved and can sign in as ${r.username}.`);
        } catch (err) {
            /* The server's sentence, not ours. It names the gates. */
            onError(err instanceof ApiError ? err.message : 'Could not approve this application');
        } finally {
            setBusy(false);
        }
    };

    const reject = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            await api(`${base}/${application.id}/reject`, { method: 'POST', json: { reason } });
            onDone(`${application.name} was rejected, and their account is disabled.`);
        } catch (err) {
            onError(
                err instanceof ApiError ? err.message : 'Could not reject this application',
                err instanceof ApiError ? err.details : undefined,
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="izy-card">
            <h2>{application.name}</h2>
            <p className="izy-sub">{application.email} · {application.phone}</p>

            {application.claims && (
                /* Headed as what it is. This is the paragraph the applicant
                   typed about themselves on a public form; it is not
                   evidence of anything and must not read as though it were. */
                <div className="izy-alert" style={{ background: 'var(--izy-warn-soft)', color: '#92400e' }}>
                    <b>What the applicant wrote about themselves.</b> Unverified.
                    <div>{application.claims}</div>
                </div>
            )}

            <h3>The five gates</h3>
            <table className="izy-table">
                <thead>
                    <tr><th>Check</th><th>Verified</th><th>What the applicant supplied</th><th>Record it</th></tr>
                </thead>
                <tbody>
                    {KINDS.map((kind) => (
                        <CheckRow
                            key={kind}
                            kind={kind}
                            check={byKind.get(kind)}
                            base={base}
                            applicationId={application.id}
                            readOnly={decided}
                            onChanged={onChanged}
                            onError={onError}
                        />
                    ))}
                </tbody>
            </table>

            <div className={`izy-alert ${application.clearance.ready ? 'ok' : ''}`} role="status">
                {application.clearance.why}
            </div>

            {decided ? (
                <p className="izy-muted">
                    {application.status === 'approved' ? 'Approved' : 'Rejected'} by {application.decidedBy || 'somebody'}
                    {application.decidedAt ? ` on ${application.decidedAt.slice(0, 10)}` : ''}.
                    {application.decisionReason && ` Reason: ${application.decisionReason}`}
                </p>
            ) : (
                <div className="izy-row">
                    {/* Enabled regardless of clearance. See the header of this
                        file: the server decides, and this page's copy of the
                        clearance is stale the moment a colleague records a
                        check in another tab. */}
                    <button className="izy-btn" type="button" disabled={busy} onClick={() => { void approve(); }}>
                        Approve and grant access
                    </button>
                    {!rejecting && (
                        <button className="izy-btn danger" type="button" disabled={busy} onClick={() => setRejecting(true)}>
                            Reject
                        </button>
                    )}
                </div>
            )}

            {rejecting && !decided && (
                <form className="izy-row" onSubmit={(e) => { void reject(e); }}>
                    <label className="izy-field" style={{ flex: 1 }}>
                        Why this is being rejected
                        {/* Said out loud, because the operator is about to
                            take away a working login, not tick a box. */}
                        <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            minLength={10}
                            required
                            placeholder="At least a sentence. They can appeal, and somebody will have to answer it."
                        />
                    </label>
                    <button className="izy-btn danger" type="submit" disabled={busy}>
                        Reject and disable the account
                    </button>
                    <button className="izy-btn secondary" type="button" onClick={() => { setRejecting(false); setReason(''); }}>
                        Cancel
                    </button>
                </form>
            )}
        </div>
    );
}

/* -------------------------------------------------------------- one gate */

function CheckRow({ kind, check, base, applicationId, readOnly, onChanged, onError }: {
    kind: CheckKind;
    check: ApplicationCheck | undefined;
    base: string;
    applicationId: number;
    readOnly: boolean;
    onChanged: () => void;
    onError: (text: string, details?: string[]) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [form, setForm] = useState({
        status: 'verified' as ApplicationCheck['status'],
        reference: '',
        expiresAt: '',
        note: '',
    });

    const status = check?.status ?? 'pending';
    const expires = EXPIRES.includes(kind);

    const begin = () => {
        setForm({
            status: status === 'pending' ? 'verified' : status,
            /* Seeded from the verified reference, never from what the
               applicant submitted. Prefilling the box with somebody's own
               claim and asking a colleague to press Save is how an
               unverified number becomes a verified one by a single click. */
            reference: check?.reference ?? '',
            expiresAt: check?.expiresAt ?? '',
            note: check?.note ?? '',
        });
        setEditing(true);
    };

    const save = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            await api(`${base}/${applicationId}/checks/${kind}`, {
                method: 'PUT',
                json: {
                    status: form.status,
                    reference: form.reference,
                    /* An empty date box is "this does not expire", not the
                       string "". The server takes null or YYYY-MM-DD. */
                    expiresAt: form.expiresAt === '' ? null : form.expiresAt,
                    note: form.note,
                },
            });
            setEditing(false);
            onChanged();
        } catch (err) {
            onError(
                err instanceof ApiError ? err.message : `Could not record ${LABEL[kind]}`,
                err instanceof ApiError ? err.details : undefined,
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <tr>
            <td>
                <b>{LABEL[kind]}</b>
                <div className="izy-muted">{WHAT_TO_ASK_FOR[kind]}</div>
            </td>
            <td>
                <span className={`izy-pill ${status === 'verified' ? '' : status === 'failed' ? 'off' : 'warn'}`}>{status}</span>
                {check && status !== 'pending' && (
                    <div className="izy-muted">
                        {/* The name is the point of the row. A verification
                            without one is nobody standing behind it. */}
                        {check.verifiedBy ? `${check.verifiedBy}` : 'nobody named'}
                        {check.verifiedAt ? `, ${check.verifiedAt.slice(0, 10)}` : ''}
                        {check.reference && <div><code>{check.reference}</code></div>}
                        {check.expiresAt && <div>expires {check.expiresAt}</div>}
                        {check.note && <div>{check.note}</div>}
                    </div>
                )}
            </td>
            <td>
                {check?.submitted
                    ? (
                        <div className="izy-muted">
                            {/* Never in the same shape as the column beside
                                it. This is a claim with a date on it. */}
                            <i>Typed by the applicant on {check.submitted.at.slice(0, 10)}</i>
                            {check.submitted.reference && <div><code>{check.submitted.reference}</code></div>}
                            {check.submitted.note && <div>{check.submitted.note}</div>}
                        </div>
                    )
                    : kind === 'background_check'
                        /* 7.2 tells the applicant this is not theirs to
                           chase. The same sentence belongs here, so nobody
                           waits on a person who was told to wait on us. */
                        ? <span className="izy-muted">Ours to run, not theirs to supply</span>
                        : <span className="izy-muted">Nothing supplied</span>}
            </td>
            <td style={{ textAlign: 'right' }}>
                {readOnly
                    ? <span className="izy-muted">decided</span>
                    : !editing
                        ? <button className="izy-btn secondary small" type="button" onClick={begin}>Record</button>
                        : null}
                {editing && !readOnly && (
                    <form onSubmit={(e) => { void save(e); }}>
                        <label className="izy-field">
                            {LABEL[kind]}
                            <select
                                aria-label={`${LABEL[kind]} result`}
                                value={form.status}
                                onChange={(e) => setForm({ ...form, status: e.target.value as ApplicationCheck['status'] })}
                            >
                                <option value="verified">I have seen it</option>
                                <option value="failed">It did not pass</option>
                                <option value="pending">Put it back to pending</option>
                            </select>
                        </label>
                        <label className="izy-field">
                            Reference
                            <input
                                aria-label={`${LABEL[kind]} reference`}
                                value={form.reference}
                                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                                placeholder={WHAT_TO_ASK_FOR[kind]}
                            />
                        </label>
                        {expires && (
                            <label className="izy-field">
                                Expires
                                <input
                                    type="date"
                                    aria-label={`${LABEL[kind]} expiry date`}
                                    value={form.expiresAt}
                                    onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                                />
                            </label>
                        )}
                        <label className="izy-field">
                            Note
                            <input
                                aria-label={`${LABEL[kind]} note`}
                                value={form.note}
                                onChange={(e) => setForm({ ...form, note: e.target.value })}
                            />
                        </label>
                        <button className="izy-btn small" type="submit" disabled={busy}>Save</button>
                        <button className="izy-btn secondary small" type="button" onClick={() => setEditing(false)}>Cancel</button>
                    </form>
                )}
            </td>
        </tr>
    );
}
