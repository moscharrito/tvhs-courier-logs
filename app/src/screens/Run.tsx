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
import { theme } from '../theme';
import { get, type MyRun, type Project, type Stop as StopRow } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { Stop } from './Stop';
import { Collect } from './Collect';
import { CardButton, Chip, Ground, Notice, Panel, Sheet } from '../ui/Glass';
import { summarise } from '../lib/refusals';
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
    const [collecting, setCollecting] = useState<number | null>(null);
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

    if (data === null && error === null) {
        return <View style={styles.centre}><ActivityIndicator color={theme.green} /></View>;
    }

    if (collecting !== null) {
        return (
            <Collect
                token={token}
                code={project.code}
                runId={collecting}
                onDone={() => { setCollecting(null); void load(); void readQueue().then(setOutbox); }}
                onCancel={() => setCollecting(null)}
                onSignedOut={onSignedOut}
            />
        );
    }

    if (working !== null) {
        return (
            <Stop
                token={token}
                code={project.code}
                stop={working}
                onDone={() => { setWorking(null); void load(); }}
                onBack={() => setWorking(null)}
            />
        );
    }

    const stops: StopRow[] = data?.runs.flatMap((r) => r.stops) ?? [];
    const remaining = stops.filter((s) => !DONE.includes(s.status));
    const next = remaining.find((s) => s.status !== 'assigned') ?? remaining[0] ?? null;
    const done = stops.length - remaining.length;
    const zone = data?.timezone ?? project.timezone;
    /* Anything still to be collected lives on a run, and a courier with two
       runs in a day (a second wave) collects against the current one. */
    const runId = data?.runs[0]?.id ?? null;
    const toCollect = stops.filter((s) => s.status === 'assigned').length;
    /* One problem rather than six identical alerts on a phone screen. */
    const refused = summarise(outbox?.rejected ?? []);

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
            <Pressable onPress={onBack} accessibilityRole="button" style={styles.backTap}>
                <Text style={styles.back}>Contracts</Text>
            </Pressable>

            <Text style={styles.title}>Today</Text>
            {data !== null && (
                <Text style={styles.sub}>{data.serviceDate} · {done} of {stops.length} done</Text>
            )}

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
                        {refused.refusal.action === 'collect' && runId !== null && (
                            <CardButton
                                title="Collect from a pharmacy"
                                detail="What these were waiting on"
                                tone="primary"
                                onPress={() => setCollecting(runId)}
                            />
                        )}
                        <CardButton
                            title="I have read this"
                            detail="Clears the message. Anything still waiting to send is kept."
                            tone="quiet"
                            onPress={() => { void dismissRejections().then(setOutbox); }}
                        />
                    </View>
                )}
                {error !== null && <Notice text={error} tone="bad" />}

                {/* The gap found on the first day anybody held this app:
                    collection was web-only, so a driver could not do a whole
                    day on the phone. */}
                {runId !== null && (
                    <CardButton
                        title="Collect from a pharmacy"
                        detail={toCollect > 0
                            ? toCollect + (toCollect === 1 ? ' order is' : ' orders are') + ' waiting to be picked up'
                            : 'Nothing is waiting to be picked up right now'}
                        tone={toCollect > 0 ? 'primary' : 'secondary'}
                        onPress={() => setCollecting(runId)}
                    />
                )}

                {next !== null && (
                    <>
                        <CardButton
                            title="Open the stop"
                            detail={'Stop ' + next.sequence + ' for ' + next.recipientName}
                            tone={toCollect > 0 ? 'secondary' : 'primary'}
                            onPress={() => setWorking(next)}
                        />
                        <CardButton
                            title="Directions"
                            detail="Opens your own maps app with the address only"
                            tone="quiet"
                            onPress={() => openDirections(next)}
                        />
                    </>
                )}

                {stops.length > 0 && (
                    <View style={styles.allStops}>
                        <Text style={styles.cardTitle}>All stops</Text>
                        {stops.map((s) => (
                            <Pressable
                                key={s.orderId}
                                style={[styles.stop, DONE.includes(s.status) ? styles.stopDone : null]}
                                onPress={() => { if (!DONE.includes(s.status)) setWorking(s); }}
                                disabled={DONE.includes(s.status)}
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
    title: { fontSize: 32, fontWeight: '800', color: theme.ink, marginTop: 4 },
    sub: { fontSize: 16, color: theme.muted, marginTop: 4 },

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
