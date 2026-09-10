import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, fmtWhen, type AuditEvent } from '../lib/api';

interface Page { events: AuditEvent[]; nextBefore: number | null }

export function Audit() {
    const [params, setParams] = useSearchParams();
    const [filters, setFilters] = useState({
        username: params.get('username') ?? '', action: params.get('action') ?? '', entity: params.get('entity') ?? '', entityId: params.get('entityId') ?? '',
    });
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const query = useCallback(async (before?: number) => {
        setBusy(true);
        setError(null);
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) if (v.trim()) q.set(k, v.trim());
        q.set('limit', '50');
        if (before) q.set('before', String(before));
        try {
            const page = await api<Page>(`/api/audit?${q.toString()}`);
            setEvents((prev) => (before ? [...prev, ...page.events] : page.events));
            setNextBefore(page.nextBefore);
        } catch (err) {
            setError(err instanceof ApiError ? [err.message, ...err.details].join(' ') : 'Failed to load');
        } finally {
            setBusy(false);
        }
    }, [filters]);

    useEffect(() => { void query(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const apply = (e: FormEvent) => {
        e.preventDefault();
        const next = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) if (v.trim()) next.set(k, v.trim());
        setParams(next, { replace: true });
        void query();
    };

    return (
        <>
            <h1>Audit log</h1>
            <p className="izy-sub">Who did what, newest first. Append-only.</p>
            <div className="izy-card">
                <form className="izy-row" onSubmit={apply}>
                    <label className="izy-field">Username<input value={filters.username} onChange={(e) => setFilters({ ...filters, username: e.target.value })} /></label>
                    <label className="izy-field">Action (prefix)<input placeholder="auth, logs.save, user" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} /></label>
                    <label className="izy-field">Entity<input value={filters.entity} onChange={(e) => setFilters({ ...filters, entity: e.target.value })} /></label>
                    <label className="izy-field">Entity id<input value={filters.entityId} onChange={(e) => setFilters({ ...filters, entityId: e.target.value })} /></label>
                    <button className="izy-btn" type="submit" disabled={busy}>Search</button>
                </form>
            </div>
            {error && <div className="izy-alert error" role="alert">{error}</div>}
            <div className="izy-card">
                <table className="izy-table">
                    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th><th>IP</th></tr></thead>
                    <tbody>
                        {events.map((e) => (
                            <tr key={e.id}>
                                <td>{fmtWhen(e.at)}</td>
                                <td>{e.username ?? <span className="izy-muted">anonymous</span>}</td>
                                <td><code>{e.action}</code></td>
                                <td>{e.entity}{e.entity_id ? <> <code>{e.entity_id}</code></> : null}{e.project_id ? <span className="izy-pill muted" style={{ marginLeft: 4 }}>project {e.project_id}</span> : null}</td>
                                <td><code>{JSON.stringify(e.detail)}</code></td>
                                <td><code>{e.ip}</code></td>
                            </tr>
                        ))}
                        {events.length === 0 && !busy && <tr><td colSpan={6} className="izy-muted">No events match.</td></tr>}
                    </tbody>
                </table>
                {nextBefore && <div style={{ marginTop: 12 }}><button className="izy-btn secondary" type="button" disabled={busy} onClick={() => { void query(nextBefore); }}>Load older</button></div>}
            </div>
        </>
    );
}
