/* Today's run, on the phone it was designed for (ticket 7.1).
 *
 * The same `GET /uh/runs/mine` the web shell calls, which is the point of
 * having built phase 6 server-first: this screen is a second client of an API
 * that already works and is already tested.
 *
 * DIRECTIONS CARRY THE ADDRESS AND NEVER THE NAME (ticket 7.3). That rule
 * predates the app: web/src/pages/uh/MyRun.tsx has carried it since the
 * beginning, and the reason is unchanged. An address is what it takes to
 * drive there; the patient's name adds nothing to the navigation and
 * everything to the disclosure.
 *
 * On a phone this hands the address to the platform's own maps app rather
 * than drawing a map here, and that is the better privacy answer as well as
 * the simpler one: the courier's own navigation app makes the request, the
 * way it does when they type an address themselves. The embedded map decided
 * in ticket 5.13 makes THIS APPLICATION the sender of a patient's address to
 * Google under our key, which is why it is behind its own switch on the web
 * and is not here at all.
 *
 * SINCE 7.5 A STOP CAN BE WORKED FROM HERE. Arrive, hand over against a
 * signature, or record that it could not be delivered, all through the
 * offline queue. It arrived in one piece rather than a button at a time,
 * because a courier who can mark a delivery but cannot sign for it has broken
 * the chain this contract rests on.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { ScreenHeader } from '../ui/Screen';
import { theme } from '../theme';
import { get, type MyRun, type Project, type Stop as StopRow } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { Stop } from './Stop';
import { CardButton, Chip, Ground, Notice, Panel, Sheet } from '../ui/Glass';
import { Pager, usePaged } from '../ui/Pager';
import { summarise } from '../lib/refusals';
import { TopBar } from '../ui/Nav';
import { NavigateIcon, PinIcon } from '../ui/Icons';
import { pendingLabel, type OutboxState } from '../lib/outbox';
import { dismissRejections, flush, readQueue } from '../lib/queue';

interface Props {
    token: string;
    project: Project;
    onSignedOut: () => void;
    onBack: () => void;
}

const DONE = ['delivered', 'failed', 'cancelled'];

/** Address only. See the header: the name must not leave the app. */
function openDirections(stop: Pick<StopRow, 'address' | 'city' | 'zip'>): void {
    const query = [stop.address, stop.city, stop.zip].map((p) => p.trim()).filter(Boolean).join(', ');
    if (query === '') return;
    /* geo: on Android, the Apple Maps scheme on iOS, and both fall back to
       whatever the device has set as its maps app. Nothing is drawn here, so
       nothing is requested from a third party by us. */
    const url = Platform.OS === 'ios'
        ? `http://maps.apple.com/?q=${encodeURIComponent(query)}`
        : `geo:0,0?q=${encodeURIComponent(query)}`;
    void Linking.openURL(url).catch(() => undefined);
}

/** In the project's zone, never the phone's.
 *
 *  The web shell learned this the hard way in ticket 5.5 and again in 5.11: a
 *  deadline rendered in whatever timezone the device happens to be set to is
 *  a courier told the wrong time. */
function clock(iso: string | null, timeZone: string): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
    } catch {
        return '';
    }
}

