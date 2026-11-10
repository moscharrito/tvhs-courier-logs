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
import { generatePassword } from '../../lib/password';

interface RosterDriver {
    username: string;
    name: string;
    email: string;
    /** Free text as a dispatcher typed it, or '' for nothing recorded. */
    phone: string;
    status: string;
    role: string;
    homeSiteId: number | null;
    /* THE COUNTERS THIS DRIVER MAY ALSO BE GIVEN WORK AT.
     *
     * The server has returned this since the field was added and the board
     * has always honoured it -- targetsFor() offers a stop to anybody whose
     * homeSiteId OR alsoCovers matches the site. This screen simply never
     * read it, so the only way to set it was by hand against the API, and
     * in practice nobody did. Hence "a driver can only work one pharmacy",
     * which was never true of the system, only of its roster page. */
    /* OPTIONAL, defensively. The server always sends it, but a row that
       arrives without it would otherwise throw on .includes() and take the
       whole roster down -- the same shape of bug as reading `siteId !==
       null` off a response that had no siteId. An absent list means
       "covers nowhere else", which is the safe reading. */
    alsoCovers?: number[];
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
    const { user, projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const base = `/api/projects/${code}/uh/roster`;

    /* PLATFORM ADMIN, NOT PROJECT ADMIN, and the distinction is the whole
       reason this is a separate check. The roster endpoints take any
       dispatcher, but creating an account, resetting a password and
       removing a membership all go to /api/users, which is guarded by
       requireAdmin on the SESSION role. Gating these controls on the
       project role would show a site manager buttons that 403. */
    const isAdmin = user?.role === 'admin';

    /* ON SHIFT AND OFF SHIFT IS A DIFFERENT TEST, AND IT IS THE PROJECT ROLE.
     *
     * The three controls above it go to /api/users and are guarded by
     * requireAdmin on the SESSION role. The shift switch goes to the UH
     * shifts module and is guarded by requireProjectRole('admin', 'lead'),
     * which is a different question about a different person: `lead` is the
     * dispatch role on this contract -- one person, all eight counters, the
     * one actually at the board at noon -- and they are who asked for it.
     *
     * So it is read off THIS project's membership rather than off the
     * platform role, which is the only reading that matches what the server
     * will do. Gating it on `isAdmin` would hide it from exactly the person
     * it is for; gating it on nothing would show a site manager a button
     * that 403s. */
    const canSetShift = project?.role === 'admin' || project?.role === 'lead';

    /* Shown once, never stored, never logged. The server has only the hash
       and this component is the one place the plaintext ever exists. */
    const [issued, setIssued] = useState<{ name: string; username: string; password: string } | null>(null);

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

    /* ONE PLACE THAT TALKS TO /api/users, so the three admin actions share
       their error handling and their reload. Each returns true when it
       worked, because the callers differ in what they do next. */
    const asAdmin = async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
        setMsg(null);
        try {
            await run();
            await load();
            return true;
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : `Could not ${what}` });
            return false;
        }
    };

    /* WHICH OTHER COUNTERS THIS DRIVER COVERS.
     *
     * homeSiteId goes with it because the endpoint takes both together and
     * validates alsoCovers against it -- it drops the home site from the
     * list rather than letting a driver "also cover" where they already
     * are. Sending covers alone would read homeSiteId as absent. */
    const setCovers = async (driver: RosterDriver, siteId: number, on: boolean) => {
        const next = on
            ? [...new Set([...(driver.alsoCovers ?? []), siteId])]
            : (driver.alsoCovers ?? []).filter((id) => id !== siteId);
        setSaving(driver.username);
        const ok = await asAdmin(`change what ${driver.name} covers`, () => api(
            `${base}/${encodeURIComponent(driver.username)}`,
            { method: 'PUT', json: { homeSiteId: driver.homeSiteId, alsoCovers: next } },
        ));
        if (ok) {
            const site = data?.sites.find((x) => x.id === siteId)?.name ?? 'that pharmacy';
            setMsg({ kind: 'ok', text: on ? `${driver.name} also covers ${site}` : `${driver.name} no longer covers ${site}` });
        }
        setSaving(null);
    };

    /* A NEW DRIVER IS TWO WRITES AND BOTH ARE REQUIRED.
     *
     * The account makes them somebody who can sign in; the courier
     * membership is what gives them work. An account without the
     * membership signs in successfully to an empty run, which looks
     * exactly like a quiet day -- the failure create-drivers.mjs exists to
     * stop somebody debugging for an afternoon. If the membership write
     * fails the account is left behind deliberately and named, because
     * deleting a half-made account is how you delete the wrong one. */
    const addDriver = async (form: { username: string; name: string; email: string; homeSiteId: string }) => {
        const username = form.username.trim().toLowerCase();
        const password = generatePassword();
        setSaving(username);
        const ok = await asAdmin(`create ${username}`, async () => {
            await api('/api/users', {
                method: 'POST',
                json: { username, name: form.name.trim(), email: form.email.trim(), password, role: 'driver' },
            });
            await api(`/api/users/${encodeURIComponent(username)}/memberships/${code}`, {
                method: 'PUT',
                json: {
                    role: 'courier',
                    settings: form.homeSiteId === UNASSIGNED ? {} : { homeSiteId: Number(form.homeSiteId) },
                },
            });
        });
        if (ok) setIssued({ name: form.name.trim(), username, password });
        setSaving(null);
        return ok;
    };

    /* EVERY SESSION OF THEIRS ENDS -- the endpoint revokes them, and it is
       right to: the usual reason to reset is that nobody is sure who knows
       the old one. The practical cost is that a driver mid-round is signed
       out of their phone, so the confirmation says so. */
    const resetPassword = async (driver: RosterDriver) => {
        const password = generatePassword();
        setSaving(driver.username);
        const ok = await asAdmin(`reset the password for ${driver.name}`, () => api(
            `/api/users/${encodeURIComponent(driver.username)}/password`,
            { method: 'POST', json: { password } },
        ));
        if (ok) setIssued({ name: driver.name, username: driver.username, password });
        setSaving(null);
    };

    /* REMOVE FROM THE CONTRACT, NOT FROM THE SYSTEM.
     *
     * This deletes the MEMBERSHIP. The account survives, and so does every
     * custody event naming them: deleting a signatory is the one outcome
     * the append-only trigger on custody_events exists to prevent, and a
     * chain of custody that names somebody no longer in the system is
     * worse than one naming a driver who left. They stop being offered
     * work here and keep their history, which is what "off the roster"
     * means. Reversible by putting the membership back. */
    const removeFromRoster = async (driver: RosterDriver) => {
        setSaving(driver.username);
        const ok = await asAdmin(`take ${driver.name} off the roster`, () => api(
            `/api/users/${encodeURIComponent(driver.username)}/memberships/${code}`,
            { method: 'DELETE' },
        ));
        if (ok) setMsg({ kind: 'ok', text: `${driver.name} is off the roster. Their account and their history remain.` });
        setSaving(null);
    };

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

    /* ── ON SHIFT AND OFF SHIFT, FROM HERE ─────────────────────────────────
     *
     * WHY THIS BUTTON EXISTS. Being on shift is what decides who may be
     * handed a delivery -- the board draws the available drivers from it and
     * the unclaimed-work sweep reads it. Until now the only account that
     * could open one was the driver's own, on their own phone. A flat
     * battery, a driver who forgot before pulling out of the counter, an
     * afternoon of backlog being worked through from a desk: in all three
     * the office knows perfectly well the person is out there, and could not
     * say so. Dispatch could already end a shift and not start one, which is
     * an asymmetry nobody chose.
     *
     * IT IS NOT A TIMECLOCK. It says "this person is available for work
     * now", which is the only thing anything downstream reads it as.
     *
     * The shift carries the name of whoever pressed it, so hours opened from
     * a desk can be told apart from hours a driver opened at a counter. See
     * `started_by` in modules/uh/shifts.ts.
     *
     * THE REASON IS ASKED FOR ON THE WAY OFF AND NOT ON THE WAY ON, which is
     * the server's rule and not this screen's invention: ending somebody
     * else's day is a decision about a person and the question "why" has one
     * answer on the record or no answer at all. Starting one needs no excuse.
     */
    const setShift = async (driver: RosterDriver, on: boolean, reason = '') => {
        setSaving(driver.username);
        setMsg(null);
        try {
            const res = await api<{ carrying?: number; alreadyOn?: boolean }>(
                `/api/projects/${code}/uh/shifts/for/${encodeURIComponent(driver.username)}/${on ? 'start' : 'end'}`,
                { method: 'POST', json: on ? {} : { reason } },
            );
            setMsg({
                kind: 'ok',
                text: on
                    ? (res.alreadyOn === true
                        ? `${driver.name} was already on shift`
                        : `${driver.name} is on shift and can be given work`)
                    /* WHAT WAS STILL OUT, SAID OUT LOUD. The server allows a
                       shift to end over a loaded van -- a courier at a
                       pharmacy that has shut cannot hand anything back -- and
                       the person who just ended it is the person who should
                       hear about the packages. */
                    : `${driver.name} is off shift`
                        + ((res.carrying ?? 0) > 0
                            ? ` · ${res.carrying} ${res.carrying === 1 ? 'delivery is' : 'deliveries are'} still recorded as with them`
                            : ''),
            });
            await load();
        } catch (err) {
            setMsg({
                kind: 'error',
                text: err instanceof ApiError ? err.message : `Could not change the shift for ${driver.name}`,
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

            {/* ── THE CREDENTIAL, ONCE ──────────────────────────────────────
                The server stores only a hash, so this is the single moment
                the plaintext exists anywhere. It is deliberately loud, it
                does not disappear on the next render, and it has to be
                dismissed by hand: a panel that vanished while somebody was
                reaching for a pen would send them straight back here to
                reset a password they had just set. */}
            {issued !== null && (
                <div className="izy-alert warn izy-issued" role="alert">
                    <p>
                        <b>{issued.name}</b> signs in as <code>{issued.username}</code> with{' '}
                        <code className="izy-secret">{issued.password}</code>
                    </p>
                    <p className="izy-muted">
                        Shown once and stored nowhere. Read it to them, ask them to change it, and
                        close this. If it is lost, use <b>New password</b> on their row.
                    </p>
                    <button type="button" className="izy-btn secondary small" onClick={() => setIssued(null)}>
                        I have passed it on
                    </button>
                </div>
            )}

            {isAdmin && (
                <Section
                    id="uh.roster.add"
                    title="Add a driver"
                    summary="account, courier membership and a password"
                    defaultOpen={false}
                >
                    <AddDriver sites={data.sites} busy={saving !== null} onAdd={addDriver} />
                </Section>
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
                        isAdmin={isAdmin}
                        canSetShift={canSetShift}
                        onSet={(d, v) => { void setHome(d, v); }}
                        onPhone={(d, v) => { void setPhone(d, v); }}
                        onCover={(d, siteId, on) => { void setCovers(d, siteId, on); }}
                        onShiftChange={(d, on) => {
                            if (on) { void setShift(d, true); return; }
                            /* PRE-FILLED AND STILL EDITABLE. A free box that
                               has to be typed forty-three times gets "x"
                               typed into it, which is a reason in the same
                               way an empty field is. A default that says
                               what happened, which somebody can replace with
                               what actually happened, keeps the record
                               worth reading. */
                            const reason = window.prompt(
                                `Take ${d.name} off shift?\n\n`
                                + 'They stop being offered work straight away. Say why: it goes on the '
                                + 'shift record under your name, and it is what anybody reading their '
                                + 'hours later will see.',
                                'Taken off shift by dispatch',
                            );
                            if (reason === null) return;
                            if (reason.trim().length < 5) {
                                setMsg({ kind: 'error', text: 'Say why in a few words. Nothing was changed.' });
                                return;
                            }
                            void setShift(d, false, reason.trim());
                        }}
                        onReset={(d) => {
                            /* Confirmed because it signs them out. A driver
                               mid-round loses the app until somebody reads
                               them the new password. */
                            if (window.confirm(
                                `Give ${d.name} a new password?\n\n`
                                + 'They are signed out of the app everywhere immediately, '
                                + 'including mid-round, and cannot work again until you have '
                                + 'read them the new one.',
                            )) void resetPassword(d);
                        }}
                        onRemove={(d) => {
                            if (window.confirm(
                                `Take ${d.name} off the ${project.name} roster?\n\n`
                                + 'They stop being offered work here. Their account, their past '
                                + 'deliveries and their signatures all stay exactly as they are, '
                                + 'and you can put them back by giving them a home pharmacy again.',
                            )) void removeFromRoster(d);
                        }}
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
function Group({ id, group, code, sites, saving, isAdmin, canSetShift, onSet, onPhone, onCover, onShiftChange, onReset, onRemove }: {
    id: string;
    group: { key: string; title: string; drivers: RosterDriver[]; site: RosterSite | null };
    code: string;
    sites: RosterSite[];
    saving: string | null;
    isAdmin: boolean;
    /** Dispatch, read off the project membership. See the note on the
     *  constant in Roster, and the one over the button it draws. */
    canSetShift: boolean;
    onSet: (d: RosterDriver, value: string) => void;
    onPhone: (d: RosterDriver, value: string) => void;
    onCover: (d: RosterDriver, siteId: number, on: boolean) => void;
    onShiftChange: (d: RosterDriver, on: boolean) => void;
    onReset: (d: RosterDriver) => void;
    onRemove: (d: RosterDriver) => void;
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
                    {/* ── ALSO COVERS, ACROSS THE FULL ROW ────────────────
                        One driver, several counters. The board has always
                        supported it; this is the first screen that says so.

                        A CHECKBOX EACH rather than a multi-select: a
                        <select multiple> needs ctrl-click to add a second
                        value and silently drops the rest when somebody
                        clicks without it, which on this page would quietly
                        un-cover four pharmacies. The home one is left out
                        because the server drops it from the list anyway --
                        covering where you already are is not a thing.

                        Saved on each tick rather than behind a button: a
                        change nobody confirmed is a change nobody can
                        forget to confirm. */}
                    <div className="izy-roster-covers">
                        <span className="izy-muted">Also covers</span>
                        {sites.filter((s) => s.id !== d.homeSiteId).map((s) => (
                            <label key={s.id} className="izy-cover-pick">
                                <input
                                    type="checkbox"
                                    checked={(d.alsoCovers ?? []).includes(s.id)}
                                    disabled={saving === d.username}
                                    onChange={(e) => onCover(d, s.id, e.target.checked)}
                                />
                                {s.name}
                            </label>
                        ))}
                        {sites.length <= 1 && <span className="izy-muted">nowhere else to cover</span>}
                    </div>
                    {/* TWO AUDIENCES IN ONE ROW OF BUTTONS, which is why the
                        tests are on each button and not on the row.

                        The shift switch is dispatch's: it goes to the UH
                        shifts module, which admits a project `lead`, and the
                        lead is the person at the board at noon. The other
                        two go to /api/users behind the platform admin role.
                        A site manager therefore sees one button here and not
                        three, which is exactly what the server will let them
                        do. */}
                    {(canSetShift || isAdmin) && (
                        <div className="izy-roster-admin">
                            {/* FIRST, because it is the one that gets pressed
                                daily and the other two are rare and heavy.

                                IT SAYS WHAT IT WILL DO, not what is true: the
                                state is already on the row as a pill, and a
                                button labelled with the current state is the
                                oldest way to make somebody click the opposite
                                of what they meant. */}
                            {canSetShift && (
                            <button
                                type="button"
                                className="izy-btn secondary small"
                                disabled={saving === d.username}
                                onClick={() => onShiftChange(d, !d.onShift)}
                            >
                                {d.onShift ? 'Take off shift' : 'Put on shift'}
                            </button>
                            )}
                            {isAdmin && (<>
                            <button
                                type="button"
                                className="izy-btn secondary small"
                                disabled={saving === d.username}
                                onClick={() => onReset(d)}
                            >
                                New password
                            </button>
                            <button
                                type="button"
                                className="izy-btn secondary small izy-danger"
                                disabled={saving === d.username}
                                onClick={() => onRemove(d)}
                            >
                                Off the roster
                            </button>
                            </>)}
                        </div>
                    )}
                </div>
            ))}
            <Pager of={paged} noun="drivers" />
        </Section>
    );
}

/* ── MAKING A DRIVER ───────────────────────────────────────────────────
 *
 * The same two writes create-drivers.mjs does, from a screen: the account,
 * then the courier membership that actually gives them work.
 *
 * THE EMAIL IS REQUIRED HERE AS WELL, and for the reason the script spells
 * out at length. Password reset finds an account by address, and answers
 * "if that address belongs to an account, a code is on its way" either
 * way -- so a driver onboarded without one is handed an instruction that
 * cannot work, tries it, and waits for ever. Nothing reports it. The eight
 * pharmacy portal logins were created without addresses and nobody found
 * out until somebody tried.
 *
 * THE USERNAME IS NOT GUESSED FROM THE NAME. Two drivers called Xavier is
 * not a hypothetical here; it happened, and the first one took `xavier`
 * while the second could not be created at all. A field with a sentence
 * under it is better than a rule that silently collides, especially as
 * there is no renaming afterwards: six tables carry the username as text.
 */
function AddDriver({ sites, busy, onAdd }: {
    sites: RosterSite[];
    busy: boolean;
    onAdd: (form: { username: string; name: string; email: string; homeSiteId: string }) => Promise<boolean>;
}) {
    const [form, setForm] = useState({ username: '', name: '', email: '', homeSiteId: UNASSIGNED });
    const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
        setForm((f) => ({ ...f, [k]: e.target.value }));

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                void onAdd(form).then((ok) => {
                    /* Cleared only on success, so a rejected username does
                       not take the other three fields with it. */
                    if (ok) setForm({ username: '', name: '', email: '', homeSiteId: UNASSIGNED });
                });
            }}
        >
            <div className="izy-row">
                <label className="izy-field">Full name
                    <input value={form.name} onChange={set('name')} required maxLength={120} />
                </label>
                <label className="izy-field">Username
                    <input
                        value={form.username}
                        onChange={set('username')}
                        required
                        minLength={2}
                        maxLength={120}
                        pattern="[A-Za-z0-9._@+\-]+"
                        title="Letters, digits, and . _ @ + - only"
                    />
                    <span className="izy-muted izy-field-note">
                        What they type to sign in. Lower case, and it cannot be changed later.
                    </span>
                </label>
                <label className="izy-field">Email
                    <input type="email" value={form.email} onChange={set('email')} required maxLength={200} />
                    <span className="izy-muted izy-field-note">
                        Required: it is the only route to &ldquo;Forgotten your password&rdquo;.
                    </span>
                </label>
                <label className="izy-field">Home pharmacy
                    <select value={form.homeSiteId} onChange={set('homeSiteId')}>
                        <option value={UNASSIGNED}>No home pharmacy</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </label>
                <button className="izy-btn" type="submit" disabled={busy}>Create the driver</button>
            </div>
        </form>
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
