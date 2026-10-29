/* Which pharmacy each driver belongs to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN EXISTS.
 *
 * University Health staffs by location: twenty-three drivers hired against
 * a home pharmacy, driving from it every weekday. Robert B. Green has five,
 * Southeast four, down to one driver covering Vida and Wheatley together.
 *
 * Until that is written down, the dispatch board starts every morning from
 * nothing -- it proposes routes and asks a human to pick a name for each
 * one out of a list of everybody, with nothing on screen saying who drives
 * from where. Recorded here, the planner offers each run to somebody whose
 * own counter it collects from, and the morning becomes a review instead of
 * twenty-three decisions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GROUPED BY PHARMACY, NOT LISTED BY DRIVER.
 *
 * The question this page answers is "is every counter covered", and a flat
 * alphabetical list of twenty-three names cannot answer it: you would have
 * to hold eight running totals in your head while scrolling. Grouped, a
 * short column is visible from across the room, which is the whole point of
 * looking before 1 November rather than after.
 *
 * UNASSIGNED COMES FIRST, for the same reason. It is the only group that
 * represents work to do; an empty one means the page is finished with.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT SAVES ON CHANGE, WITH NO SAVE BUTTON.
 *
 * Twenty-three dropdowns behind one Save is a form somebody half-fills,
 * gets called away from, and loses. Each change is its own small request,
 * and the row says what happened to it. The cost of that is a flicker of
 * network per change, which on a page edited once a quarter is nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { useAuth } from '../../app/auth';
import { handleUnder } from '../../lib/people';

interface RosterDriver {
    username: string;
    name: string;
    email: string;
    status: string;
    role: string;
    homeSiteId: number | null;
    homeSiteCode: string | null;
    homeSiteName: string | null;
    onShift: boolean;
}

interface RosterSite { id: number; code: string; name: string }

interface Roster {
    drivers: RosterDriver[];
    sites: RosterSite[];
    counts: Array<{ siteId: number; drivers: number }>;
    unassigned: number;
}

/** Null is a real value here -- "no home pharmacy" -- so it needs a key. */
const UNASSIGNED = 'none';

