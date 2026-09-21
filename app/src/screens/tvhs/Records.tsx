/* My Logs and My Check-Ins: the web's two record views, on a phone.
 *
 * Both are the same shape on the web, so they are one file here: pick a
 * period, pick a date, read the rows. My Logs adds the four summary cards
 * and an export; My Check-Ins is date, day and time.
 *
 * WHAT IS DELIBERATELY NOT COPIED is the Export Excel button. It is a
 * `window.location.href` to a server route that streams a workbook, which on
 * a phone means a download the app cannot put anywhere: file storage waits
 * on the AWS BAA in ticket 0.10, and a button that opens a browser tab and
 * loses the file is worse than no button. The web still has it, and it is
 * the right place for it.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Notice, Panel } from '../../ui/Glass';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../../theme';
import { get } from '../../lib/api';
import { ApiError, isUnauthorized } from '../../lib/http';
import { parseYmd, weekLabel, weekOf, ymd, type SavedLeg } from '../../lib/tvhs';

type Period = 'daily' | 'weekly' | 'monthly';

interface Range { from: string; to: string; label: string }

/** The period a driver picked, as a date range. Weekly reuses weekOf, so
 *  My Logs and New Entry always agree about which week a day is in. */
function rangeFor(period: Period, anchor: string): Range {
    if (period === 'daily') {
        return {
            from: anchor,
            to: anchor,
            label: parseYmd(anchor).toLocaleDateString('en-US', {
                weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
            }),
        };
    }
    if (period === 'weekly') {
        const week = weekOf(anchor);
        return { from: week[0]!.date, to: week[4]!.date, label: weekLabel(week) };
    }
    const d = parseYmd(anchor);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return {
        from: ymd(first),
        to: ymd(last),
        label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    };
}

function shift(period: Period, anchor: string, by: number): string {
    const d = parseYmd(anchor);
    if (period === 'daily') d.setDate(d.getDate() + by);
    else if (period === 'weekly') d.setDate(d.getDate() + by * 7);
    else d.setMonth(d.getMonth() + by);
    return ymd(d);
}

/* ------------------------------------------------------------- My Logs */

