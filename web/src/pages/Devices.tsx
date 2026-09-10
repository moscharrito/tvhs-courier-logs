import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, fmtWhen, type SessionSummary } from '../lib/api';

export function Devices() {
    const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

    const load = useCallback(async () => {
        try { setSessions(await api<SessionSummary[]>('/api/me/sessions')); } catch (err) { setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Failed to load' }); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const revoke = async (url: string, label: string) => {
        setMsg(null);
        try {
            await api(url, { method: 'DELETE' });
            setMsg({ kind: 'ok', text: label });
            await load();
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Request failed' });
        }
    };

    return (
        <>
            <h1>My devices</h1>
            <p className="izy-sub">Every browser or phone where you are signed in. Sign out anything you do not recognize.</p>
            {msg && <div className={`izy-alert ${msg.kind}`}>{msg.text}</div>}
            <div className="izy-card">
                {sessions === null ? <div className="izy-muted">Loading...</div> : (
                    <table className="izy-table">
                        <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead>
                        <tbody>
                            {sessions.map((s) => (
                                <tr key={s.id}>
                                    <td>{s.device} {s.current && <span className="izy-pill">this device</span>}</td>
                                    <td><code>{s.ip}</code></td>
                                    <td>{fmtWhen(s.created_at)}</td>
                                    <td>{fmtWhen(s.last_seen_at)}</td>
                                    <td style={{ textAlign: 'right' }}>
                                        {!s.current && <button className="izy-btn danger small" type="button" onClick={() => { void revoke(`/api/me/sessions/${s.id}`, 'Device signed out'); }}>Sign out</button>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div style={{ marginTop: 12 }}>
                    <button className="izy-btn danger" type="button" disabled={!sessions || sessions.length < 2} onClick={() => { void revoke('/api/me/sessions/others', 'All other devices signed out'); }}>Sign out all other devices</button>
                </div>
            </div>
        </>
    );
}
