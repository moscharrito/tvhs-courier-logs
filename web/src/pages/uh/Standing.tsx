/* Who is about to stop being allowed to work, and who already has.
 *
 * Ticket 8.4. The fourth phase 6 screen, and the one that reports on people
 * who were approved months ago rather than on anybody in a queue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THIS REPORTS, stated in the place a person will read it.
 *
 * `clearanceOf` runs when an application is read, listed, recorded against
 * and approved. It does not run when work is assigned. So the five gates are
 * a door with nothing behind it: a courier approved in September whose HIPAA
 * training expires in November keeps being handed patient names and
 * addresses in December, and until this screen no part of the system would
 * have said so.
 *
 * This makes it visible. It does not make it enforced, and the screen says
 * that in as many words rather than letting somebody assume a red row means
 * somebody has been stopped. Enforcement is a decision with a cost in both
 * directions: refusing a lapsed courier is the consistent answer and matches
 * 6.2's refusal to have an override, but an insurance policy expiring at
 * midnight then makes a van unassignable in the middle of a wave, and every
 * courier seeded before ticket 6.1 has no application at all and would be
 * refused outright.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { Section } from '../../app/Section';
import { Pager, usePaged } from '../../app/Pager';

const LABEL: Record<string, string> = {
    hipaa_training: 'HIPAA training',
    confidentiality: 'Confidentiality agreement',
    background_check: 'Background check',
    drivers_licence: 'Driving licence',
    insurance: 'Insurance',
};

export interface ExpiryRow {
    kind: string;
    expiresAt: string;
    daysLeft: number;
}

export interface CourierStanding {
    username: string;
    name: string;
    applicationId: number | null;
    lapsed: ExpiryRow[];
    soon: ExpiryRow[];
    missing: string[];
    neverOnboarded: boolean;
}

export interface StandingReport {
    on: string;
    horizonDays: number;
    lapsed: CourierStanding[];
    soon: CourierStanding[];
    neverOnboarded: CourierStanding[];
    clearCount: number;
    why: string;
}

/** Days as a phrase, because "-7" on a screen is a puzzle. */
function when(row: ExpiryRow): string {
    if (row.daysLeft < 0) return `expired ${-row.daysLeft} ${-row.daysLeft === 1 ? 'day' : 'days'} ago, on ${row.expiresAt}`;
    if (row.daysLeft === 0) return `runs out today, ${row.expiresAt}`;
    return `${row.daysLeft} ${row.daysLeft === 1 ? 'day' : 'days'} left, until ${row.expiresAt}`;
}

const HORIZONS = [14, 30, 60, 90];

export function Standing({ projectCode }: { projectCode: string }) {
    const base = `/api/projects/${projectCode}/driver-applications/standing`;
    const [horizon, setHorizon] = useState(30);
    const [report, setReport] = useState<StandingReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setReport(await api<StandingReport>(`${base}?withinDays=${horizon}`));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not load onboarding standing');
        }
    }, [base, horizon]);
    useEffect(() => { void load(); }, [load]);

    const trouble = report === null ? 0 : report.lapsed.length + report.neverOnboarded.length;

    return (
        <Section
            id="uh.standing"
            title="Onboarding that is running out"
            /* Open, always. Not "open when something is wrong": `defaultOpen`
               is read once at mount, before the report has loaded, so a rule
               that depends on the data would fold this away and never unfold
               it. That mistake was made in 8.2 and caught by a test. */
            defaultOpen
            summary={report === null ? undefined : report.why}
            actions={(
                <label className="izy-field inline">
                    Looking ahead
                    <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                        {HORIZONS.map((d) => <option key={d} value={d}>{d} days</option>)}
                    </select>
                </label>
            )}
        >
            {error && <div className="izy-alert error" role="alert">{error}</div>}

            {report === null ? <Loading label="Checking onboarding" /> : (
                <>
                    {/* The verdict, in the body and not only in the fold
                        summary. `Section` shows a summary ONLY while it is
                        folded (ticket 5.14), so with this card open the one
                        sentence that answers "is anybody about to stop being
                        able to work" was on screen nowhere at all. */}
                    <p className={trouble > 0 ? undefined : 'izy-muted'}>{report.why}</p>

                    {/* Said before any list, because a red row on this screen
                        means somebody is still working, not that they have
                        been stopped. Somebody reading three lapsed couriers
                        and assuming the system handled it is worse off than
                        somebody reading nothing at all. */}
                    {trouble > 0 && (
                        <div className="izy-alert error" role="alert">
                            <b>Nothing here stops anybody working.</b> Clearance is checked when an application is
                            approved and never again, so every courier below is still being assigned patient names
                            and addresses today. Chasing them is a person&apos;s job until that changes.
                        </div>
                    )}

                    <Group
                        heading="Already expired"
                        blurb="Working right now without a current artifact. This is the list University Health would ask about."
                        couriers={report.lapsed}
                        empty="Nobody is working with something expired."
                        tone="bad"
                    />

                    <Group
                        heading={`Expiring within ${report.horizonDays} days`}
                        blurb="Renew these before they become the list above. A licence takes longer to replace than a courier expects."
                        couriers={report.soon}
                        empty={`Nothing expires in the next ${report.horizonDays} days.`}
                        tone="warn"
                    />

                    <NeverOnboarded couriers={report.neverOnboarded} />

                    <p className="izy-muted izy-footnote">
                        {report.clearCount} {report.clearCount === 1 ? 'courier is' : 'couriers are'} current with
                        nothing due inside the window. Checked against {report.on} in the project&apos;s timezone,
                        because an expiry date belongs to a calendar and not to a clock.
                    </p>
                </>
            )}
        </Section>
    );
}

