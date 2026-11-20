/* Choosing what you hear about.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SWITCHES ARE DRAWN FROM THE SERVER, NOT LISTED HERE.
 *
 * GET /notifications/prefs returns the kinds this ACCOUNT'S ROLE can
 * actually be sent, each with its label, a line saying what it is, roughly
 * how often it happens, and whether it is on unless you say otherwise. All
 * of that lives in core/notify/prefs.ts beside the fan-out that obeys it.
 *
 * Two things follow, and both are the reason it is done this way:
 *
 *   A LABEL HERE THAT DISAGREED WITH THE BEHAVIOUR THERE would be how
 *   somebody switches on the wrong thing and then trusts it. The screen
 *   renders what the server says it does.
 *
 *   A PHARMACIST IS NOT OFFERED "a driver never came on shift". They are
 *   never sent it -- every fan-out picks its own audience -- and a switch
 *   that cannot change anything is a lie about what the software does. The
 *   server filters the catalogue by role; this file does not know the rule
 *   and does not need to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW OFTEN, SAID OUT LOUD, BESIDE THE SWITCH.
 *
 * Two kinds here -- every arrival and every completion -- run between five
 * hundred and fifteen hundred a day. They are off, and they are one tap
 * away for a lead who is away from a desk and genuinely wants a buzz per
 * delivery. What they must never be is on by accident, so the volume is on
 * the row rather than in a help page: "constant" next to a switch is the
 * difference between a choice and a trap.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE SAVE, NOT A SAVE PER TOGGLE. Somebody who changes three switches and
 * closes the laptop should not have left two of them changed. The server
 * takes the batch; this screen holds the pending state and says, plainly,
 * that there are unsaved changes.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, why } from '../lib/api';
import { useAuth } from '../app/auth';
import { askForDesktop, desktopState, showDesktop, type DesktopState } from '../lib/desktop';

interface KindRow {
    kind: string;
    label: string;
    about: string;
    volume: 'rare' | 'daily' | 'constant';
    enabledByDefault: boolean;
    /** What is in force now: the override if there is one, else the default. */
    enabled: boolean;
    /** Whether this person has ever said anything about it, which is what
     *  lets "I turned this off" be told apart from "it comes like this". */
    chosen: boolean;
}

const HOW_OFTEN: Record<KindRow['volume'], string> = {
    rare: 'A few a week',
    daily: 'A few a day',
    constant: 'Hundreds a day',
};

