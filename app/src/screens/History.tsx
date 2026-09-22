/* Delivery History: what this courier has already done.
 *
 * Their own work and nobody else's. The server takes the username from the
 * session and there is no parameter to change, so this screen cannot be
 * turned into a way to read the patients another driver delivered to. An
 * administrator asking about a particular driver uses the reports screen,
 * which is a different question with different access.
 *
 * Delivered and failed only. Anything still open belongs on Today, and a
 * history that quietly included live work would count the same stop twice.
 *
 * Thirty days by default. Long enough to answer "did I deliver that one",
 * short enough that a phone is not carrying a year of patient addresses
 * around in memory.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Chip, Ground, Notice, Panel } from '../ui/Glass';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { deliveryHistory, type DeliveryHistory, type HistoryDay } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';

type Window = 7 | 30 | 90;

/** Local dates, formatted the way the rest of the app does it: never through
 *  the Date constructor on a "YYYY-MM-DD" string, which reads it as UTC. */
function ymd(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

function parseYmd(s: string): Date {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function History({ token, code, onSignedOut }: {
    token: string; code: string; onSignedOut: () => void;
}) {
    const [days, setDays] = useState<Window>(30);
    const [data, setData] = useState<DeliveryHistory | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setData(null);
        setError(null);
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - (days - 1));
        try {
            setData(await deliveryHistory(token, code, ymd(from), ymd(to)));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach the server.');
        }
    }, [token, code, days, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap}>
                <Text style={styles.title}>Delivery History</Text>
                <Text style={styles.sub}>Your finished work. Nobody else's.</Text>

                <View style={styles.segment}>
                    {([7, 30, 90] as Window[]).map((n) => (
                        <Pressable
                            key={n}
                            style={[styles.segmentItem, n === days && styles.segmentOn]}
                            onPress={() => setDays(n)}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: n === days }}
                        >
                            <Text style={[styles.segmentText, n === days && styles.segmentTextOn]}>
                                {n} days
                            </Text>
                        </Pressable>
                    ))}
                </View>

                {error !== null && <Notice text={error} tone="bad" />}

                {data !== null && (
                    <Panel style={styles.block}>
                        <Text style={styles.eyebrow}>IN THIS PERIOD</Text>
                        <View style={styles.totalsRow}>
                            <Total label="Delivered" value={String(data.totals.delivered)} />
                            <Total label="Failed" value={String(data.totals.failed)} />
                            <Total label="Days worked" value={String(data.totals.daysWorked)} />
                            <Total
                                label="On time"
                                /* A rate over nothing is not zero per cent, it
                                   is no answer, and printing 0% would read as
                                   a terrible week rather than a quiet one. */
                                value={data.totals.onTimeRate === null ? '--' : `${data.totals.onTimeRate}%`}
                            />
                        </View>
                    </Panel>
                )}

                {data === null && error === null && (
                    <ActivityIndicator color={theme.green} style={styles.spinner} />
                )}

                {data !== null && data.days.length === 0 && (
                    <Notice text="Nothing finished in this period." tone="info" />
                )}

                {data?.days.map((day) => <Day key={day.date} day={day} />)}
            </ScrollView>
        </Ground>
    );
}

function Day({ day }: { day: HistoryDay }) {
    return (
        <Panel style={styles.day}>
            <View style={styles.dayHead}>
                <Text style={styles.dayDate}>
                    {parseYmd(day.date).toLocaleDateString('en-US', {
                        weekday: 'short', month: 'short', day: 'numeric',
                    })}
                </Text>
                <View style={styles.dayChips}>
                    <Chip label={`${day.delivered} delivered`} tone="good" />
                    {day.failed > 0 && <Chip label={`${day.failed} failed`} tone="bad" />}
                </View>
            </View>

            {day.stops.map((s) => (
                <View key={s.orderId} style={styles.stop}>
                    <Text style={styles.stopName}>{s.recipientName}</Text>
                    <Text style={styles.stopMeta} numberOfLines={2}>{s.address}</Text>
                    <View style={styles.stopChips}>
                        <Chip label={s.serviceType.toUpperCase()} tone="neutral" />
                        {s.status === 'failed'
                            ? <Chip label="Not delivered" tone="bad" />
                            : s.onTime === null
                                ? <Chip label="No deadline" tone="neutral" />
                                : <Chip label={s.onTime ? 'On time' : 'Late'} tone={s.onTime ? 'good' : 'warn'} />}
                    </View>
                    {s.failureReason !== null && (
                        <Text style={styles.stopMeta}>Reason: {s.failureReason.replace(/_/g, ' ')}</Text>
                    )}
                </View>
            ))}
        </Panel>
    );
}

function Total({ label, value }: { label: string; value: string }) {
    return (
        <View style={styles.total}>
            <Text style={styles.totalValue}>{value}</Text>
            <Text style={styles.totalLabel}>{label}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { padding: SPACE.md, paddingTop: SPACE.lg, paddingBottom: SPACE.xl },
    title: { fontSize: TYPE.title, fontWeight: '800', color: theme.ink },
    sub: { fontSize: TYPE.label, color: theme.muted, marginTop: 2, marginBottom: SPACE.md },
    block: { marginBottom: SPACE.md },
    eyebrow: { fontSize: TYPE.meta, fontWeight: '700', color: theme.greenBright, letterSpacing: 1 },
    spinner: { marginVertical: SPACE.lg },

    segment: { flexDirection: 'row', gap: SPACE.xs, marginBottom: SPACE.md },
    segmentItem: {
        flex: 1, minHeight: TAP.minimum, alignItems: 'center', justifyContent: 'center',
        borderRadius: RADIUS.button, backgroundColor: 'rgba(255,255,255,0.55)',
        borderWidth: 1, borderColor: GLASS.borderSubtle,
    },
    segmentOn: { backgroundColor: GLASS.fillGreen, borderColor: 'rgba(255,255,255,0.22)' },
    segmentText: { fontSize: TYPE.label, fontWeight: '600', color: theme.ink },
    segmentTextOn: { color: '#ffffff', fontWeight: '800' },

    totalsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.sm },
    total: { flex: 1, alignItems: 'center' },
    totalValue: { fontSize: TYPE.heading, fontWeight: '800', color: theme.green },
    totalLabel: { fontSize: TYPE.meta, color: theme.muted, marginTop: 2, textAlign: 'center' },

    day: { marginBottom: SPACE.sm, padding: SPACE.md },
    dayHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.sm },
    dayDate: { fontSize: TYPE.label, fontWeight: '800', color: theme.ink },
    dayChips: { flexDirection: 'row', gap: SPACE.xs },

    stop: {
        borderTopWidth: 1,
        borderTopColor: 'rgba(17,24,39,0.07)',
        paddingTop: SPACE.sm,
        marginTop: SPACE.xs,
    },
    stopName: { fontSize: TYPE.body, fontWeight: '700', color: theme.ink },
    stopMeta: { fontSize: TYPE.meta, color: theme.muted, marginTop: 3, lineHeight: 20 },
    stopChips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.xs },
});
