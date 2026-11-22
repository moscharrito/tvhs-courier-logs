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
 * IT OPENS WHERE DOWNLOAD USED TO BE, on every imported row.
 *
 * Clustering needs ORDERS, and a list handed over is a file until somebody
 * imports it -- so the first cut put this on the import outcome, the one
 * moment when the pharmacy, the service date and the orders are all known.
 * That control lasted about thirty seconds: reload, or come back to a list
 * imported an hour ago, and there was no way in. It now sits on each row
 * of Recent imports, in place of the Download link rather than beside it,
 * because Download was the first move in the routine this replaces.
 *
 * It is NOT the "plan the wave" panel that was built on the board twice and
 * removed twice. That one proposed runs for nine counters at once and had
 * its own courier picker. This is one counter's list, the drivers mapped to
 * that counter who are on shift, and the same POST the dispatcher's own
 * click makes.
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
import { DownloadIcon } from '../../app/Icons';

interface Driver {
    username: string;
    name: string;
    homeSiteId: number | null;
    onShift: boolean;
}

interface Round {
    orderIds: number[];
    stops: number;
    /** 'nearest' = driving order from the pharmacy. 'due' = by deadline. */
    ordering?: 'nearest' | 'due';
    /** Straight-line miles for the whole round. Null in deadline order. */
    driveMiles?: number | null;
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
    /** Set when the drivers listed are mapped to no counter at all. */
    const [unmapped, setUnmapped] = useState(false);
    /** This counter's own drivers who have not started a shift. */
    const [resting, setResting] = useState(0);
    const [ticked, setTicked] = useState<string[]>([]);
    const [split, setSplit] = useState<Split | null>(null);
    const [busy, setBusy] = useState<'' | 'drivers' | 'cluster' | 'assign'>('drivers');
    const [err, setErr] = useState('');
    const [assigned, setAssigned] = useState(false);
    /* THE RUN IDS, BECAUSE A DRIVER'S SHEET IS A RUN'S SHEET.
       Keyed by driver, because that is what the row on screen knows.
       Before this the Excel link went to the runs REGISTER filtered to
       one courier and one day, which is a file of run metadata with a
       COUNT of stops in it -- the right filter on the wrong file, so it
       downloaded cleanly and told the dispatcher nothing. */
    const [runOf, setRunOf] = useState<Record<string, number>>({});