export function Notifications() {
    const { projects } = useAuth();
    const [kinds, setKinds] = useState<KindRow[] | null>(null);
    /* Pending changes, kind → wanted. Empty means nothing to save. */
    const [pending, setPending] = useState<Map<string, boolean>>(new Map());
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');
    /* ───── WHICH CONTRACT THESE APPLY TO, SAID RATHER THAN ASSUMED.
     *
     * Preferences are keyed per project on the server, and the roles differ
     * per project too -- the same person can be a lead on one and a courier
     * on another, so the catalogue itself changes with this. Everybody on
     * this system today has one contract and sees no picker at all; the
     * administrator on two would otherwise have silently set University
     * Health's switches while believing they had set both. */
    const [project, setProject] = useState<string | null>(null);
    useEffect(() => {
        setProject((was) => (was !== null && projects.some((p) => p.code === was) ? was : projects[0]?.code ?? null));
    }, [projects]);

    const load = useCallback(async () => {
        if (project === null) { setKinds(projects.length === 0 ? [] : null); return; }
        try {
            const got = await api<{ kinds: KindRow[] }>(`/api/projects/${project}/uh/notifications/prefs`);
            setKinds(got.kinds);
            setPending(new Map());
        } catch (err) {
            setError(why(err, 'Could not load your notification settings.'));
            setKinds([]);
        }
    }, [project, projects.length]);

    useEffect(() => { void load(); }, [load]);

    const wanted = (k: KindRow): boolean => pending.get(k.kind) ?? k.enabled;

    const flip = (k: KindRow) => {
        setSaved(false);
        setPending((was) => {
            const next = new Map(was);
            const now = !wanted(k);
            /* Flipping back to where it started removes the entry, so the
               Save button can be honest about whether anything has changed.
               Otherwise an accidental double-tap leaves the page claiming
               unsaved work that does not exist. */
            if (now === k.enabled) next.delete(k.kind);
            else next.set(k.kind, now);
            return next;
        });
    };

    const save = async () => {
        if (pending.size === 0 || project === null) return;
        setSaving(true);
        setError('');
        try {
            const prefs = [...pending].map(([kind, enabled]) => ({ kind, enabled }));
            await api(`/api/projects/${project}/uh/notifications/prefs`, { method: 'PUT', json: { prefs } });
            setKinds((was) => (was ?? []).map((k) => (
                pending.has(k.kind) ? { ...k, enabled: pending.get(k.kind)!, chosen: true } : k
            )));
            setPending(new Map());
            setSaved(true);
        } catch (err) {
            setError(why(err, 'Could not save that.'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <h1>Notifications</h1>
            <p className="izy-sub">
                What reaches you, and where. The bell in the corner of every screen holds everything
                switched on below; the Activity tab beside it shows the whole operation as it happens
                and is not affected by any of this.
            </p>

            <OnThisComputer />

            <div className="izy-card">
                <h2>What you are told about</h2>
                {projects.length > 1 && (
                    <p>
                        <label>
                            These apply to{' '}
                            <select
                                value={project ?? ''}
                                onChange={(e) => { setProject(e.target.value); setKinds(null); }}
                            >
                                {projects.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                            </select>
                        </label>
                        {' '}
                        <span className="izy-muted">Each contract is set separately.</span>
                    </p>
                )}
                {kinds === null && <p className="izy-muted">Loading…</p>}
                {kinds !== null && kinds.length === 0 && (
                    <p className="izy-muted">There is nothing to set on this account.</p>
                )}
                {error !== '' && <p className="izy-issue-error">{error}</p>}

                {kinds !== null && kinds.length > 0 && (
                    <ul className="izy-prefs">
                        {kinds.map((k) => (
                            <li key={k.kind}>
                                <label className="izy-pref">
                                    <input
                                        type="checkbox"
                                        checked={wanted(k)}
                                        onChange={() => flip(k)}
                                    />
                                    <span className="izy-pref-text">
                                        <b>{k.label}</b>
                                        <span className="izy-pref-about">{k.about}</span>
                                        <span className="izy-pref-tags">
                                            <span className={`izy-pill${k.volume === 'constant' ? ' warn' : ' muted'}`}>
                                                {HOW_OFTEN[k.volume]}
                                            </span>
                                            {/* Only when this person changed it.
                                                Saying "on by default" beside
                                                something that is on by default
                                                and untouched is a word on every
                                                row that distinguishes nothing. */}
                                            {k.chosen && wanted(k) !== k.enabledByDefault && (
                                                <span className="izy-pill muted">
                                                    You changed this
                                                </span>
                                            )}
                                        </span>
                                    </span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}

                {kinds !== null && kinds.length > 0 && (
                    <div className="izy-prefs-save">
                        <button
                            type="button"
                            className="izy-btn"
                            disabled={pending.size === 0 || saving}
                            onClick={() => { void save(); }}
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                        {pending.size > 0 && !saving && (
                            <span className="izy-muted">
                                {pending.size} unsaved change{pending.size === 1 ? '' : 's'}.
                            </span>
                        )}
                        {saved && pending.size === 0 && <span className="izy-muted">Saved.</span>}
                    </div>
                )}
            </div>
        </>
    );
}

/* ─────────────────────────────────────── the operating system's own banner
 *
 * SEPARATE FROM THE LIST ABOVE, because it is a different question. The list
 * is WHAT you are told. This is WHERE, and it is per browser and per machine
 * rather than per account: granting it on the dispatch desk says nothing
 * about the laptop at home, and a setting stored on the account would claim
 * otherwise.
 *
 * THE TEST BUTTON EXISTS BECAUSE THE GRANT IS NOT THE PROOF. Permission can
 * be allowed and the banner still never appear: Windows Focus Assist, macOS
 * Do Not Disturb, a browser in full screen, notifications switched off for
 * the browser itself one level up in the operating system. Somebody who
 * presses Allow and sees nothing for two days concludes the feature does not
 * work, and they are right, and nothing in the application would have told
 * them. One button closes that.
 */
function OnThisComputer() {
    const [state, setState] = useState<DesktopState>(() => desktopState());
    const [tested, setTested] = useState<null | boolean>(null);

    const ask = async () => { setState(await askForDesktop()); setTested(null); };

    const test = async () => {
        setTested(await showDesktop({
            id: 0,
            kind: 'mail.failing',
            /* Deliberately not dressed up as a real event. A test banner that
               reads like a genuine one is a dispatcher walking to a desk. */
            body: 'This is a test. Real notifications look like this one.',
            href: '/notifications',
        }));
    };

    return (
        <div className="izy-card">
            <h2>On this computer</h2>
            <p className="izy-sub">
                Notifications on the <b>For you</b> list can also appear in the corner of this screen while
                you are working in something else. Arrivals and completions never do — there are
                hundreds a day and the Activity feed is where they belong.
            </p>

            {state === 'unsupported' && (
                <p className="izy-muted">
                    This browser cannot show them. Chrome, Edge and Firefox can; Safari can once the app
                    is added to the Dock or the Home Screen.
                </p>
            )}

            {state === 'default' && (
                <p>
                    <button type="button" className="izy-btn" onClick={() => { void ask(); }}>
                        Turn on notifications for this computer
                    </button>
                </p>
            )}

            {state === 'denied' && (
                <p className="izy-issue-error">
                    This browser is blocking them for this site, and that cannot be undone from here.
                    Open the padlock beside the address bar, set Notifications to Allow, and reload.
                </p>
            )}

            {state === 'granted' && (
                <>
                    <p><span className="izy-pill">On for this computer</span></p>
                    <p>
                        <button type="button" className="izy-btn secondary small" onClick={() => { void test(); }}>
                            Send a test notification
                        </button>
                        {tested === true && (
                            <span className="izy-muted">
                                {' '}Sent. If nothing appeared, this computer is suppressing them —
                                check Do Not Disturb or Focus, and the browser&rsquo;s entry in the
                                system notification settings.
                            </span>
                        )}
                        {tested === false && (
                            <span className="izy-issue-error">
                                {' '}The browser refused it. Reload the page and try once more.
                            </span>
                        )}
                    </p>
                    <p className="izy-muted">
                        Turning them off again is done in the browser, not here — the padlock beside the
                        address bar.
                    </p>
                </>
            )}
        </div>
    );
}
