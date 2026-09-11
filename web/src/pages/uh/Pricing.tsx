/* The contract price schedule and zone map, read-only for any member, with a
   quote box so anyone can check what a delivery bills at. */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';

interface Schedule {
    effectiveFrom: string;
    zoneRates: Record<string, number>;
    statSurcharge: number;
    afterHoursSurcharge: number;
    dryRunFee: number;
    outOfAreaPerMile: number;
}
interface PricingInfo {
    on: string;
    schedule: Schedule | null;
    settings: { afterHoursStart: string; afterHoursEnd: string; timezone: string; dryRunReplacesBase: boolean };
    zoneZipCounts: Array<{ zone: number; zips: number }>;
}
interface Quote {
    zip: string | null; zone: number | null; base: number; statSurcharge: number; afterHoursSurcharge: number;
    dryRunFee: number; outOfArea: { miles: number; perMile: number; amount: number }; total: number; notes: string[];
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function Pricing({ projectCode }: { projectCode: string }) {
    const base = `/api/projects/${projectCode}/uh/pricing`;
    const [info, setInfo] = useState<PricingInfo | null>(null);
    const [form, setForm] = useState({ zip: '', serviceType: 'scheduled', dryRun: false, items: '1', miles: '' });
    const [quote, setQuote] = useState<Quote | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try { setInfo(await api<PricingInfo>(base)); } catch { setInfo({ on: '', schedule: null, settings: { afterHoursStart: '', afterHoursEnd: '', timezone: '', dryRunReplacesBase: true }, zoneZipCounts: [] }); }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

    const getQuote = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        setQuote(null);
        try {
            const body: Record<string, unknown> = { zip: form.zip.trim(), serviceType: form.serviceType, dryRun: form.dryRun };
            if (form.dryRun && form.items) body['items'] = Number(form.items);
            if (form.miles) body['outOfAreaMiles'] = Number(form.miles);
            setQuote(await api<Quote>(`${base}/quote`, { method: 'POST', json: body }));
        } catch (err) {
            setError(err instanceof ApiError ? [err.message, ...err.details].join(' ') : 'Could not price that');
        }
    };

    if (info === null) return <div className="izy-card"><Loading label="Loading pricing" /></div>;
    const s = info.schedule;

    return (
        <div className="izy-card">
            <h2>Contract pricing</h2>
            {!s ? <div className="izy-muted">No price schedule is in effect for this project.</div> : (
                <>
                    <div className="izy-muted" style={{ marginBottom: 10 }}>
                        In effect from {s.effectiveFrom}. After hours {info.settings.afterHoursStart} to {info.settings.afterHoursEnd} {info.settings.timezone}.
                        Dry run {info.settings.dryRunReplacesBase ? 'replaces' : 'adds to'} the delivery charge.
                    </div>
                    <table className="izy-table">
                        <thead><tr><th>Zone</th><th>Per delivery</th><th>ZIPs</th></tr></thead>
                        <tbody>
                            {[1, 2, 3, 4, 5].map((z) => (
                                <tr key={z}>
                                    <td>Zone {z}</td>
                                    <td>{usd(s.zoneRates[String(z)] ?? 0)}</td>
                                    <td>{info.zoneZipCounts.find((c) => c.zone === z)?.zips ?? 0}</td>
                                </tr>
                            ))}
                            <tr><td>STAT surcharge</td><td>{usd(s.statSurcharge)}</td><td /></tr>
                            <tr><td>After hours surcharge</td><td>{usd(s.afterHoursSurcharge)}</td><td /></tr>
                            <tr><td>Dry run, per item</td><td>{usd(s.dryRunFee)}</td><td /></tr>
                            <tr><td>Out of area, per one-way mile</td><td>{usd(s.outOfAreaPerMile)}</td><td /></tr>
                        </tbody>
                    </table>

                    <h2 style={{ marginTop: 20 }}>Price a delivery</h2>
                    <form className="izy-row" onSubmit={(e) => { void getQuote(e); }}>
                        <label className="izy-field">Destination ZIP<input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} required placeholder="78229" /></label>
                        <label className="izy-field">Service
                            <select value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value })}>
                                <option value="scheduled">scheduled</option>
                                <option value="stat">STAT</option>
                                <option value="adhoc">ad hoc</option>
                            </select>
                        </label>
                        <label className="izy-field">Miles (out of area)<input value={form.miles} onChange={(e) => setForm({ ...form, miles: e.target.value })} inputMode="decimal" placeholder="optional" /></label>
                        <label className="izy-field" style={{ minWidth: 120 }}>Dry run
                            <span><input type="checkbox" checked={form.dryRun} onChange={(e) => setForm({ ...form, dryRun: e.target.checked })} /> attempted, not delivered</span>
                        </label>
                        {form.dryRun && <label className="izy-field">Items<input value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })} inputMode="numeric" /></label>}
                        <button className="izy-btn" type="submit">Price it</button>
                    </form>

                    {error && <div className="izy-alert error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
                    {quote && (
                        <div className="izy-alert ok" role="status" style={{ marginTop: 12 }}>
                            <b>{usd(quote.total)}</b>{' '}
                            {quote.zone === null ? 'out of area' : `zone ${quote.zone}`}
                            {quote.base > 0 && ` · base ${usd(quote.base)}`}
                            {quote.statSurcharge > 0 && ` · STAT ${usd(quote.statSurcharge)}`}
                            {quote.afterHoursSurcharge > 0 && ` · after hours ${usd(quote.afterHoursSurcharge)}`}
                            {quote.dryRunFee > 0 && ` · dry run ${usd(quote.dryRunFee)}`}
                            {quote.outOfArea.amount > 0 && ` · ${quote.outOfArea.miles} mi ${usd(quote.outOfArea.amount)}`}
                            {quote.notes.length > 0 && <ul>{quote.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
