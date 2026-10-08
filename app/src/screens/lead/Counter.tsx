/* The pile on the counter, sorted the way it gets sorted by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS NOT A STOP LIST.
 *
 * A driver's screen is a sequence: this one, then that one. A lead's screen
 * is a pile and a question — which of these go together, and who takes them.
 * So this groups by zone rather than ordering by time, because a lead sorting
 * physically puts the far ones in one stack so that one van takes the long
 * leg. See lib/lead.ts, which holds the ordering and is tested.
 *
 * NO PATIENT ADDRESS ON THE LIST. A name and a ZIP are enough to match a
 * package to a label on a counter, and a lead holding forty packages does not
 * need forty street addresses on a screen somebody could be standing behind.
 * The driver gets the address when it is theirs to deliver.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../../theme';
import { Panel, Chip, Notice } from '../../ui/Glass';
import { ScreenHeader } from '../../ui/Screen';
import { get } from '../../lib/api';
import { batchesByZone, lostCards, type BoardData, type ZoneBatch } from '../../lib/lead';

interface Props {
    token: string;
    code: string;
    onSignedOut: () => void;
    /** Opens the people tab with this batch held, which is the handover. */
    onHandOver: (batch: ZoneBatch) => void;
}

export function Counter({ token, code, onSignedOut, onHandOver }: Props) {
    const [board, setBoard] = useState<BoardData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        try {
            setBoard(await get<BoardData>(`/api/projects/${code}/uh/board`, token));
            setError(null);
        } catch (err) {
            if ((err as { status?: number }).status === 401) { onSignedOut(); return; }
            setError('Could not load the counter. Pull down to try again.');
        } finally {
            setBusy(false);
        }
    }, [code, token, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    if (board === null) {
        return (
            <View style={styles.centre}>
                {error === null ? <ActivityIndicator /> : <Notice text={error} tone="bad" />}
            </View>
        );
    }

    const batches = batchesByZone(board);
    const waiting = batches.reduce((n, b) => n + b.orders.length, 0);
    /* Packages the board referenced and sent no card for. Normally zero: this
       app asks for the whole board every time rather than a delta. Shown
       rather than swallowed, because a counter that is quietly short by three
       packages is worse than one that says so. */
    const lost = lostCards(board);

    return (
        <ScrollView
            contentContainerStyle={styles.body}
            refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} />}
        >
            <ScreenHeader
                title="Counter"
                /* summary is read defensively for the same reason the pool is:
                   a payload that changed shape must not take the whole screen
                   with it. A missing count is a missing word in a subtitle. */
                subtitle={`${waiting === 0 ? 'Nothing waiting' : `${waiting} waiting to go out`}`
                    + `${(board.summary?.overdue ?? 0) > 0 ? ` · ${board.summary.overdue} late` : ''}`}
            />

            {error !== null && <Notice text={error} tone="warn" />}

            {lost > 0 && (
                <Notice
                    tone="warn"
                    text={`${lost} ${lost === 1 ? 'package is' : 'packages are'} on the counter that this `
                        + 'screen could not read. Pull down to refresh, and tell dispatch if it stays.'}
                />
            )}

            {batches.length === 0 ? (
                <Panel>
                    <Text style={styles.empty}>
                        Everything on the counter has been handed over. New packages appear here when
                        dispatch loads the list.
                    </Text>
                </Panel>
            ) : batches.map((batch) => (
                <Panel key={batch.label} style={styles.batch}>
                    <View style={styles.batchHead}>
                        <Text style={styles.batchTitle}>{batch.label}</Text>
                        <View style={styles.chips}>
                            <Chip label={`${batch.orders.length}`} tone="neutral" />
                            {batch.overdue > 0 && <Chip label={`${batch.overdue} late`} tone="bad" />}
                        </View>
                    </View>

                    {batch.orders.map((o) => (
                        <View key={o.id} style={styles.row}>
                            <Text style={styles.name} numberOfLines={1}>{o.recipientName}</Text>
                            <Text style={styles.meta}>
                                {`${o.externalRef ?? `#${o.id}`} · ${o.zip}${o.serviceType === 'stat' ? '  STAT' : ''}`}
                            </Text>
                        </View>
                    ))}

                    <HandOverButton batch={batch} onPress={() => onHandOver(batch)} />
                </Panel>
            ))}
        </ScrollView>
    );
}

/** Separate so the label can say the thing rather than say "Continue". */
function HandOverButton({ batch, onPress }: { batch: ZoneBatch; onPress: () => void }) {
    return (
        <Text
            accessibilityRole="button"
            accessibilityHint={`Choose a driver for the ${batch.label} packages`}
            onPress={onPress}
            style={styles.handOver}
        >
            Hand over {batch.orders.length} {batch.orders.length === 1 ? 'package' : 'packages'}
        </Text>
    );
}

const styles = StyleSheet.create({
    body: { padding: 16, paddingBottom: 120, gap: 12 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    batch: { gap: 8 },
    batchHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    batchTitle: { fontSize: 18, fontWeight: '600', color: theme.ink },
    chips: { flexDirection: 'row', gap: 6 },
    row: { paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
    name: { fontSize: 16, color: theme.ink },
    meta: { fontSize: 13, color: theme.muted },
    empty: { fontSize: 15, color: theme.muted, lineHeight: 22 },
    handOver: {
        marginTop: 8, textAlign: 'center', paddingVertical: 12,
        borderRadius: 10, overflow: 'hidden',
        backgroundColor: theme.green, color: '#fff', fontSize: 16, fontWeight: '600',
    },
});