export function Roster() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const base = `/api/projects/${code}/uh/roster`;

    const [data, setData] = useState<Roster | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    /* Per row, so one slow request does not grey out the whole page and a
       second change can be made while the first is in flight. */
    const [saving, setSaving] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await api<Roster>(base));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not load the roster' });
            setData({ drivers: [], sites: [], counts: [], unassigned: 0 });
        }
    }, [base]);
    useEffect(() => { void load(); }, [load]);

    const setHome = async (driver: RosterDriver, value: string) => {
        const homeSiteId = value === UNASSIGNED ? null : Number(value);
        setSaving(driver.username);
        setMsg(null);
        try {
            await api(`${base}/${encodeURIComponent(driver.username)}`, { method: 'PUT', json: { homeSiteId } });
            const to = homeSiteId === null
                ? 'no home pharmacy'
                : data?.sites.find((s) => s.id === homeSiteId)?.name ?? 'a pharmacy';
            setMsg({ kind: 'ok', text: `${driver.name} → ${to}` });
            await load();
        } catch (err) {
            /* Named, and the select snaps back on reload rather than showing
               a value the server rejected. */
            setMsg({
                kind: 'error',
                text: err instanceof ApiError ? err.message : `Could not change ${driver.name}`,
            });
            await load();
        } finally {
            setSaving(null);
        }
    };

    if (!project) return <div className="izy-card"><Loading label="Loading the project" /></div>;
    if (data === null) return <div className="izy-card"><Loading label="Loading the roster" /></div>;

    const at = (siteId: number | null) => data.drivers.filter((d) => d.homeSiteId === siteId);
    const unassigned = at(null);

    /* Unassigned first because it is the only column that is work to do.
       Then the counters in the order the server gave them, which is by
       name, so the page reads the same way twice running. */
    const groups: Array<{ key: string; title: string; drivers: RosterDriver[]; site: RosterSite | null }> = [
        ...(unassigned.length > 0
            ? [{ key: UNASSIGNED, title: 'No home pharmacy yet', drivers: unassigned, site: null }]
            : []),
        ...data.sites.map((s) => ({ key: String(s.id), title: s.name, drivers: at(s.id), site: s })),
    ];

    return (
        <>
            <h1>Driver roster</h1>
            <p className="izy-sub">
                <Link to={`/projects/${code}`}>{project.name}</Link> · which pharmacy each driver works from
            </p>

            {msg !== null && (
                <div className={`izy-alert ${msg.kind === 'ok' ? 'ok' : 'error'}`} role="status">{msg.text}</div>
            )}

            <div className="izy-card">
                <p className="izy-muted">
                    {/* What this changes, in one sentence, because a page that
                        only sets a field leaves somebody wondering whether it
                        did anything. */}
                    A driver&apos;s home pharmacy is the one the board offers them runs from first.
                    It is a default and not a restriction: anybody can still be given any run,
                    which is what covering a sick colleague looks like.
                </p>
                <p className="izy-muted">
                    <b>{data.drivers.length}</b> {data.drivers.length === 1 ? 'driver' : 'drivers'} ·{' '}
                    {data.unassigned === 0
                        ? 'every one has a home pharmacy'
                        : <span className="izy-stat-warn"><b>{data.unassigned}</b> with no home pharmacy</span>}
                </p>
            </div>

            {data.drivers.length === 0 && (
                <div className="izy-card">
                    <p className="izy-muted">
                        Nobody on this project is a driver yet. Drivers are created in{' '}
                        <Link to="/users">Users</Link> and need a <b>courier</b> membership on this project.
                    </p>
                </div>
            )}

            <div className="izy-roster">
                {groups.map((g) => (
                    <section className="izy-card izy-roster-group" key={g.key} aria-label={g.title}>
                        <div className="izy-row-between">
                            <h2>{g.title}</h2>
                            <span className={`izy-pill ${g.drivers.length === 0 ? 'muted' : ''}`}>
                                {g.drivers.length}
                            </span>
                        </div>
                        {g.site !== null && g.drivers.length === 0 && (
                            /* An empty counter is the thing this page is read
                               to find. Said in words, not left as a zero. */
                            <p className="izy-muted izy-stat-warn">Nobody drives from here.</p>
                        )}
                        {g.drivers.map((d) => (
                            <div className="izy-roster-row" key={d.username}>
                                <div>
                                    <Link to={`/projects/${code}/drivers/${encodeURIComponent(d.username)}`}>{d.name}</Link>
                                    {/* The space belongs OUTSIDE the pill. Inside, the
                                        browser collapses it against the pill's own
                                        padding and the name runs into the badge:
                                        "Rosalind Achebeon shift". */}
                                    {d.onShift && <> <span className="izy-pill">on shift</span></>}
                                    <br />
                                    <span className="izy-muted">
                                        {/* WHETHER there is an address, not what
                                            it is. A driver with none cannot reset
                                            their own password and this is a list
                                            of drivers in front of the person who
                                            can fix that -- but printing the
                                            address itself put a personal address
                                            under every row. See lib/people.ts. */}
                                        {d.email === ''
                                            ? <span className="izy-stat-warn">no email address</span>
                                            : 'can reset their password'}
                                        {handleUnder(d) !== null && ` · ${handleUnder(d)}`}
                                        {d.role === 'lead' && ' · site manager'}
                                        {d.status !== 'active' && ' · disabled'}
                                    </span>
                                </div>
                                <select
                                    aria-label={`Home pharmacy for ${d.name}`}
                                    value={d.homeSiteId === null ? UNASSIGNED : String(d.homeSiteId)}
                                    disabled={saving === d.username}
                                    onChange={(e) => { void setHome(d, e.target.value); }}
                                >
                                    <option value={UNASSIGNED}>No home pharmacy</option>
                                    {data.sites.map((s) => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </section>
                ))}
            </div>
        </>
    );
}