function Group({ heading, blurb, couriers, empty, tone }: {
    heading: string;
    blurb: string;
    couriers: CourierStanding[];
    empty: string;
    tone: 'bad' | 'warn';
}) {
    const paged = usePaged(couriers);
    return (
        <div style={{ marginTop: 14 }}>
            <h3>{heading} <span className="izy-muted">({couriers.length})</span></h3>
            <p className="izy-muted">{blurb}</p>
            {couriers.length === 0 ? <p className="izy-muted">{empty}</p> : (
                <>
                    <table className="izy-table">
                        <thead>
                            <tr><th>Courier</th><th>What</th><th>When</th></tr>
                        </thead>
                        <tbody>
                            {paged.rows.map((c) => (
                                <tr key={c.username}>
                                    <td>
                                        <b>{c.name}</b>
                                        <div className="izy-muted">{c.username}</div>
                                        {/* A check put back to pending after
                                            approval is a different sentence
                                            from an expiry, and 6.2 keeps them
                                            apart on purpose. */}
                                        {c.missing.length > 0 && (
                                            <div className="izy-muted">
                                                also not recorded: {c.missing.map((k) => LABEL[k] ?? k).join(', ')}
                                            </div>
                                        )}
                                    </td>
                                    <td>
                                        {(tone === 'bad' ? c.lapsed : c.soon).map((r) => (
                                            <div key={r.kind}>{LABEL[r.kind] ?? r.kind}</div>
                                        ))}
                                        {/* Somebody in the lapsed list may
                                            also have something due next week.
                                            They are one row, in the loudest
                                            list, and this is where the rest
                                            of it shows up. */}
                                        {tone === 'bad' && c.soon.length > 0 && (
                                            /* With its date. Naming the
                                               artifact and not when it runs
                                               out makes somebody open a
                                               second screen to find out
                                               whether it is urgent. */
                                            <div className="izy-muted">
                                                and soon: {c.soon.map((r) => `${LABEL[r.kind] ?? r.kind} (${when(r)})`).join('; ')}
                                            </div>
                                        )}
                                    </td>
                                    <td className={tone === 'bad' ? 'izy-stat-bad' : 'izy-stat-warn'}>
                                        {(tone === 'bad' ? c.lapsed : c.soon).map((r) => (
                                            <div key={r.kind}>{when(r)}</div>
                                        ))}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <Pager of={paged} noun="couriers" />
                </>
            )}
        </div>
    );
}

function NeverOnboarded({ couriers }: { couriers: CourierStanding[] }) {
    const paged = usePaged(couriers);
    if (couriers.length === 0) {
        return (
            <div style={{ marginTop: 14 }}>
                <h3>No onboarding record <span className="izy-muted">(0)</span></h3>
                <p className="izy-muted">Every courier on this project went through onboarding.</p>
            </div>
        );
    }
    return (
        <div style={{ marginTop: 14 }}>
            <h3>No onboarding record <span className="izy-muted">({couriers.length})</span></h3>
            {/* Counted rather than hidden, and this is the sentence that
                makes the rest of the screen worth trusting. A report built
                from the applications table alone would show these people as
                fine, because there is no row to find anything wrong in. */}
            <p className="izy-muted">
                These hold a courier membership on this project and have no application behind it, so there is no
                record that any of the five was ever seen. Everybody enrolled before driver signup existed looks
                like this, including the simulation couriers. They are listed rather than counted as clear,
                because a report that leaves out the people it knows nothing about is a report that says everybody
                is fine.
            </p>
            <table className="izy-table">
                <thead><tr><th>Courier</th><th /></tr></thead>
                <tbody>
                    {paged.rows.map((c) => (
                        <tr key={c.username}>
                            <td><b>{c.name}</b><div className="izy-muted">{c.username}</div></td>
                            <td className="izy-muted">nothing on file</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <Pager of={paged} noun="couriers" />
        </div>
    );
}
