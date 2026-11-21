/* Splitting a counter's list between the drivers standing at it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES, WHICH IS NOT A CONVENIENCE.
 *
 * Until now dispatch downloaded the day's list, pasted it into an external
 * chat assistant -- every patient name, address and telephone number on it
 * -- asked for clusters by zone and ZIP, downloaded one spreadsheet per
 * driver, and imported them back one at a time. The clustering was the
 * small part. The part that mattered is that a day of protected health
 * information left the building to get it, every day.
 *
 * It all happens here now, and nothing is sent anywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT OPENS WHERE THE WORK IS, which is the moment after an import.
 *
 * Clustering needs ORDERS, and a list handed over is a file until somebody
 * imports it. So the button lives on the import outcome -- the one moment
 * when the pharmacy, the service date and the orders are all known and the
 * dispatcher is already looking at the right screen.
 *
 * It is NOT the "plan the wave" panel that was built on the board twice and
 * removed twice. That one proposed runs for nine counters at once and had
 * its own courier picker. This is one counter's list, the drivers already
 * on shift at it, and the same POST the dispatcher's own click makes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTHING IS WRITTEN UNTIL "ASSIGN".
 *
 * Pressing Cluster asks the server for a split and draws it. No run exists,
 * no order moves, and closing the dialog costs nothing. That matters
 * because the split is a judgement: a dispatcher who knows one driver is
 * slow today should be able to look, disagree, tick a different set and
 * look again, without undoing anything.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, why, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';

interface Driver {
    username: string;
    name: string;
    homeSiteId: number | null;
    onShift: boolean;
}

interface Round {
    orderIds: number[];
    stops: number;
    zips: string[];
    siteIds: number[];
    earliestDueAt: string | null;
    spreadMiles: number | null;
    stretched: boolean;
    courier: { username: string; name: string; why: 'home' | 'floater' | 'cover' } | null;
}

interface Split {
    serviceDate: string;
    site: { id: number; code: string; name: string };
    rounds: Round[];
    urgent: number[];
    notes: string[];
}

export function ClusterDialog({ projectCode, site, serviceDate, onClose, onDone }: {
    projectCode: string;
    site: { id: number; code: string; name: string };
    serviceDate: string;
    onClose: () => void;
    /** Told when runs were created, so the screen behind can refresh. */
    onDone: (runs: number) => void;
}) {
    const [drivers, setDrivers] = useState<Driver[] | null>(null);
    const [ticked, setTicked] = useState<string[]>([]);
    const [split, setSplit] = useState<Split | null>(null);
    const [busy, setBusy] = useState<'' | 'drivers' | 'cluster' | 'assign'>('drivers');
    const [err, setErr] = useState('');
    const [assigned, setAssigned] = useState(false);

    /* Who could carry it: this counter's own drivers, on shift first. The
       roster read is the planner's, so "whose pharmacy is this" is answered
       in one place rather than two. */
    useEffect(() => {
        let gone = false;
        (async () => {
            try {
                /* The same endpoint that does the splitting, asked without
                   any drivers: it answers with who could carry it. Reading
                   them from /runs/propose instead was the first attempt and
                   was wrong -- that roster is deliberately stripped to what
                   staffProposal takes and carries no shift state, so every
                   driver came back looking off shift. */
                const got = await api<{ drivers: Driver[] }>(
                    `/api/projects/${projectCode}/uh/runs/split`
                    + `?site=${encodeURIComponent(site.code)}&serviceDate=${serviceDate}`,
                );
                if (gone) return;
                const list = got.drivers ?? [];
                setDrivers(list);
                /* On shift is ticked to start with, because that is the
                   answer on almost every day. Everybody else is listed and
                   untouched -- a driver who has not tapped Go on shift can
                   still be given a round, and sometimes has to be. */
                setTicked(list.filter((d) => d.onShift).map((d) => d.username));
            } catch (e) {
                if (!gone) setErr(why(e, 'Could not read the driver list.'));
            } finally {
                if (!gone) setBusy('');
            }
        })();
        return () => { gone = true; };
    }, [projectCode, site.code, serviceDate]);

    /* Escape closes, like every other dialog on this site. */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const cluster = useCallback(async () => {
        setBusy('cluster');
        setErr('');
        setSplit(null);
        try {
            const got = await api<Split>(
                `/api/projects/${projectCode}/uh/runs/split`
                + `?site=${encodeURIComponent(site.code)}&serviceDate=${serviceDate}`
                + `&couriers=${encodeURIComponent(ticked.join(','))}`,
            );
            setSplit(got);
        } catch (e) {
            setErr(why(e, 'The list could not be clustered.'));
        } finally {
            setBusy('');
        }
    }, [projectCode, site.code, serviceDate, ticked]);

    const assign = useCallback(async () => {
        if (!split) return;
        setBusy('assign');
        setErr('');
        try {
            const out = await api<{ runs: unknown[]; rejected: unknown[] }>(
                `/api/projects/${projectCode}/uh/runs/split/apply`,
                {
                    method: 'POST',
                    json: {
                        serviceDate: split.serviceDate,
                        siteId: split.site.id,
                        rounds: split.rounds
                            .filter((r) => r.courier !== null)
                            .map((r) => ({ courierUsername: r.courier!.username, orderIds: r.orderIds })),
                    },
                },
            );
            setAssigned(true);
            onDone(out.runs.length);
        } catch (e) {
            /* A stale split is the interesting failure: somebody took an
               order between clustering and accepting. The server refuses
               the whole thing rather than half-applying it, so the honest
               thing here is to say that and offer another go. */
            setErr(e instanceof ApiError && e.code === 'split.stale'
                ? `${e.message} Press Cluster again.`
                : why(e, 'The rounds could not be created.'));
        } finally {
            setBusy('');
        }
    }, [projectCode, split, onDone]);

    const flip = (username: string) => {
        setSplit(null);
        setTicked((was) => (was.includes(username)
            ? was.filter((u) => u !== username)
            : [...was, username]));
    };

    const onShift = (drivers ?? []).filter((d) => d.onShift);
    const off = (drivers ?? []).filter((d) => !d.onShift);

    return (
        <div className="izy-modal-back" role="presentation" onMouseDown={onClose}>
            <div
                className="izy-modal izy-cluster"
                role="dialog"
                aria-modal="true"
                aria-label={`Split the ${site.name} list`}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="izy-cluster-head">
                    <div>
                        <h2>Split this list between drivers</h2>
                        <p className="izy-muted">{site.name} · {serviceDate}</p>
                    </div>
                    <button type="button" className="izy-btn secondary small" onClick={onClose}>Close</button>
                </div>

                {err !== '' && <div className="izy-alert error" role="alert">{err}</div>}

                {busy === 'drivers' && <Loading label="Reading the driver list" />}

                {drivers !== null && (
                    <>
                        <div className="izy-cluster-who">
                            <h3>Who is carrying it</h3>
                            {onShift.length === 0 && (
                                <p className="izy-alert warn" role="status">
                                    Nobody from {site.name} is on shift. Tick whoever is driving it anyway.
                                </p>
                            )}
                            <ul className="izy-cluster-drivers">
                                {[...onShift, ...off].map((d) => (
                                    <li key={d.username}>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={ticked.includes(d.username)}
                                                onChange={() => flip(d.username)}
                                            />
                                            <span>
                                                {d.name}
                                                {d.onShift
                                                    ? <span className="izy-pill">On shift</span>
                                                    : <span className="izy-pill muted">Not on shift</span>}
                                            </span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                className="izy-btn"
                                disabled={ticked.length === 0 || busy !== '' || assigned}
                                onClick={() => { void cluster(); }}
                            >
                                {busy === 'cluster' ? 'Clustering…' : `Cluster between ${ticked.length} `
                                    + `${ticked.length === 1 ? 'driver' : 'drivers'}`}
                            </button>
                            <p className="izy-muted izy-cluster-note">
                                Grouped by zone and ZIP so each driver stays in one part of the city.
                                Nothing is assigned until you press Assign.
                            </p>
                        </div>

                        {split !== null && (
                            <div className="izy-cluster-out">
                                <h3>{split.rounds.length} {split.rounds.length === 1 ? 'round' : 'rounds'}</h3>

                                {split.notes.map((n) => (
                                    <p key={n} className="izy-alert warn" role="status">{n}</p>
                                ))}

                                <div className="scroller">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Driver</th><th>Stops</th><th>ZIPs</th>
                                                <th>Width</th><th>{assigned ? 'Spreadsheet' : ''}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {split.rounds.map((r, i) => (
                                                <tr key={r.courier?.username ?? i}>
                                                    <td>
                                                        {r.courier?.name ?? <span className="izy-muted">nobody left</span>}
                                                        {r.courier?.why === 'cover' && (
                                                            <span className="izy-pill warn">Another counter</span>
                                                        )}
                                                    </td>
                                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.stops}</td>
                                                    <td className="izy-cluster-zips">{r.zips.join(', ')}</td>
                                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {r.spreadMiles === null
                                                            ? <span className="izy-muted">not known</span>
                                                            : `${r.spreadMiles} mi`}
                                                        {r.stretched && <span className="izy-pill off">Wide</span>}
                                                    </td>
                                                    <td>
                                                        {assigned && r.courier && (
                                                            <a
                                                                className="izy-btn secondary small"
                                                                href={`/api/projects/${projectCode}/uh/runs/export.xlsx`
                                                                    + `?serviceDate=${split.serviceDate}`
                                                                    + `&courierUsername=${encodeURIComponent(r.courier.username)}`}
                                                            >
                                                                Excel
                                                            </a>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                {split.urgent.length > 0 && (
                                    <p className="izy-alert warn" role="status">
                                        {split.urgent.length} STAT
                                        {split.urgent.length === 1 ? ' delivery is' : ' deliveries are'} not in
                                        these rounds. Give {split.urgent.length === 1 ? 'it its' : 'them their'} own
                                        short run from the board.
                                    </p>
                                )}

                                <div className="izy-cluster-do">
                                    {assigned ? (
                                        <>
                                            <span className="izy-pill">Assigned</span>
                                            <span className="izy-muted">
                                                Each driver has their round on their phone. The spreadsheets above
                                                are the same work, if somebody wants it on paper.
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                className="izy-btn"
                                                disabled={busy !== '' || split.rounds.every((r) => r.courier === null)}
                                                onClick={() => { void assign(); }}
                                            >
                                                {busy === 'assign' ? 'Assigning…' : 'Assign these rounds'}
                                            </button>
                                            <span className="izy-muted">
                                                This creates a run for each driver and puts the stops on it.
                                            </span>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
