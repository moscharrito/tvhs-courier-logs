/* The board, in hand (ticket 7.3).
 *
 * What a courier can ask for, and asking for it. The DoorDash half of the
 * model: dispatch puts the day's deliveries up, drivers pick the ones they
 * want, dispatch says yes or no.
 *
 * WHAT IS NOT ON THIS SCREEN IS THE POINT. There is no patient name and no
 * street address anywhere in it, because the server does not send them. A
 * courier choosing between stops needs the ZIP, the zone, the deadline and
 * how many packages; who lives there is none of their business until the
 * delivery is actually theirs. Twenty drivers browsing forty deliveries is
 * exactly where minimum-necessary would have quietly died, so the decision
 * sits on the server and this screen could not leak it if it tried.
 *
 * ASKING IS NOT GETTING, and the screen says so. Tapping Ask creates a
 * request; dispatch approves it; only then does it appear on the run. A
 * screen that moved a card into "yours" on tap would be lying for as long as
 * it took somebody to look.
 *
 * ON SHIFT TO ASK. A request from somebody who is not working is one dispatch
 * cannot honour, so the shift control is on this screen rather than buried:
 * it is the first thing that has to be true.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import { askFor, availableWork, endShift, myShift, startShift, type AvailableWork, type ShiftState } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { byUrgency, countdown, selectionState, toggle, whereLabel } from '../lib/work';

interface Props {
    token: string;
    code: string;
    onSignedOut: () => void;
}

export function Board({ token, code, onSignedOut }: Props) {
    const [work, setWork] = useState<AvailableWork | null>(null);
    const [shift, setShift] = useState<ShiftState | null>(null);
    const [selected, setSelected] = useState<number[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async () => {
        setError(null);
        try {
            const [w, s] = await Promise.all([availableWork(token, code), myShift(token, code)]);
            setWork(w);
            setShift(s);
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch. Check your signal.');
        }
    }, [token, code, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    const onShift = shift?.shift !== null && shift?.shift !== undefined;
    const state = selectionState(selected, onShift);

    const toggleShift = async () => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            if (onShift) await endShift(token, code); else await startShift(token, code);
            await load();
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            /* The one refusal worth showing in full: a courier cannot go off
               shift while there are packages in their van, and the server
               says how many and what to do about it. */
            setError(err instanceof ApiError ? err.message : 'That did not work.');
        } finally {
            setBusy(false);
        }
    };

    const ask = async () => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const res = await askFor(token, code, selected);
            setSelected([]);
            setNote(
                res.refused.length === 0
                    ? `Asked for ${res.requested.length}. Dispatch will say.`
                    : `Asked for ${res.requested.length}. ${res.refused.length} had already gone.`,
            );
            await load();
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'That did not send.');
        } finally {
            setBusy(false);
        }
    };

    if (work === null && error === null) {
        return <View style={styles.centre}><ActivityIndicator color={theme.green} /></View>;
    }

    const now = Date.now();
    const rows = byUrgency(work?.available ?? []);

    return (
        <View style={styles.wrap}>
            <ScrollView
                contentContainerStyle={styles.inner}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
                    setRefreshing(true);
                    void load().finally(() => setRefreshing(false));
                }} />}
            >
                <Text style={styles.title}>Work going</Text>
                {work !== null && <Text style={styles.sub}>{work.serviceDate} · {rows.length} available</Text>}

                <Pressable
                    style={[styles.shift, onShift ? styles.shiftOn : null]}
                    onPress={() => { void toggleShift(); }}
                    disabled={busy}
                    accessibilityRole="button"
                >
                    <Text style={[styles.shiftText, onShift ? styles.shiftTextOn : null]}>
                        {onShift ? 'On shift. Tap to finish' : 'Go on shift'}
                    </Text>
                </Pressable>

                {shift !== null && shift.carrying.length > 0 && (
                    <Text style={styles.carrying}>
                        {shift.carrying.length} {shift.carrying.length === 1 ? 'package is' : 'packages are'} still with you.
                    </Text>
                )}

                {error !== null && (
                    <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text></View>
                )}
                {note !== null && (
                    /* Not accessibilityRole="status": that is a web ARIA role
                       and React Native does not have it. A live region is the
                       platform's own way of saying "read this when it
                       changes". */
                    <View style={styles.note} accessibilityLiveRegion="polite">
                        <Text style={styles.noteText}>{note}</Text>
                    </View>
                )}

                {rows.length === 0 && (
                    <View style={styles.card}>
                        <Text style={styles.cardBody}>Nothing unclaimed right now. Pull down to look again.</Text>
                    </View>
                )}

                {rows.map((item) => {
                    const left = countdown(item.dueAt, now);
                    const picked = selected.includes(item.orderId);
                    return (
                        <Pressable
                            key={item.orderId}
                            style={[styles.card, picked ? styles.cardPicked : null, item.requested ? styles.cardAsked : null]}
                            onPress={() => { if (!item.requested) setSelected((s) => toggle(s, item.orderId)); }}
                            disabled={item.requested}
                            accessibilityRole="button"
                            accessibilityState={{ selected: picked }}
                        >
                            <View style={styles.row}>
                                <Text style={styles.where}>{whereLabel(item)}</Text>
                                <Text style={[styles.left, left.urgent ? styles.leftUrgent : null]}>{left.text}</Text>
                            </View>
                            <Text style={styles.meta}>
                                {item.serviceType} · {item.packages} {item.packages === 1 ? 'package' : 'packages'}
                                {item.pickUpFrom !== null ? ` · from ${item.pickUpFrom}` : ''}
                            </Text>
                            {item.requested && <Text style={styles.asked}>Asked for. Waiting on dispatch.</Text>}
                        </Pressable>
                    );
                })}

                <Text style={styles.footnote}>
                    Asking is not getting. Dispatch decides, and it turns up on your run when they say yes.
                </Text>
            </ScrollView>

            <View style={styles.bar}>
                {state.why !== '' && <Text style={styles.barWhy}>{state.why}</Text>}
                <Pressable
                    style={[styles.ask, !state.canAsk || busy ? styles.askOff : null]}
                    onPress={() => { void ask(); }}
                    disabled={!state.canAsk || busy}
                    accessibilityRole="button"
                >
                    {busy
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={styles.askText}>{state.count > 0 ? `Ask for ${state.count}` : 'Ask'}</Text>}
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.bg },
    inner: { padding: 16, paddingTop: 56, paddingBottom: 24 },
    centre: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: 26, fontWeight: '700', color: theme.ink },
    sub: { fontSize: 14, color: theme.muted, marginBottom: 14 },
    shift: {
        borderWidth: 1, borderColor: theme.green, borderRadius: 10,
        paddingVertical: 14, alignItems: 'center', marginBottom: 14,
    },
    shiftOn: { backgroundColor: theme.greenSoft },
    shiftText: { color: theme.green, fontSize: 16, fontWeight: '600' },
    shiftTextOn: { color: theme.green },
    carrying: { fontSize: 13, color: theme.muted, marginBottom: 12, paddingHorizontal: 4 },
    card: {
        backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line,
        borderRadius: 12, padding: 16, marginBottom: 10,
    },
    cardPicked: { borderColor: theme.green, borderWidth: 2, backgroundColor: theme.greenSoft },
    cardAsked: { opacity: 0.6 },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
    where: { fontSize: 17, fontWeight: '600', color: theme.ink, flex: 1 },
    left: { fontSize: 14, color: theme.muted },
    leftUrgent: { color: theme.danger, fontWeight: '600' },
    meta: { fontSize: 13, color: theme.muted, marginTop: 6 },
    asked: { fontSize: 13, color: theme.green, marginTop: 8 },
    cardBody: { fontSize: 15, color: theme.muted },
    footnote: { fontSize: 13, color: theme.muted, lineHeight: 19, marginTop: 8, paddingHorizontal: 4 },
    error: { backgroundColor: theme.dangerSoft, borderRadius: 10, padding: 14, marginBottom: 10 },
    errorText: { color: theme.danger, fontSize: 15, lineHeight: 21 },
    note: { backgroundColor: theme.greenSoft, borderRadius: 10, padding: 14, marginBottom: 10 },
    noteText: { color: theme.green, fontSize: 15 },
    bar: {
        borderTopWidth: 1, borderTopColor: theme.line, backgroundColor: theme.card,
        padding: 14, paddingBottom: 22,
    },
    barWhy: { fontSize: 13, color: theme.muted, marginBottom: 10, textAlign: 'center' },
    ask: { backgroundColor: theme.green, borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
    askOff: { opacity: 0.35 },
    askText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
