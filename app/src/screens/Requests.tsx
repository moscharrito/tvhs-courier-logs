/* What I asked for, and what came back (ticket 7.3).
 *
 * The other half of the pull model. A courier asks on the board; this is
 * where they find out.
 *
 * SUPERSEDED IS NOT DENIED, and this screen is the reason the server bothered
 * to keep them apart. Somebody asked for something reasonable and another
 * driver got there first. Reading "denied" for that twice is how a courier
 * stops asking for work, and then the pull model quietly becomes a push model
 * with extra steps.
 *
 * It also shows what dispatch has been telling them, from the notification
 * outbox in ticket 6.8. There is no push channel configured yet, so a phone
 * gets nothing: these are read here, in the app, which is the honest state
 * and a complete feature on its own.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import { markRead, myNotifications, myRequests, withdrawRequest, type MyRequest, type Notification } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { countdown, openFirst, requestOutcome, whereLabel } from '../lib/work';

interface Props {
    token: string;
    code: string;
    onSignedOut: () => void;
}

export function Requests({ token, code, onSignedOut }: Props) {
    const [requests, setRequests] = useState<MyRequest[] | null>(null);
    const [notes, setNotes] = useState<Notification[]>([]);
    const [unread, setUnread] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState<number | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const [r, n] = await Promise.all([myRequests(token, code), myNotifications(token, code)]);
            setRequests(r.requests);
            setNotes(n.notifications.slice(0, 12));
            setUnread(n.unread);
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch.');
        }
    }, [token, code, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    const take = async (id: number) => {
        setBusy(id);
        setError(null);
        try {
            await withdrawRequest(token, code, id);
            await load();
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'That did not work.');
        } finally {
            setBusy(null);
        }
    };

    const clear = async () => {
        try {
            await markRead(token, code);
            await load();
        } catch {
            /* Marking things read is not worth an error message. */
        }
    };

    if (requests === null && error === null) {
        return <View style={styles.centre}><ActivityIndicator color={theme.green} /></View>;
    }

    const now = Date.now();
    const rows = openFirst(requests ?? []);

    return (
        <ScrollView
            style={styles.wrap}
            contentContainerStyle={styles.inner}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
                setRefreshing(true);
                void load().finally(() => setRefreshing(false));
            }} />}
        >
            <Text style={styles.title}>What I asked for</Text>

            {error !== null && (
                <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text></View>
            )}

            {notes.length > 0 && (
                <View style={styles.card}>
                    <View style={styles.row}>
                        <Text style={styles.cardTitle}>From dispatch{unread > 0 ? ` · ${unread} new` : ''}</Text>
                        {unread > 0 && (
                            <Pressable onPress={() => { void clear(); }} accessibilityRole="button">
                                <Text style={styles.link}>Mark read</Text>
                            </Pressable>
                        )}
                    </View>
                    {notes.map((n) => (
                        <View key={n.id} style={[styles.note, n.readAt === null ? styles.noteUnread : null]}>
                            <Text style={styles.noteText}>{n.body}</Text>
                        </View>
                    ))}
                </View>
            )}

            {rows.length === 0 && (
                <View style={styles.card}>
                    <Text style={styles.cardBody}>
                        You have not asked for anything yet. Work going is on the other tab.
                    </Text>
                </View>
            )}

            {rows.map((r) => {
                const left = countdown(r.dueAt, now);
                return (
                    <View key={r.id} style={styles.card}>
                        <View style={styles.row}>
                            <Text style={styles.where}>{whereLabel(r)}</Text>
                            <Text style={[styles.left, left.urgent ? styles.leftUrgent : null]}>{left.text}</Text>
                        </View>
                        <Text style={styles.meta}>{r.serviceType}</Text>
                        <Text style={[styles.outcome, r.status === 'approved' ? styles.outcomeGood : null]}>
                            {requestOutcome(r.status, r.decisionReason)}
                        </Text>

                        {r.status === 'pending' && (
                            <Pressable
                                style={styles.take}
                                onPress={() => { void take(r.id); }}
                                disabled={busy === r.id}
                                accessibilityRole="button"
                            >
                                {busy === r.id
                                    ? <ActivityIndicator color={theme.muted} />
                                    : <Text style={styles.takeText}>Never mind</Text>}
                            </Pressable>
                        )}
                    </View>
                );
            })}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: 'transparent' },
    inner: { padding: 16, paddingTop: 56, paddingBottom: 32 },
    centre: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: 26, fontWeight: '700', color: theme.ink, marginBottom: 14 },
    card: {
        backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
        borderRadius: 22, padding: 16, marginBottom: 10,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
    cardTitle: { fontSize: 16, fontWeight: '600', color: theme.ink },
    cardBody: { fontSize: 16, color: theme.muted, lineHeight: 21 },
    link: { color: theme.green, fontSize: 16 },
    note: { borderTopWidth: 1, borderTopColor: 'rgba(17,24,39,0.08)', paddingVertical: 10, marginTop: 4 },
    noteUnread: { borderLeftWidth: 3, borderLeftColor: theme.greenBright, paddingLeft: 10 },
    noteText: { fontSize: 16, color: theme.ink, lineHeight: 20 },
    where: { fontSize: 17, fontWeight: '600', color: theme.ink, flex: 1 },
    left: { fontSize: 16, color: theme.muted },
    leftUrgent: { color: theme.danger, fontWeight: '600' },
    meta: { fontSize: 15, color: theme.muted, marginTop: 6 },
    outcome: { fontSize: 16, color: theme.ink, marginTop: 10, lineHeight: 21 },
    outcomeGood: { color: theme.green, fontWeight: '600' },
    take: { alignSelf: 'flex-start', marginTop: 12, paddingVertical: 8 },
    takeText: { color: theme.muted, fontSize: 16 },
    error: { backgroundColor: 'rgba(185,28,28,0.1)', borderRadius: 18, padding: 14, marginBottom: 10 },
    errorText: { color: theme.danger, fontSize: 16, lineHeight: 21 },
});