export function Run({ token, project, onSignedOut, onBack }: Props) {
    const [data, setData] = useState<MyRun | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    /* Which run we are collecting for. Null when not collecting. */
    const [working, setWorking] = useState<StopRow | null>(null);
    const [outbox, setOutbox] = useState<OutboxState | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setData(await get<MyRun>(`/api/projects/${project.code}/uh/runs/mine`, token));
            /* Every visit is a chance to drain what a basement swallowed. */
            setOutbox(await flush());
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            /* A courier is often somewhere with no signal. Say that, rather
               than showing an empty run, which reads as "no work today". */
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch. Check your signal and try again.');
        }
    }, [project.code, token, onSignedOut]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => { void readQueue().then(setOutbox); }, []);

    const refresh = async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    };

    /* Open a delivery by id, after something has just created it.
     *
     * One caller: a driver who got back to a door, asked for a second
     * attempt, and should land on it rather than on a list they have to
     * hunt through for a row that was not there a moment ago.
     *
     * It fetches rather than reading `data`, because `data` is whatever
     * was loaded before the second attempt existed. If the new stop cannot
     * be found -- the run was closed under them, the server put it
     * somewhere else -- it falls back to the list, which is refreshed by
     * then and has it. Never leaves them on the old stop: that one is
     * finished, and looking at it is how the same delivery gets recorded
     * twice. */
    const openOrder = async (orderId: number) => {
        try {
            const fresh = await get<MyRun>(`/api/projects/${project.code}/uh/runs/mine`, token);
            setData(fresh);
            const found = fresh.runs.flatMap((r) => r.stops).find((st) => st.orderId === orderId);
            setWorking(found ?? null);
        } catch {
            setWorking(null);
            void load();
        }
    };

    /* ─────────────────────────────────────────────────────────────────────
     * EVERY HOOK ABOVE EVERY EARLY RETURN, AND usePaged IS A HOOK.
     *
     * usePaged holds the page number in useState (ui/Pager.tsx), and it used
     * to be called further down, below the three returns for loading, Collect
     * and Stop. So the first render -- data null, spinner, return -- ran nine
     * hooks, and the render after the run arrived ran ten.
     *
     * React counts them. "Rendered more hooks than during the previous
     * render" is thrown, the screen goes white, and it happens to every
     * courier on every shift the moment their run loads: the main screen of
     * the app, in the signed release build. Found on an emulator reading
     * logcat, because the failure leaves a blank screen and no message on the
     * phone itself.
     *
     * `stops` is computed here for the same reason -- usePaged takes it, so
     * it cannot wait until after the returns either. It reads from `data`
     * with a null guard, which is exactly what it did below.
     * ───────────────────────────────────────────────────────────────────── */
    const stops: StopRow[] = data?.runs.flatMap((r) => r.stops) ?? [];
    /* "All stops" only. The NEXT stop is rendered above this on its own and
       the header says "x of y done" on every page, so the two numbers a
       driver plans their afternoon from are never the ones that got paged. */
    const paged = usePaged(stops);

    if (data === null && error === null) {
        return <View style={styles.centre}><ActivityIndicator color={theme.green} /></View>;
    }

    if (working !== null) {
        return (
            <Stop
                token={token}
                code={project.code}
                stop={working}
                onDone={() => { setWorking(null); void load(); }}
                onBack={() => setWorking(null)}
                onOpenOrder={(orderId) => { void openOrder(orderId); }}
            />
        );
    }

    const remaining = stops.filter((s) => !DONE.includes(s.status));
    const next = remaining.find((s) => s.status !== 'assigned') ?? remaining[0] ?? null;
    const done = stops.length - remaining.length;
    const zone = data?.timezone ?? project.timezone;
    /* One problem rather than six identical alerts on a phone screen. */
    const refused = summarise(outbox?.rejected ?? []);

    /* NO COLLECT GATE. The round used to be replaced by "go and collect"
       until custody was recorded, matching the web -- and it still matches
       the web, which dropped the gate on 3 November when drivers stopped
       recording collections at all. The server writes the custody event
       itself now, so there is nothing for a courier to do at a counter and
       nothing to wait for before showing them their stops. */

    return (
        <Ground>
        {/* ─────────────────────────────────────────────────────────────
            THE UPPER REGION. In a rideshare app this is the map. Here it is
            what is happening, because there is nothing to draw: no order in
            this system has coordinates, and getting them for a delivery
            address means sending a patient's address to a map provider,
            which ticket 1.4 refused until a BAA covers it.

            The region is full size so a map drops in rather than forcing a
            redesign. What fills it until then is what a map would have told
            them anyway: where they are up to, what is next, how long it has.
            ───────────────────────────────────────────────────────────── */}
        <View style={styles.context}>
            <TopBar backLabel="Contracts" onBack={onBack} onSignOut={onSignedOut} />

            <ScreenHeader
                title="Today"
                subtitle={data === null ? undefined : `${data.serviceDate} · ${done} of ${stops.length} done`}
            />

            {next !== null && (
                <Panel style={styles.nextPanel}>
                    <Text style={styles.nextLabel}>Next: stop {next.sequence}</Text>
                    <Text style={styles.nextName}>{next.recipientName}</Text>
                    <Text style={styles.nextAddress}>{next.address}</Text>
                    <Text style={styles.nextAddress}>{next.city} {next.zip}</Text>
                    <View style={styles.chips}>
                        <Chip label={next.serviceType.toUpperCase()} />
                        <Chip label={'due ' + clock(next.dueAt, zone)} tone="warn" />
                        <Chip label={next.zone === null ? 'out of area' : 'zone ' + next.zone} />
                    </View>
                </Panel>
            )}

            {data !== null && stops.length === 0 && (
                <Panel style={styles.nextPanel}>
                    <Text style={styles.nextAddress}>No stops assigned to you today.</Text>
                </Panel>
            )}
        </View>

        {/* ─────────────────────────────────────────────────────────────
            THE SHEET. Everything a courier can DO, under the thumb, in the
            half of the screen a hand already covers.
            ───────────────────────────────────────────────────────────── */}
        <Sheet style={styles.sheet}>
            <ScrollView
                contentContainerStyle={styles.sheetInner}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} />}
            >
                {/* Above the actions, not tucked under them. A courier who
                    cannot tell "sent" from "on this phone" will assume sent. */}
                {outbox !== null && outbox.queue.length > 0 && (
                    <Notice text={pendingLabel(outbox)} tone="info" />
                )}
                {/* Refusals, in words a driver can act on, and dismissible.
                    Before this they were the server's own sentence about a
                    state machine, repeated once per refusal, with no way to
                    clear them: see lib/refusals.ts. */}
                {refused !== null && (
                    <View style={styles.refusal}>
                        <Notice text={refused.headline + '. ' + refused.refusal.text} tone="bad" />
                        <CardButton
                            title="I have read this"
                            detail="Clears the message. Anything still waiting to send is kept."
                            tone="quiet"
                            onPress={() => { void dismissRejections().then(setOutbox); }}
                        />
                    </View>
                )}
                {error !== null && <Notice text={error} tone="bad" />}

                {next !== null && (
                    <>
                        <CardButton
                            title="Open the stop"
                            Icon={PinIcon}
                            detail={'Stop ' + next.sequence + ' for ' + next.recipientName}
                            tone="primary"
                            onPress={() => setWorking(next)}
                        />
                        <CardButton
                            title="Directions"
                            Icon={NavigateIcon}
                            detail="Opens your own maps app with the address only"
                            tone="quiet"
                            onPress={() => openDirections(next)}
                        />
                    </>
                )}

                {stops.length > 0 && (
                    <View style={styles.allStops}>
                        <Text style={styles.cardTitle}>All stops</Text>
                        {/* A FINISHED STOP OPENS. It used to be greyed out
                            and `disabled`, so a tap did nothing at all.
                            Two things happen often enough that the gate
                            cost more than it protected: a photograph of
                            the signed form that came out blurred, and a
                            dry run where the patient rang the pharmacy
                            back and the driver got there again an hour
                            later. Both were a telephone call to dispatch,
                            or went unrecorded.

                            It still LOOKS finished -- same grey -- because
                            that is what it is. What it no longer does is
                            refuse to say so. See Stop.tsx, which opens
                            read-only for these and offers exactly two
                            things: a better photograph, and a second
                            attempt. */}
                        {paged.rows.map((s) => (
                            <Pressable
                                key={s.orderId}
                                style={[styles.stop, DONE.includes(s.status) ? styles.stopDone : null]}
                                onPress={() => setWorking(s)}
                                accessibilityRole="button"
                            >
                                <Text style={styles.stopName}>{s.sequence}. {s.recipientName}</Text>
                                <Text style={styles.meta}>{s.address}, {s.city} {s.zip}</Text>
                                <Text style={styles.meta}>
                                    due {clock(s.dueAt, zone)} · {s.status}
                                    {s.zone === null ? ' · out of area' : ' · zone ' + s.zone}
                                </Text>
                            </Pressable>
                        ))}
                        <Pager of={paged} noun="stops" />
                    </View>
                )}

                <Text style={styles.footnote}>
                    Handing undelivered packages back is still on the web app.
                </Text>
            </ScrollView>
        </Sheet>
        </Ground>
    );
}

