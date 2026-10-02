/* Who is standing here, and what they are already carrying.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE HANDOVER HAPPENS IN THE WORLD, NOT IN THE APP.
 *
 * A lead puts packages in somebody's hands and then records it. So this
 * screen's job is to be fast and to be right about who is actually present:
 * the ordering puts whoever is here with the least on them at the top,
 * because that is who the next batch goes to.
 *
 * IT REFUSES BEFORE THE PACKAGES MOVE. A driver with no open run cannot be
 * handed anything, and finding that out from a 409 after the packages are in
 * a van is too late. lib/lead.ts decides, and says who has to fix it: a lead
 * cannot open a run, dispatch owns routing.
 *
 * ALL OR NOTHING. A batch moves whole or not at all. The server refuses a
 * batch containing somebody else's order and names it; a partial move would
 * leave a lead believing the pile went.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../../theme';
import { Panel, Chip, Notice, CardButton, Confirm } from '../../ui/Glass';
import { get, post } from '../../lib/api';
import {
    driverLoads, presenceLabel, handoverRefusal,
    type BoardData, type DriverLoad, type ZoneBatch,
} from '../../lib/lead';

interface Props {
    token: string;
    code: string;
    onSignedOut: () => void;
    /** The batch carried over from the counter, if the lead came that way. */
    holding: ZoneBatch | null;
    onHandedOver: () => void;
}

export function Drivers({ token, code, onSignedOut, holding, onHandedOver }: Props) {
    const [board, setBoard] = useState<BoardData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState<DriverLoad | null>(null);
    const [sending, setSending] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        try {
            setBoard(await get<BoardData>(`/api/projects/${code}/uh/board`, token));
            setError(null);
        } catch (err) {
            if ((err as { status?: number }).status === 401) { onSignedOut(); return; }
            setError('Could not load the drivers. Pull down to try again.');
        } finally {
            setBusy(false);
        }
    }, [code, token, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    const handOver = async (to: DriverLoad) => {
        if (holding === null || to.runId === null) return;
        setSending(true);
        try {
            await post(`/api/projects/${code}/uh/runs/${to.runId}/stops`, token, {
                orderIds: holding.orders.map((o) => o.id),
            });
            setConfirming(null);
            onHandedOver();
            await load();
        } catch (err) {
            const status = (err as { status?: number }).status;
            if (status === 401) { onSignedOut(); return; }
            /* The server names the orders it refused. Said plainly, because a
               lead is holding the pile while they read it. */
            setError(status === 404
                ? 'Some of those packages are not from your pharmacy. Nothing was handed over.'
                : 'That did not go through. Nothing was handed over; try again.');
            setConfirming(null);
        } finally {
            setSending(false);
        }
    };

    if (board === null) {
        return (
            <View style={styles.centre}>
                {error === null ? <ActivityIndicator color={theme.green} /> : <Notice text={error} tone="bad" />}
            </View>
        );
    }

    const loads = driverLoads(board);

    return (
        <>
            <ScrollView
                contentContainerStyle={styles.body}
                refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void load()} />}
            >
                <Text style={styles.heading}>Drivers</Text>
                <Text style={styles.sub}>
                    {holding === null
                        ? `${loads.filter((d) => d.present).length} here now`
                        : `Holding ${holding.orders.length} from ${holding.label}`}
                </Text>

                {error !== null && <Notice text={error} tone="warn" />}

                {loads.length === 0 && (
                    <Panel>
                        <Text style={styles.empty}>
                            Nobody is on shift at this pharmacy today. Dispatch assigns drivers the night
                            before.
                        </Text>
                    </Panel>
                )}

                {loads.map((d) => {
                    const refusal = handoverRefusal(d);
                    return (
                        <Panel key={d.username} style={styles.driver}>
                            <View style={styles.driverHead}>
                                <Text style={styles.name}>{d.name}</Text>
                                <Chip
                                    label={presenceLabel(d)}
                                    tone={d.present ? 'good' : 'warn'}
                                />
                            </View>
                            <Text style={styles.meta}>
                                {d.carrying === 0
                                    ? 'Carrying nothing yet'
                                    : `${d.remaining} of ${d.carrying} still out`}
                                {d.overdue > 0 ? `  ·  ${d.overdue} late` : ''}
                            </Text>

                            {holding !== null && (
                                refusal === null
                                    ? (
                                        <CardButton
                                            title={`Give ${holding.orders.length} to ${d.name}`}
                                            detail={holding.label}
                                            onPress={() => setConfirming(d)}
                                            compact
                                        />
                                    )
                                    : <Notice text={refusal} tone="warn" />
                            )}
                        </Panel>
                    );
                })}
            </ScrollView>

            <Confirm
                open={confirming !== null}
                title={confirming === null ? '' : `Hand over to ${confirming.name}?`}
                body={holding === null || confirming === null ? '' : (
                    `${holding.orders.length} packages from ${holding.label} go onto ${confirming.name}'s run. `
                    + 'Do this once the packages are actually in their hands.'
                )}
                confirmLabel="Handed over"
                busy={sending}
                onConfirm={() => { if (confirming) void handOver(confirming); }}
                onCancel={() => setConfirming(null)}
            />
        </>
    );
}

const styles = StyleSheet.create({
    body: { padding: 16, paddingBottom: 120, gap: 12 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    heading: { fontSize: 28, fontWeight: '700', color: theme.ink },
    sub: { fontSize: 15, color: theme.muted, marginBottom: 4 },
    driver: { gap: 6 },
    driverHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    name: { fontSize: 18, fontWeight: '600', color: theme.ink },
    meta: { fontSize: 14, color: theme.muted },
    empty: { fontSize: 15, color: theme.muted, lineHeight: 22 },
});
