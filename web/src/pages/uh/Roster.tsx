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
 * GROUPED BY PHARMACY, LISTED IN ROWS.
 *
 * The question this page answers first is "is every counter covered", so
 * the groups stay: a heading per pharmacy, and one that says nobody drives
 * from here when that is the answer.
 *
 * The groups were laid out as narrow cards side by side, which read well
 * while a row was a name and a picker. It stopped reading at all on
 * 3 November, when the row gained the two things somebody opens this page
 * at four in the afternoon for -- an address and a telephone number. Three
 * facts across 300px is a stack of wrapped grey text, and forty-three of
 * those is a page you cannot find a name in. So the groups are full width
 * now and each driver is one row across it.
 *
 * UNASSIGNED COMES FIRST. It is the only group that represents work to do;
 * an empty one means the page is finished with.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ADDRESS AND THE TELEPHONE NUMBER ARE ON THE ROW.
 *
 * This screen used to say only WHETHER somebody had an email address, and
 * lib/people.ts explains why: printing a personal address under every name
 * put twenty-three of them on a screen a room can see, and told a
 * dispatcher nothing they did not know from the line above.
 *
 * That reasoning holds for the dispatch board and it does not hold here.
 * This page is the staff list -- it is already gated to admins and site
 * managers, it already names every driver on the contract and where each
 * one is based, and the thing it is open for at four in the afternoon is
 * reaching somebody. "Has an email address" cannot be acted on; the
 * address can. Both are links, so the row is one tap from a call.
 *
 * A NUMBER HAD TO BE TYPED SOMEWHERE FIRST. There was no telephone number
 * for any driver anywhere in the system, so displaying the field would
 * have shown forty-three blanks for ever. It is editable in place, for the
 * same reason the pharmacy is: the moment to record forty-three numbers is
 * while looking at the list of forty-three drivers.
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
import { Pager, usePaged } from '../../app/Pager';
import { Section } from '../../app/Section';

interface RosterDriver {
    username: string;
    name: string;
    email: string;
    /** Free text as a dispatcher typed it, or '' for nothing recorded. */
    phone: string;
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

    /* Same shape as setHome, and deliberately a second function rather than
       one with a flag: they are two routes, two audit entries and two
       sentences on screen, and the only thing they share is the spinner. */
    const setPhone = async (driver: RosterDriver, phone: string) => {
        setSaving(driver.username);
        setMsg(null);
        try {
            await api(`${base}/${encodeURIComponent(driver.username)}/contact`, { method: 'PUT', json: { phone } });
            setMsg({
                kind: 'ok',
                text: phone === ''
                    ? `${driver.name} has no phone number on file`
                    : `${driver.name} → ${phone}`,
            });
            await load();
        } catch (err) {
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
    const noPhone = data.drivers.filter((d) => d.phone === '').length;

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
                    {/* The same sentence for the other gap this page can now
                        close. Counted here rather than on the server: it is
                        a count of rows already on screen, and a second field
                        in the response is a second thing that can disagree
                        with the list under it. */}
                    {data.drivers.length > 0 && <>
                        {' · '}
                        {noPhone === 0
                            ? 'every one has a phone number'
                            : <span className="izy-stat-warn"><b>{noPhone}</b> with no phone number</span>}
                    </>}
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
                    <Group
                        key={g.key}
                        id={`uh.roster.${g.key}`}
                        group={g}
                        code={code}
                        sites={data.sites}
                        saving={saving}
                        onSet={(d, v) => { void setHome(d, v); }}
                        onPhone={(d, v) => { void setPhone(d, v); }}
                    />
                ))}
            </div>
        </>
    );
}


/* ONE PHARMACY'S DRIVERS.
 *
 * Its own component for a dull and binding reason: the list is paged, paging
 * is a hook, and a hook cannot be called inside the `groups.map` that renders
 * nine of these. Lifting it here gives each group its own page state, which
 * is what you want anyway -- turning to page two at Robert B. Green should
 * not move Southeast.
 *
 * FOLDABLE, AND OPEN BY DEFAULT. Nine counters down a phone screen is a long
 * scroll, and the person reading this usually came for one of them. Section
 * remembers the choice per group, so a dispatcher who only ever looks at
 * their own three can fold the rest once and have it stay that way. Open by
 * default because the thing this page is read to find -- a counter with
 * nobody on it -- has to be visible without opening anything.
 */
