/* A pharmacy sending us tomorrow's list itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES.
 *
 * A spreadsheet of patients attached to an email, read by somebody here and
 * imported by hand. That costs a person at each end, and it leaves a patient
 * list sitting in two inboxes: email is the one hop in this system we neither
 * control nor hold an audit trail for. Uploading removes the inbox, and it
 * starts the record at the moment the list actually arrived rather than at
 * the moment one of us got round to it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS THE DISPATCH SCREEN, NOT A COPY OF IT.
 *
 * ListImport already reads the file, maps the columns, validates every row,
 * resolves zones and deadlines, shows the result and only then creates
 * anything. The review step is the whole point and it matters more at a
 * counter than at a desk, not less: a list that imports silently and wrongly
 * sends medication to the wrong address. So this page is the pharmacy list,
 * the right words, and that component.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PHARMACIES COME FROM THE PORTAL'S OWN SUMMARY.
 *
 * Not from GET /sites, which carries every University Health site's address
 * and contact details and is closed to this role on purpose. The summary
 * returns exactly the counters this account is scoped to, which is also
 * exactly what the server will accept an upload for.
 *
 * Nothing on this page is a permission. The server scopes every call to the
 * membership, sets the received time from its own clock and refuses a service
 * date that has gone; this screen can ask for none of those and be believed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { useAuth, useProjectTimezone } from '../../app/auth';
import { ListImport, type ImportSite } from './ListImport';

interface Summary {
    serviceDate: string;
    timezone: string;
    pharmacies: ImportSite[];
    notes: string[];
    /* listRelease.allowPortalUpload on the project. The server refuses the
     * upload when it is off; this page is reachable by typing the address,
     * so it says so plainly rather than offering a form that cannot work.
     * Absent reads as off. */
    canUploadList?: boolean;
}

export function ClientListUpload() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);
    const timezone = useProjectTimezone(code);

    const [summary, setSummary] = useState<Summary | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setSummary(await api<Summary>(`/api/projects/${code}/uh/client/summary`));
        } catch (err) {
            setMsg(err instanceof ApiError ? err.message : 'Could not load your pharmacies.');
        }
    }, [code]);
    useEffect(() => { void load(); }, [load]);

    if (!project) {
        return (<><h1>Not available</h1><Link className="izy-btn secondary" to="/">Back</Link></>);
    }
    if (summary === null) {
        return msg
            ? (<><h1>Send a list</h1><div className="izy-alert error" role="alert">{msg}</div></>)
            : <div className="izy-card"><Loading label="Loading your pharmacies" /></div>;
    }

    /* A route with no link to it is still a route somebody can type. Saying
       what the contract agreed is more use than a form that would be refused
       by the server the moment they pressed the button. */
    if (summary.canUploadList !== true) {
        return (
            <>
                <h1>Send a list</h1>
                <div className="izy-alert warn" role="status">
                    This contract sends its daily lists to Izy dispatch by email rather than through the
                    portal. Nothing uploaded here would reach us.
                </div>
                <p>
                    <Link className="izy-btn secondary" to={`/projects/${code}/deliveries`}>
                        Back to deliveries
                    </Link>
                </p>
            </>
        );
    }

    return (
        <>
            <h1>Send a list</h1>
            <p className="izy-sub">
                {summary.pharmacies.map((p) => p.name).join(', ') || 'No pharmacies assigned'}
                {' · '}times in {summary.timezone}
            </p>

            {summary.notes.map((n) => (
                <div key={n} className="izy-alert warn" role="status">{n}</div>
            ))}

            <p>
                <Link className="izy-btn secondary" to={`/projects/${code}/deliveries`}>
                    Back to deliveries
                </Link>
            </p>

            <ListImport
                projectCode={code}
                timezone={timezone}
                /* The server decides, and refuses an account with no
                   pharmacies named. This only stops the form offering a
                   submit button that could not work. */
                canImport={summary.pharmacies.length > 0}
                sites={summary.pharmacies}
                title="Today's deliveries"
                intro={'Upload your list as .xlsx or .csv. Nothing is created until you have seen the rows '
                    + 'below and confirmed them. The file itself is never stored: it is read and discarded, '
                    + 'and only the deliveries are kept.'}
                refusal={'No pharmacies are assigned to this account yet, so there is nowhere to send a list. '
                    + 'Ask Izy dispatch to set them up.'}
            />

            <p className="izy-muted">
                The clock on each delivery starts when the list reaches us, which is when this upload
                finishes. Sending a list for a day that has already passed is refused: ring dispatch
                instead, because those deliveries need a person.
            </p>
        </>
    );
}
