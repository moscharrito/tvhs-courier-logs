/* Collecting a batch at the pharmacy counter.
 *
 * One pharmacy at a time, because that is where the courier is standing, and
 * one signature for the batch, because a technician handing over forty
 * packages signs once.
 *
 * The count is asked for rather than shown: pre-filling it with the expected
 * number would turn "confirm the count" into "tap continue", which is the
 * failure this screen exists to prevent. A mismatch needs a reason and is
 * then allowed through, because a short handover is a real thing that has to
 * reach the record rather than be argued with on a phone.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Loading } from '../../app/Loading';
import { Pager, usePaged } from '../../app/Pager';
import { Section } from '../../app/Section';
import { CardButton, CardLink, Chip, Context, Panel, Screen, ScreenHeader, Sheet } from '../../app/Glass';
import { BoxIcon, RouteIcon } from '../../app/Icons';
import { sendOrQueue, uploadPhotoNow } from '../../lib/outbox';

interface WaitingOrder { orderId: number; sequence: number; recipientName: string; externalRef: string; packages: number; controlled?: boolean }
/* `controlled` is true when ANY order in the group is, which is what decides
   whether the courier has to countersign. The server has always sent it; this
   screen never read it, so a courier could not complete a collection holding
   a controlled item from a browser at all. */
interface SiteGroup { site: { id: number; code: string; name: string }; orders: WaitingOrder[]; packages: number; controlled?: boolean }
interface Waiting { runId: number; courierUsername: string; sites: SiteGroup[]; totals: { orders: number; packages: number } }

interface PickupResult {
    collected: number[];
    refused: Array<{ orderId: number; error: string }>;
    expectedPackages: number;
    countedPackages: number;
    discrepancy: number;
    notes: string[];
    remaining: SiteGroup[];
}

/** Ask the phone where it is, and carry on without it if it says no. */
async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
        const done = (value: { lat: number; lng: number } | null) => resolve(value);
        const timer = setTimeout(() => done(null), 8000);
        navigator.geolocation.getCurrentPosition(
            (pos) => { clearTimeout(timer); done({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
            () => { clearTimeout(timer); done(null); },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
        );
    });
}