function Group({ id, group, code, sites, saving, onSet, onPhone }: {
    id: string;
    group: { key: string; title: string; drivers: RosterDriver[]; site: RosterSite | null };
    code: string;
    sites: RosterSite[];
    saving: string | null;
    onSet: (d: RosterDriver, value: string) => void;
    onPhone: (d: RosterDriver, value: string) => void;
}) {
    const paged = usePaged(group.drivers, 8);

    return (
        <Section
            id={id}
            className="izy-roster-group"
            title={group.title}
            summary={`${group.drivers.length} ${group.drivers.length === 1 ? 'driver' : 'drivers'}`}
        >
            {group.site !== null && group.drivers.length === 0 && (
                /* An empty counter is the thing this page is read to find.
                   Said in words, not left as a zero. */
                <p className="izy-muted izy-stat-warn">Nobody drives from here.</p>
            )}
            {paged.rows.map((d) => (
                <div className="izy-roster-row" key={d.username}>
                    <div>
                        <Link to={`/projects/${code}/drivers/${encodeURIComponent(d.username)}`}>{d.name}</Link>
                        {/* The space belongs OUTSIDE the pill. Inside, the
                            browser collapses it against the pill's own
                            padding and the name runs into the badge:
                            "Rosalind Achebeon shift". */}
                        {d.onShift && <> <span className="izy-pill">on shift</span></>}
                        {notes(d).length > 0 && <>
                            <br />
                            {/* Whatever this row needs saying about the
                                ACCOUNT -- a handle that is not a name, a
                                site manager, somebody switched off. The
                                address and the number moved out of here
                                into their own column, so this line is
                                usually absent now and the row is one line
                                tall, which is the point of a list. */}
                            <span className="izy-muted">{notes(d).join(' · ')}</span>
                        </>}
                    </div>
                    <Contact driver={d} saving={saving === d.username} onPhone={onPhone} />
                    <select
                        aria-label={`Home pharmacy for ${d.name}`}
                        value={d.homeSiteId === null ? UNASSIGNED : String(d.homeSiteId)}
                        disabled={saving === d.username}
                        onChange={(e) => onSet(d, e.target.value)}
                    >
                        <option value={UNASSIGNED}>No home pharmacy</option>
                        {sites.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </div>
            ))}
            <Pager of={paged} noun="drivers" />
        </Section>
    );
}

/** The grey line under a name: what is true of the account, or nothing. */
function notes(d: RosterDriver): string[] {
    const handle = handleUnder(d);
    return [
        /* LABELLED, which it was not before the address moved out of this
           line. UH drivers sign in with their first name, so the handle
           reads as a shorter copy of the name above it -- a full name with
           its own first name under it -- and on its own that looks like a
           mistake rather than a fact. Saying what it
           is makes it the one thing on the row an administrator quotes down
           the phone. Shown only when it says something the name does not:
           see lib/people.ts. */
        handle === null ? null : `signs in as ${handle}`,
        d.role === 'lead' ? 'site manager' : null,
        d.status !== 'active' ? 'disabled' : null,
    ].filter((x): x is string => x !== null);
}


/* HOW TO REACH ONE DRIVER.
 *
 * THE ADDRESS IS READ-ONLY HERE AND THE NUMBER IS NOT, which looks
 * inconsistent and is not. An address is a credential: it is what a
 * password reset is sent to, so changing it changes who can take the
 * account over, and that stays on the account page behind the platform
 * admin role. A telephone number is a note about a person -- nothing signs
 * in with it and nothing is sent to it -- so the site manager who knows it
 * can write it down where they are standing.
 *
 * A MISSING ADDRESS IS STILL CALLED OUT, because a driver with none cannot
 * reset their own password, and this is the list in front of the person who
 * can fix that.
 *
 * THE INPUT APPEARS ON ASK. Forty-three text boxes down a page is
 * forty-three things to tab through and one stray keystroke away from
 * changing the wrong driver's number. A link until somebody says otherwise.
 */
function Contact({ driver, saving, onPhone }: {
    driver: RosterDriver;
    saving: boolean;
    onPhone: (d: RosterDriver, value: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(driver.phone);

    const open = () => { setDraft(driver.phone); setEditing(true); };
    const save = () => { setEditing(false); onPhone(driver, draft.trim()); };

    return (
        <div className="izy-roster-contact">
            <span>
                {driver.email === ''
                    ? <span className="izy-stat-warn">no email address</span>
                    : <a href={`mailto:${driver.email}`}>{driver.email}</a>}
            </span>
            {editing
                ? (
                    <span className="izy-roster-phone-edit">
                        <input
                            type="tel"
                            aria-label={`Phone number for ${driver.name}`}
                            value={draft}
                            disabled={saving}
                            onChange={(e) => setDraft(e.target.value)}
                            /* Enter saves and Escape abandons. Reaching for
                               a mouse to commit one field is what makes
                               typing forty-three of them a chore. */
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); save(); }
                                if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
                            }}
                        />
                        <button type="button" className="izy-btn small" disabled={saving} onClick={save}>Save</button>
                        <button
                            type="button"
                            className="izy-btn secondary small"
                            disabled={saving}
                            onClick={() => setEditing(false)}
                        >
                            Cancel
                        </button>
                    </span>
                )
                : (
                    <span className="izy-roster-phone-edit">
                        {driver.phone === ''
                            ? <span className="izy-stat-warn">no phone number</span>
                            /* tel:, so a dispatcher holding a phone taps
                               once. Punctuation stripped for the link and
                               kept on screen: the handset wants digits and
                               the reader wants it readable. */
                            : <a href={`tel:${driver.phone.replace(/[^+\d]/g, '')}`}>{driver.phone}</a>}
                        {/* The visible word is short because it sits in a
                            column forty-three times; the label is the whole
                            sentence, because out of its row "Change" names
                            nothing. */}
                        <button
                            type="button"
                            className="izy-btn secondary small"
                            aria-label={driver.phone === ''
                                ? `Add a phone number for ${driver.name}`
                                : `Change the phone number for ${driver.name}`}
                            disabled={saving}
                            onClick={open}
                        >
                            {driver.phone === '' ? 'Add' : 'Change'}
                        </button>
                    </span>
                )}
        </div>
    );
}
