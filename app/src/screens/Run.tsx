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
 * WHAT IT DELIBERATELY DOES NOT DO YET: collect, deliver, fail a stop, or
 * capture a signature. Those are 7.3 and 7.5, and they arrive together,
 * because half a custody flow on a phone is worse than none. A courier who
 * can mark a delivery but cannot sign for it has broken the chain this whole
 * contract rests on, and the screen says so out loud rather than leaving
 * somebody to hunt for a button that is not there.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { theme } from '../theme';
import { get, type MyRun, type Project, type Stop } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';

interface Props {
    token: string;
    project: Project;
    onSignedOut: () => void;
    onBack: () => void;
}

const DONE = ['delivered', 'failed', 'cancelled'];

/** Address only. See the header: the name must not leave the app. */
function openDirections(stop: Pick<Stop, 'address' | 'city' | 'zip'>): void {
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

    const load = useCallback(async () => {
        setError(null);
        try {
            setData(await get<MyRun>(`/api/projects/${project.code}/uh/runs/mine`, token));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            /* A courier is often somewhere with no signal. Say that, rather
               than showing an empty run, which reads as "no work today". */
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch. Check your signal and try again.');
        }
    }, [project.code, token, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    const refresh = async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    };

    if (data === null && error === null) {
        return <View style={styles.centre}><ActivityIndicator color={theme.green} /></View>;
    }

    const stops: Stop[] = data?.runs.flatMap((r) => r.stops) ?? [];
    const remaining = stops.filter((s) => !DONE.includes(s.status));
    const next = remaining.find((s) => s.status !== 'assigned') ?? remaining[0] ?? null;
    const done = stops.length - remaining.length;
    const zone = data?.timezone ?? project.timezone;

    return (
        <ScrollView
            style={styles.wrap}
            contentContainerStyle={styles.inner}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} />}
        >
            <Pressable onPress={onBack} accessibilityRole="button">
                <Text style={styles.back}>Contracts</Text>
            </Pressable>
            <Text style={styles.title}>Today</Text>
            {data !== null && <Text style={styles.sub}>{data.serviceDate} · {done} of {stops.length} done</Text>}

            {error !== null && (
                <View style={styles.error} accessibilityRole="alert">
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            )}

            {data !== null && stops.length === 0 && (
                <View style={styles.card}><Text style={styles.cardBody}>No stops assigned to you today.</Text></View>
            )}

            {next !== null && (
                <View style={[styles.card, styles.nextCard]} accessibilityLabel="Next stop">
                    <Text style={styles.nextLabel}>Next: stop {next.sequence}</Text>
                    <Text style={styles.nextName}>{next.recipientName}</Text>
                    <Text style={styles.nextAddress}>{next.address}</Text>
                    <Text style={styles.nextAddress}>{next.city} {next.zip}</Text>
                    <Text style={styles.meta}>
                        {next.serviceType} · due {clock(next.dueAt, zone)}
                        {next.zone === null ? ' · out of area' : ` · zone ${next.zone}`}
                    </Text>
                    <Pressable
                        style={styles.directions}
                        onPress={() => openDirections(next)}
                        accessibilityRole="button"
                    >
                        <Text style={styles.directionsText}>Directions</Text>
                    </Pressable>
                </View>
            )}

            {stops.length > 0 && (
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>All stops</Text>
                    {stops.map((s) => (
                        <View key={s.orderId} style={[styles.stop, DONE.includes(s.status) ? styles.stopDone : null]}>
                            <Text style={styles.stopName}>{s.sequence}. {s.recipientName}</Text>
                            <Text style={styles.meta}>{s.address}, {s.city} {s.zip}</Text>
                            <Text style={styles.meta}>
                                due {clock(s.dueAt, zone)} · {s.status}
                                {s.zone === null ? ' · out of area' : ` · zone ${s.zone}`}
                            </Text>
                        </View>
                    ))}
                </View>
            )}

            <Text style={styles.footnote}>
                Collecting, delivering and signing are still on the web app. They arrive here together, because
                half a custody flow is worse than none.
            </Text>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.bg },
    inner: { padding: 16, paddingTop: 56, paddingBottom: 40 },
    centre: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
    back: { color: theme.green, fontSize: 15, marginBottom: 10 },
    title: { fontSize: 26, fontWeight: '700', color: theme.ink },
    sub: { fontSize: 14, color: theme.muted, marginBottom: 16 },
    card: {
        backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line,
        borderRadius: 12, padding: 16, marginBottom: 12,
    },
    nextCard: { borderColor: theme.green, borderWidth: 2 },
    nextLabel: { fontSize: 13, color: theme.muted, letterSpacing: 0.6 },
    nextName: { fontSize: 22, fontWeight: '600', color: theme.ink, marginTop: 6 },
    nextAddress: { fontSize: 17, color: theme.ink, lineHeight: 24 },
    cardTitle: { fontSize: 16, fontWeight: '600', color: theme.ink, marginBottom: 10 },
    cardBody: { fontSize: 15, color: theme.ink },
    meta: { fontSize: 13, color: theme.muted, marginTop: 4 },
    stop: { borderTopWidth: 1, borderTopColor: theme.line, paddingVertical: 12 },
    stopDone: { opacity: 0.5 },
    stopName: { fontSize: 16, color: theme.ink, fontWeight: '500' },
    error: { backgroundColor: theme.dangerSoft, borderRadius: 10, padding: 14, marginBottom: 12 },
    errorText: { color: theme.danger, fontSize: 15, lineHeight: 21 },
    directions: {
        marginTop: 14, borderWidth: 1, borderColor: theme.green, borderRadius: 10,
        paddingVertical: 13, alignItems: 'center',
    },
    directionsText: { color: theme.green, fontSize: 16, fontWeight: '600' },
    footnote: { fontSize: 13, color: theme.muted, lineHeight: 19, marginTop: 8, paddingHorizontal: 4 },
});