export function MyLogs({ token, today, onSignedOut }: {
    token: string; today: string; onSignedOut: () => void;
}) {
    const [period, setPeriod] = useState<Period>('weekly');
    const [anchor, setAnchor] = useState(today);
    const [rows, setRows] = useState<SavedLeg[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const range = rangeFor(period, anchor);

    const load = useCallback(async () => {
        setRows(null);
        setError(null);
        try {
            setRows(await get<SavedLeg[]>(
                `/api/projects/tvhs/tvhs/logs?startDate=${range.from}&endDate=${range.to}`,
                token,
            ));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach the server.');
            setRows([]);
        }
    }, [token, range.from, range.to, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    /* The four summary cards, computed the way the web computes them. */
    const miles = (rows ?? []).reduce((n, r) => n + (Number(r.miles) || 0), 0);
    const totes = (rows ?? []).reduce((n, r) => n + (Number(r.sterile) || 0) + (Number(r.soiled) || 0), 0);
    const days = new Set((rows ?? []).map((r) => r.date)).size;

    return (
        <ScrollView contentContainerStyle={styles.wrap}>
            <PeriodPicker
                periods={['weekly', 'monthly']}
                period={period}
                onPeriod={setPeriod}
                label={range.label}
                onShift={(by) => setAnchor(shift(period, anchor, by))}
                onToday={() => setAnchor(today)}
            />

            <Panel style={styles.block}>
                <Text style={styles.eyebrow}>SUMMARY</Text>
                <View style={styles.totalsRow}>
                    <Total label="Total miles" value={Math.round(miles * 100) / 100} />
                    <Total label="Total totes" value={totes} />
                    <Total label="Routes" value={(rows ?? []).length} />
                    <Total label="Days logged" value={days} />
                </View>
            </Panel>

            {error !== null && <Notice text={error} tone="bad" />}

            {rows === null ? <ActivityIndicator color={theme.green} style={styles.spinner} /> : rows.length === 0 ? (
                <Notice text="No logs found for this period." tone="info" />
            ) : rows.map((r, i) => (
                <Panel key={`${r.date}-${r.leg_index}-${i}`} style={styles.row}>
                    <Text style={styles.rowTitle}>
                        {parseYmd(r.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        {'  ·  '}{r.leg_from} ▶ {r.leg_to}
                    </Text>
                    <Text style={styles.rowMeta}>
                        {r.start_time || '--'} to {r.end_time || '--'}
                        {'   ·   '}sterile {r.sterile}{'   ·   '}soiled {r.soiled}
                        {'   ·   '}totes {(Number(r.sterile) || 0) + (Number(r.soiled) || 0)}
                        {'   ·   '}{r.miles} mi
                    </Text>
                </Panel>
            ))}

            <Text style={styles.footnote}>
                Excel export is on the web app: a phone has nowhere to put the file yet.
            </Text>
        </ScrollView>
    );
}

/* -------------------------------------------------------- My Check-Ins */

export function MyCheckins({ token, today, onSignedOut }: {
    token: string; today: string; onSignedOut: () => void;
}) {
    const [period, setPeriod] = useState<Period>('weekly');
    const [anchor, setAnchor] = useState(today);
    const [rows, setRows] = useState<Array<{ date: string; checkin_at: string }> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const range = rangeFor(period, anchor);

    const load = useCallback(async () => {
        setRows(null);
        setError(null);
        try {
            setRows(await get<Array<{ date: string; checkin_at: string }>>(
                `/api/projects/tvhs/tvhs/checkins/history?startDate=${range.from}&endDate=${range.to}`,
                token,
            ));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach the server.');
            setRows([]);
        }
    }, [token, range.from, range.to, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    return (
        <ScrollView contentContainerStyle={styles.wrap}>
            <PeriodPicker
                periods={['daily', 'weekly', 'monthly']}
                period={period}
                onPeriod={setPeriod}
                label={range.label}
                onShift={(by) => setAnchor(shift(period, anchor, by))}
                onToday={() => setAnchor(today)}
            />

            {error !== null && <Notice text={error} tone="bad" />}

            {rows === null ? <ActivityIndicator color={theme.green} style={styles.spinner} /> : rows.length === 0 ? (
                <Notice text="No check-ins found for this period." tone="info" />
            ) : rows.map((r) => (
                <Panel key={r.date} style={styles.row}>
                    <Text style={styles.rowTitle}>
                        {parseYmd(r.date).toLocaleDateString('en-US', {
                            weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
                        })}
                    </Text>
                    <Text style={styles.rowMeta}>
                        Checked in at {new Date(r.checkin_at).toLocaleTimeString('en-US', { timeZoneName: 'short' })}
                    </Text>
                </Panel>
            ))}
        </ScrollView>
    );
}

/* ------------------------------------------------------------- shared */

function PeriodPicker({ periods, period, onPeriod, label, onShift, onToday }: {
    periods: Period[];
    period: Period;
    onPeriod: (p: Period) => void;
    label: string;
    onShift: (by: number) => void;
    onToday: () => void;
}) {
    return (
        <Panel style={styles.block}>
            <Text style={styles.eyebrow}>VIEW BY</Text>
            <View style={styles.segment}>
                {periods.map((p) => (
                    <Pressable
                        key={p}
                        style={[styles.segmentItem, p === period && styles.segmentOn]}
                        onPress={() => onPeriod(p)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: p === period }}
                    >
                        <Text style={[styles.segmentText, p === period && styles.segmentTextOn]}>
                            {p[0]!.toUpperCase() + p.slice(1)}
                        </Text>
                    </Pressable>
                ))}
            </View>

            <View style={styles.weekRow}>
                <Pressable style={styles.arrow} onPress={() => onShift(-1)} accessibilityRole="button" accessibilityLabel="Earlier">
                    <Text style={styles.arrowText}>‹</Text>
                </Pressable>
                <Text style={styles.rangeLabel}>{label}</Text>
                <Pressable style={styles.arrow} onPress={() => onShift(1)} accessibilityRole="button" accessibilityLabel="Later">
                    <Text style={styles.arrowText}>›</Text>
                </Pressable>
            </View>
            <Pressable style={styles.today} onPress={onToday} accessibilityRole="button">
                <Text style={styles.todayText}>Back to today</Text>
            </Pressable>
        </Panel>
    );
}

function Total({ label, value }: { label: string; value: number }) {
    return (
        <View style={styles.total}>
            <Text style={styles.totalValue}>{value}</Text>
            <Text style={styles.totalLabel}>{label}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { padding: SPACE.md, paddingBottom: SPACE.xl },
    block: { marginBottom: SPACE.md },
    eyebrow: { fontSize: TYPE.meta, fontWeight: '700', color: theme.greenBright, letterSpacing: 1 },
    spinner: { marginVertical: SPACE.lg },

    segment: { flexDirection: 'row', gap: SPACE.xs, marginTop: SPACE.sm },
    segmentItem: {
        flex: 1, minHeight: TAP.minimum, alignItems: 'center', justifyContent: 'center',
        borderRadius: RADIUS.button, backgroundColor: 'rgba(255,255,255,0.55)',
        borderWidth: 1, borderColor: GLASS.borderSubtle,
    },
    segmentOn: { backgroundColor: GLASS.fillGreen, borderColor: 'rgba(255,255,255,0.22)' },
    segmentText: { fontSize: TYPE.label, fontWeight: '600', color: theme.ink },
    segmentTextOn: { color: '#ffffff', fontWeight: '800' },

    weekRow: { flexDirection: 'row', alignItems: 'center', marginTop: SPACE.md },
    arrow: {
        width: TAP.minimum, height: TAP.minimum, alignItems: 'center', justifyContent: 'center',
        borderRadius: RADIUS.pill, backgroundColor: 'rgba(255,255,255,0.6)',
        borderWidth: 1, borderColor: GLASS.borderSubtle,
    },
    arrowText: { fontSize: 26, color: theme.green, lineHeight: 30 },
    rangeLabel: { flex: 1, textAlign: 'center', fontSize: TYPE.label, fontWeight: '700', color: theme.ink },
    today: { minHeight: TAP.minimum, alignItems: 'center', justifyContent: 'center' },
    todayText: { color: theme.greenBright, fontSize: TYPE.label, fontWeight: '600' },

    totalsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.sm },
    total: { flex: 1, alignItems: 'center' },
    totalValue: { fontSize: TYPE.heading, fontWeight: '800', color: theme.green },
    totalLabel: { fontSize: TYPE.meta, color: theme.muted, marginTop: 2, textAlign: 'center' },

    row: { marginBottom: SPACE.sm, padding: SPACE.md },
    rowTitle: { fontSize: TYPE.label, fontWeight: '700', color: theme.ink },
    rowMeta: { fontSize: TYPE.meta, color: theme.muted, marginTop: 4, lineHeight: 21 },

    footnote: { fontSize: TYPE.meta, color: theme.muted, lineHeight: 21, marginTop: SPACE.md },
});