const styles = StyleSheet.create({
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    /* The upper region: the rideshare map slot, holding status until there
       is something to draw. Roughly the top third, so the sheet below keeps
       the actions inside thumb reach. */
    context: { paddingHorizontal: 22, paddingTop: 56, paddingBottom: 16 },
    backTap: { minHeight: 44, justifyContent: 'center' },
    back: { color: theme.greenBright, fontSize: 16, fontWeight: '600' },

    nextPanel: { marginTop: 16 },
    nextLabel: { fontSize: 15, color: theme.muted, letterSpacing: 0.6 },
    nextName: { fontSize: 24, fontWeight: '700', color: theme.ink, marginTop: 6 },
    nextAddress: { fontSize: 17, color: theme.ink, lineHeight: 25 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },

    /* The sheet. flex: 1 so it owns the rest of the screen and scrolls
       within itself rather than pushing the status region off the top. */
    sheet: { flex: 1 },
    sheetInner: { paddingBottom: 30 },

    allStops: { marginTop: 22 },
    cardTitle: { fontSize: 20, fontWeight: '700', color: theme.ink, marginBottom: 10 },
    meta: { fontSize: 15, color: theme.muted, marginTop: 4, lineHeight: 21 },
    stop: {
        borderTopWidth: 1,
        borderTopColor: 'rgba(17,24,39,0.08)',
        paddingVertical: 14,
        /* Above the platform minimum even in the densest list. */
        minHeight: 48,
        justifyContent: 'center',
    },
    stopDone: { opacity: 0.45 },
    stopName: { fontSize: 17, color: theme.ink, fontWeight: '600' },

    refusal: { marginBottom: 18 },
    footnote: { fontSize: 15, color: theme.muted, lineHeight: 21, marginTop: 18, paddingHorizontal: 2 },
});