    /* WHO IS STANDING HERE, which is a shorter question than it was.
       The server answers with the drivers mapped to this counter who are
       on shift, and nobody else -- not the thirty-five names on the
       contract, not the people mapped elsewhere, not the ones who have
       not tapped Go on shift. The roster read is the planner's, so
       "whose pharmacy is this" is answered in one place rather than
       two. */
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
                const got = await api<{ drivers: Driver[]; unmapped?: boolean; restingHere?: number }>(
                    `/api/projects/${projectCode}/uh/runs/split`
                    + `?site=${encodeURIComponent(site.code)}&serviceDate=${serviceDate}`,
                );
                if (gone) return;
                const list = got.drivers ?? [];
                setDrivers(list);
                setUnmapped(got.unmapped === true);
                setResting(got.restingHere ?? 0);
                /* ALL OF THEM, TICKED. Everybody on this list is mapped
                   here and on shift, so the default answer is everybody
                   and the dispatcher unticks the exceptions. Untick is a
                   smaller job than tick when the usual day is "all of
                   them". */
                setTicked(list.map((d) => d.username));
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
            const out = await api<{
                runs: Array<{ id: number; courierUsername: string }>;
                rejected: unknown[];
            }>(
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
            setRunOf(Object.fromEntries(out.runs.map((r) => [r.courierUsername, r.id])));
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

    const here = drivers ?? [];

    return (
        <div className="izy-modal-back" role="presentation" onMouseDown={onClose}>
            <div
                className="izy-modal izy-cluster"
                role="dialog"
                aria-modal="true"
                aria-label={`Cluster the ${site.name} list`}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="izy-cluster-head">
                    <div>
                        <h2>Cluster this list between drivers</h2>
                        <p className="izy-muted">{site.name} · {serviceDate}</p>
                    </div>
                    <button type="button" className="izy-btn secondary small" onClick={onClose}>Close</button>
                </div>

                {err !== '' && <div className="izy-alert error" role="alert">{err}</div>}

                {busy === 'drivers' && <Loading label="Reading the driver list" />}

                {drivers !== null && (
                    <>
                        <div className="izy-cluster-who">
                            <h3>On shift at {site.name}</h3>
                            {/* NOBODY, AND WHY NOBODY. An empty box with no
                                sentence under it reads as a broken screen.
                                These two cases have different answers --
                                one is "wait for somebody to start their
                                shift", the other is "go and set the home
                                pharmacies" -- and a dispatcher who cannot
                                tell them apart will ring us about it. */}
                            {here.length === 0 && (
                                <p className="izy-alert warn" role="status">
                                    {resting > 0
                                        ? `Nobody mapped to ${site.name} has started a shift yet. `
                                          + `${resting} ${resting === 1 ? 'driver is' : 'drivers are'} `
                                          + 'mapped here and resting. Assign it from the board instead.'
                                        : `No driver is mapped to ${site.name} and on shift. `
                                          + 'Assign it from the board instead.'}
                                </p>
                            )}
                            {/* SHOWING SOMETHING ELSE, AND SAYING SO. A
                                contract whose drivers have no home
                                pharmacy yet would otherwise get an empty
                                dialog every morning. */}
                            {unmapped && here.length > 0 && (
                                <p className="izy-alert warn" role="status">
                                    None of these drivers has a home pharmacy set, so this is everyone
                                    on shift who is not based at another counter. Set their pharmacies
                                    and this list gets shorter.
                                </p>
                            )}
                            <ul className="izy-cluster-drivers">
                                {here.map((d) => (
                                    <li key={d.username}>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={ticked.includes(d.username)}
                                                onChange={() => flip(d.username)}
                                            />
                                            <span>{d.name}</span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                            {/* The ones who are here but resting, as a count
                                and not as thirty tick boxes. It answers
                                "where is everybody" without reopening the
                                box this change was made to close. */}
                            {here.length > 0 && !unmapped && resting > 0 && (
                                <p className="izy-muted izy-cluster-note">
                                    {resting} more {resting === 1 ? 'driver is' : 'drivers are'} mapped
                                    to {site.name} but not on shift.
                                </p>
                            )}
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
                                Grouped by ZIP so each driver stays in one part of the city, then each
                                round is put in driving order — nearest stop first from the counter.
                                Nothing is assigned until you press Assign.
                            </p>
                        </div>

                        {split !== null && (
                            <div className="izy-cluster-out">
                                <h3>{split.rounds.length} {split.rounds.length === 1 ? 'round' : 'rounds'}</h3>

                                {/* ── THE NOTES ARE NOT DRAWN, AND THAT IS THE POINT
                                    (21 November)

                                    The server sends five or six sentences with
                                    every split and they used to stack above the
                                    table as yellow banners. Read them against the
                                    table underneath and every one is a sentence
                                    restating a column:

                                      "Rounds run from 8 to 19 stops"   -> Stops
                                      "1 round is wider than 10 miles"  -> Width,
                                                                   and its Wide pill
                                      "1 run is offered to a driver
                                       from another pharmacy"          -> the
                                                           Another counter pill
                                      "3 rounds are in deadline order" -> Order
                                      "4 STAT deliveries are not in
                                       this split"                     -> the alert
                                                           below, word for word

                                    Six banners that say what the next six rows
                                    show is not six warnings, it is a wall, and a
                                    wall gets scrolled past -- including on the
                                    morning one of them matters. The table says it
                                    in the row it is about.

                                    `notes` is still on the response. The board's
                                    own planner renders it, and nothing here needs
                                    the server to stop producing it. */}
                                <div className="scroller">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Driver</th><th>Stops</th><th>Order</th><th>ZIPs</th>
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
                                                    {/* WHICH KIND OF ORDER, per round and not once for
                                                        the dialog: one round can be in driving order
                                                        while the one beside it falls back, because a
                                                        single address without coordinates sends its
                                                        whole round back to deadline order. A dispatcher
                                                        reading "driving order" at the top and getting a
                                                        zig-zag on one driver would stop believing it. */}
                                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {r.ordering === 'nearest' ? (
                                                            <>
                                                                Driving
                                                                {typeof r.driveMiles === 'number' && (
                                                                    <span className="izy-muted"> · {r.driveMiles} mi</span>
                                                                )}
                                                            </>
                                                        ) : <span className="izy-muted">By deadline</span>}
                                                    </td>
                                                    <td className="izy-cluster-zips">{r.zips.join(', ')}</td>
                                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                                                        {r.spreadMiles === null
                                                            ? <span className="izy-muted">not known</span>
                                                            : `${r.spreadMiles} mi`}
                                                        {r.stretched && <span className="izy-pill off">Wide</span>}
                                                    </td>
                                                    <td>
                                                        {/* The RUN's manifest -- the stops themselves, in
                                                            the order they are to be driven, named for the
                                                            driver. Only once the run exists, which is why
                                                            this column is empty until Assign. */}
                                                        {assigned && r.courier && runOf[r.courier.username] !== undefined && (
                                                            <a
                                                                className="izy-btn secondary small"
                                                                href={`/api/projects/${projectCode}/uh/runs/`
                                                                    + `${runOf[r.courier.username]}/manifest.xlsx`}
                                                                title={`${r.courier.name}’s stops, in driving order`}
                                                            >
                                                                <DownloadIcon size={15} />
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