export function Pickup() {
    const { code = '', runId = '' } = useParams();
    const [params] = useSearchParams();
    const base = `/api/projects/${code}/uh/runs/${runId}`;

    const [waiting, setWaiting] = useState<Waiting | null>(null);
    const [siteId, setSiteId] = useState<number | ''>(params.get('siteId') ? Number(params.get('siteId')) : '');
    const [signedName, setSignedName] = useState('');
    /* THE COUNTER SIGNS PAPER NOW, same as the door. One photograph covers
       the batch, exactly as one signature did: a technician handing over
       forty packages signs one form. */
    const [formPhoto, setFormPhoto] = useState<File | null>(null);
    const [noFormReason, setNoFormReason] = useState('');
    /* §6 of the offer letter: a documented two-signature handoff on anything
       controlled. This one stays on glass and has no photograph and no
       escape, because the courier is the person holding the phone. */
    const [counted, setCounted] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<PickupResult | null>(null);
    const [queued, setQueued] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string; details?: string[] } | null>(null);

    const load = useCallback(async () => {
        try {
            const w = await api<Waiting>(`${base}/pickup`);
            setWaiting(w);
            setSiteId((current) => (current === '' && w.sites.length === 1 ? w.sites[0]!.site.id : current));
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach dispatch.' });
            setWaiting({ runId: Number(runId), courierUsername: '', sites: [], totals: { orders: 0, packages: 0 } });
        }
    }, [base, runId]);
    useEffect(() => { void load(); }, [load]);

    /* ABOVE THE EARLY RETURN, and it has to stay there.
     *
     * The first render has no `waiting` and takes the spinner branch; the
     * second has it and renders the form. A hook called only on the second
     * is a hook React did not see on the first, which is "rendered more
     * hooks than during the previous render" and a white screen for the
     * courier. The app's Run.tsx carries the same note for the same reason,
     * and that one was found by a driver rather than by a test. */
    const batch = usePaged(waiting?.sites.find((s) => s.site.id === siteId)?.orders ?? []);

    if (waiting === null) return <div className="izy-card"><Loading label="Loading the pickup" /></div>;

    const group = waiting.sites.find((s) => s.site.id === siteId) ?? null;
    const expected = group?.packages ?? 0;
    const countedNumber = counted === '' ? null : Number(counted);
    const mismatch = countedNumber !== null && countedNumber !== expected;
    /* The server's own three branches: a photographed form, or a reason for
       not having one. The printed name is untouched -- Scope 1.2.8 wants the
       name of the sending personnel and a photograph does not reliably yield
       one. */
    const controlled = group?.controlled === true;
    const ready = group !== null && signedName.trim() !== '' && countedNumber !== null
        && (formPhoto !== null || noFormReason.trim().length >= 3)
        && (!mismatch || note.trim() !== '');

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!ready || group === null) return;
        setBusy(true);
        setMsg(null);
        const position = await currentPosition();

        /* Uploaded BEFORE the collection is queued, and a failure records
           nothing -- the same rule the door follows, for the same reason: a
           handover whose proof did not upload is one we cannot evidence. */
        let courierFormFileId: number | undefined;
        if (formPhoto !== null) {
            try {
                courierFormFileId = await uploadPhotoNow({
                    module: `/api/projects/${code}/uh`,
                    orderId: null,
                    blob: formPhoto,
                    contentType: formPhoto.type,
                    kind: 'courier_form',
                    idemKey: `pickup-${group.site.id}-${formPhoto.size}-${formPhoto.lastModified}`,
                });
            } catch (err) {
                setBusy(false);
                setMsg({
                    kind: 'error',
                    text: `The photo of the form could not be sent: ${err instanceof Error ? err.message : 'unknown error'}. `
                        + 'Nothing was recorded. Try again, or say why there is no form.',
                });
                return;
            }
        }

        try {
            /* Through the outbox: pharmacy counters are indoors, often in a
               basement, and a courier who cannot record a pickup cannot start
               the run. */
            const outcome = await sendOrQueue({
                url: `${base}/pickup`,
                body: {
                    siteId: group.site.id,
                    signedName: signedName.trim(),
                    ...(courierFormFileId === undefined ? {} : { courierFormFileId }),
                    ...(formPhoto === null ? { noSignatureReason: noFormReason.trim() } : {}),
                    countedPackages: countedNumber,
                    note: note.trim(),
                    ...(position ?? {}),
                },
                label: `Pickup at ${group.site.name}`,
                orderId: null,
            });
            if (outcome.sent) {
                setDone(outcome.body as unknown as PickupResult);
            } else {
                setQueued(true);
            }
            setFormPhoto(null);
            setNoFormReason('');
            setSignedName('');
            setCounted('');
            setNote('');
            await load();
        } catch (err) {
            setMsg(err instanceof ApiError
                ? { kind: 'error', text: err.message, details: err.details }
                : { kind: 'error', text: 'Could not record the pickup. Try again.' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Screen>
            {/* The upper region: which counter, and how much of it. The app's
                Collect screen puts exactly these two numbers here, and they
                are the two a courier checks against the trolley in front of
                them before they start counting. */}
            <Context>
                <ScreenHeader
                    title="Pick up"
                    subtitle={<><Link to={`/projects/${code}/my-run`}>Today</Link> · run {runId}</>}
                />
                {group !== null ? (
                    <Panel>
                        <h2 className="izy-lede-kicker">Collecting from</h2>
                        <p className="izy-lede">{group.site.name}</p>
                        <div className="izy-chips">
                            <Chip label={`${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`} />
                            <Chip label={`${group.packages} expected`} tone="warn" />
                            {/* §6 of the offer letter: a documented
                                two-signature handoff on anything controlled.
                                Both signatures are on the paper docket, and
                                the delivery is refused without a photograph
                                of it — so what this has to do is make sure
                                nobody drives off not knowing. */}
                            {group.controlled && <Chip label="CONTROLLED" tone="bad" />}
                        </div>
                    </Panel>
                ) : (
                    <Panel>
                        <h2 className="izy-lede-kicker">Collecting from</h2>
                        <p className="izy-lede">
                            {waiting.sites.length === 0 ? 'Nothing left to collect' : 'Choose where you are'}
                        </p>
                        <p className="izy-lede-note">
                            {waiting.sites.length === 0
                                ? 'Nothing left to collect on this run.'
                                : `${waiting.totals.orders} ${waiting.totals.orders === 1 ? 'order' : 'orders'} `
                                  + `across ${waiting.sites.length} ${waiting.sites.length === 1 ? 'pharmacy' : 'pharmacies'}.`}
                        </p>
                    </Panel>
                )}
            </Context>

            <Sheet>
                {msg && (
                    <div className={`izy-alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
                        {msg.text}
                        {msg.details && msg.details.length > 0 && <ul>{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
                    </div>
                )}

                {done && (
                    <div className="izy-alert ok" role="status">
                        Collected {done.collected.length} {done.collected.length === 1 ? 'order' : 'orders'}.
                        {done.notes.length > 0 && <ul>{done.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                    </div>
                )}

                {queued && (
                    <div className="izy-alert warn" role="status">
                        Saved on this phone. The pickup will be sent as soon as you have signal, and the list
                        above will catch up then. Load the vehicle and go.
                    </div>
                )}

                {waiting.sites.length === 0 ? (
                    <CardLink
                        to={`/projects/${code}/my-run`}
                        title="Back to today"
                        Icon={RouteIcon}
                        tone="primary"
                        detail="Your round, and the next stop on it"
                    />
                ) : (
                    <form onSubmit={(e) => { void submit(e); }}>
                        {/* ONE PHARMACY AND IT IS ALREADY CHOSEN: no question.
                            A select with a single option is a control that
                            asks the courier to confirm something the screen
                            already knows, and the name is in the panel above
                            either way. */}
                        {waiting.sites.length > 1 && (
                            <label className="izy-field">Pharmacy
                                <select value={siteId} onChange={(e) => { setSiteId(e.target.value === '' ? '' : Number(e.target.value)); setCounted(''); }}>
                                    <option value="">Choose where you are</option>
                                    {waiting.sites.map((s) => (
                                        <option key={s.site.id} value={s.site.id}>
                                            {s.site.name} ({s.orders.length} {s.orders.length === 1 ? 'order' : 'orders'}, {s.packages} packages)
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}

                        {group && (
                            <>
                                <div className="izy-card">
                                    <h2>Count the packages</h2>
                                    <p className="izy-muted">
                                        {group.orders.length} {group.orders.length === 1 ? 'order' : 'orders'} for this pharmacy.
                                        Count what you are actually given and type it in.
                                    </p>
                                    {/* Deliberately empty, never prefilled with
                                        the expected number: a box that starts
                                        correct is a box everybody taps through
                                        without counting. */}
                                    <label className="izy-field" style={{ maxWidth: 180 }}>Packages counted
                                        <input
                                            value={counted}
                                            onChange={(e) => setCounted(e.target.value.replace(/[^0-9]/g, ''))}
                                            inputMode="numeric"
                                            placeholder="0"
                                            required
                                        />
                                    </label>
                                    {mismatch && (
                                        <div className="izy-alert warn" role="status">
                                            The list expects {expected}. Say why the count is different before you continue.
                                            <label className="izy-field" style={{ marginTop: 8 }}>Reason
                                                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="One item not ready" />
                                            </label>
                                        </div>
                                    )}
                                    {/* PAGED, AND FOLDED BY DEFAULT.
                                        A Robert B. Green wave is forty orders.
                                        Rendered whole, the count box and the
                                        Continue button were pushed off a phone
                                        screen by a list the courier is not
                                        reading yet -- they are counting boxes,
                                        not names. It is here to settle an
                                        argument about one package, which is a
                                        thing you look up rather than scroll
                                        past. Section rather than <details>, so
                                        it folds like every other panel in the
                                        application and remembers whether this
                                        courier likes it open. */}
                                    <Section
                                        id="uh.pickup.batch"
                                        title="What is in this batch"
                                        defaultOpen={false}
                                        summary={`${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`}
                                    >
                                        <ul className="izy-plain-list">
                                            {batch.rows.map((o) => (
                                                <li key={o.orderId}>
                                                    {o.recipientName} · {o.packages} {o.packages === 1 ? 'package' : 'packages'}
                                                    {o.externalRef && <> · {o.externalRef}</>}
                                                </li>
                                            ))}
                                        </ul>
                                        <Pager of={batch} noun="orders" />
                                    </Section>
                                </div>

                                <div className="izy-card">
                                    <h2>The signed form</h2>
                                    <p className="izy-muted">
                                        The printed name of the person handing the packages over, and a photograph of
                                        the form they signed. One photograph covers the whole collection.
                                    </p>
                                    <label className="izy-field">Printed name
                                        <input value={signedName} onChange={(e) => setSignedName(e.target.value)} required placeholder="Name of the pharmacy staff member" />
                                    </label>

                                    {/* THE PHARMACY'S PAD IS GONE. The counter
                                        signs its own collection document and this
                                        photographs it, so asking a technician to
                                        scrawl on a phone as well was asking them
                                        to sign twice -- and that scrawl was the
                                        thing couriers reported stopped the round. */}
                                    <label className="izy-field">Photo of the signed form
                                        <input
                                            type="file"
                                            accept="image/jpeg,image/png,image/webp"
                                            disabled={busy}
                                            onChange={(e) => setFormPhoto(e.target.files?.[0] ?? null)}
                                        />
                                        <span className="izy-muted izy-field-note">
                                            {formPhoto === null
                                                ? 'The pharmacy form for this collection. Take one now, or choose one you already have.'
                                                : `Ready to send: ${formPhoto.name}`}
                                        </span>
                                    </label>

                                    {formPhoto === null && (
                                        <label className="izy-field">If there is no signed form, say why
                                            <input
                                                value={noFormReason}
                                                onChange={(e) => setNoFormReason(e.target.value)}
                                                placeholder="e.g. the counter had no form ready"
                                                disabled={busy}
                                            />
                                            <span className="izy-muted izy-field-note">
                                                A collection with no proof and no explanation is a gap in the chain of
                                                custody that nobody can explain later.
                                            </span>
                                        </label>
                                    )}

                                    {/* THE PAD WENT ON 19 OCTOBER. Both signatures
                                        are on the physical form, and the driver
                                        photographs it at the final delivery --
                                        stop.ts refuses a controlled delivery
                                        without that photograph. Asking the
                                        courier to draw a mark here as well was
                                        asking them to sign twice for one
                                        handover, in a place the paper had not
                                        reached yet. */}
                                </div>

                                {/* THE ACTION, LAST AND LARGEST. `detail` says
                                    what is missing while it is disabled, which
                                    is the sentence that used to sit under the
                                    button in grey and is the only thing a
                                    stuck courier needs. */}
                                <CardButton
                                    submit
                                    title={`Take custody of ${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'}`}
                                    Icon={BoxIcon}
                                    tone="primary"
                                    disabled={!ready}
                                    busy={busy}
                                    detail={ready
                                        ? `${counted} packages into the van, signed for by ${signedName.trim()}`
                                        : [
                                            signedName.trim() === '' ? 'Add the printed name.' : '',
                                            formPhoto === null && noFormReason.trim().length < 3
                                                ? 'Photograph the signed form, or say why there is none.' : '',
                                            countedNumber === null ? 'Count the packages.' : '',
                                            mismatch && note.trim() === '' ? 'Say why the count is different.' : '',
                                        ].filter(Boolean).join(' ')}
                                />
                            </>
                        )}
                    </form>
                )}
            </Sheet>
        </Screen>
    );
}
