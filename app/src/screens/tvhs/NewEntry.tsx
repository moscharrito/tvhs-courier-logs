/* New Entry: the web app's driver screen, on a phone.
 *
 * A translation, not a redesign. The web has, top to bottom: a TODAY card
 * with the date, a running clock and Start My Day; a Select Week card whose
 * date picker auto-selects Monday to Friday; five day tabs; the day's table
 * with Clear Day and Save Log; Daily Totals; Add Extra Route Leg; and a
 * Weekly Summary. All of it is here, in that order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE THING THAT COULD NOT BE COPIED IS THE TABLE.
 *
 * Seven columns (leg, start, end, sterile, soiled, totes, miles) do not fit
 * across a phone. Shrinking them to fit would produce exactly the thing the
 * owner asked to fix two days ago: boxes too small to read or hit.
 *
 * So each leg is a card carrying the same seven values in the same order,
 * with the computed Totes shown the same way the web shows it. Nothing is
 * added, nothing is dropped, and the numbers are the same numbers.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
    ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { CardButton, Ground, Notice, Panel } from '../../ui/Glass';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../../theme';
import { get, post } from '../../lib/api';
import { ApiError, isUnauthorized } from '../../lib/http';
import {
    emptyLeg, legsForRoute, legsFromSaved, parseYmd, problemsIn, toPayload, totals,
    totesOf, weekLabel, weekOf, weekSummary, ymd,
    type Leg, type Routes, type SavedLeg, type WeekDay,
} from '../../lib/tvhs';

const TVHS = '/api/projects/tvhs/tvhs';

export function NewEntry({ token, route, onSignedOut }: {
    token: string;
    route: string;
    onSignedOut: () => void;
}) {
    const [today, setToday] = useState<string | null>(null);
    const [clock, setClock] = useState('');
    const [checkedIn, setCheckedIn] = useState<boolean | null>(null);
    const [routes, setRoutes] = useState<Routes>({});
    /* The week, and every day's legs, held together: the Weekly Summary
       needs all five at once and the web computes it the same way. */
    const [week, setWeek] = useState<WeekDay[] | null>(null);
    const [byDate, setByDate] = useState<Record<string, Leg[]>>({});
    const [active, setActive] = useState<string | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    /* The running clock on the TODAY card. The web shows one and a driver
       uses it to fill in a start time, so it is not decoration. */
    useEffect(() => {
        const tick = () => setClock(new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, []);

    const loadWeek = useCallback(async (anchor: string, defs: Routes) => {
        const days = weekOf(anchor);
        setWeek(days);
        setActive((current) => (days.some((d) => d.date === current) ? current : days[0]!.date));
        const saved = await get<SavedLeg[]>(
            `${TVHS}/logs?startDate=${days[0]!.date}&endDate=${days[4]!.date}`,
            token,
        );
        const grouped: Record<string, Leg[]> = {};
        for (const day of days) {
            const rows = saved.filter((r) => r.date === day.date);
            /* What is filed wins over the route defaults, so reopening the
               app mid-week does not wipe Monday. */
            grouped[day.date] = rows.length > 0 ? legsFromSaved(rows) : legsForRoute(defs, route);
        }
        setByDate(grouped);
    }, [token, route]);

    const load = useCallback(async () => {
        try {
            /* The server's date, so an after-hours run crossing midnight
               files against the day the rest of the system calls today. */
            const config = await get<{ today: string }>('/api/config', token);
            setToday(config.today);
            const [status, defs] = await Promise.all([
                get<{ checkedIn: boolean }>(`${TVHS}/checkin?date=${config.today}`, token),
                get<Routes>(`${TVHS}/routes`, token),
            ]);
            setCheckedIn(status.checkedIn);
            setRoutes(defs);
            await loadWeek(config.today, defs);
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach the server.' });
        }
    }, [token, loadWeek, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    const startDay = async () => {
        if (today === null) return;
        setBusy(true);
        try {
            await post(`${TVHS}/checkin`, token, { date: today });
            setCheckedIn(true);
            setMsg({ kind: 'ok', text: 'Checked in for today.' });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not check in.' });
        } finally { setBusy(false); }
    };

    const legs = active === null ? [] : (byDate[active] ?? []);
    const setLegs = (next: Leg[]) => { if (active !== null) setByDate({ ...byDate, [active]: next }); };
    const setLeg = (i: number, patch: Partial<Leg>) =>
        setLegs(legs.map((l, n) => (n === i ? { ...l, ...patch } : l)));

    const saveLog = async () => {
        if (active === null) return;
        const problems = problemsIn(legs);
        if (problems.length > 0) { setMsg({ kind: 'error', text: problems[0]!.message }); return; }
        setBusy(true);
        setMsg(null);
        try {
            await post(`${TVHS}/logs`, token, toPayload(active, legs));
            const t = totals(legs);
            setMsg({ kind: 'ok', text: `Saved. ${t.legs} ${t.legs === 1 ? 'leg' : 'legs'}, ${t.miles} miles.` });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' });
        } finally { setBusy(false); }
    };

    /* Clear Day empties the sheet back to the route defaults and saves, so
       the cleared day is actually cleared on the server rather than only on
       this phone. */
    const clearDay = async () => {
        if (active === null) return;
        const fresh = legsForRoute(routes, route);
        setLegs(fresh);
        setBusy(true);
        try {
            await post(`${TVHS}/logs`, token, toPayload(active, fresh));
            setMsg({ kind: 'ok', text: 'Day cleared.' });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not clear the day.' });
        } finally { setBusy(false); }
    };

    const shiftWeek = (weeks: number) => {
        if (week === null) return;
        const d = parseYmd(week[0]!.date);
        d.setDate(d.getDate() + weeks * 7);
        void loadWeek(ymd(d), routes);
    };

    const daily = totals(legs);
    const summary = useMemo(() => weekSummary(byDate), [byDate]);

    if (today === null || week === null) {
        return (
            <Ground>
                <View style={styles.centre}>
                    {msg?.kind === 'error' ? <Notice text={msg.text} tone="bad" /> : <ActivityIndicator color={theme.green} />}
                </View>
            </Ground>
        );
    }

    const activeDay = week.find((d) => d.date === active);

    return (
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
                {msg !== null && <Notice text={msg.text} tone={msg.kind === 'error' ? 'bad' : 'info'} />}

                {/* TODAY, with the running clock and Start My Day. */}
                <Panel style={styles.today}>
                    <Text style={styles.eyebrow}>TODAY</Text>
                    <Text style={styles.todayDate}>
                        {parseYmd(today).toLocaleDateString('en-US', {
                            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                        })}
                    </Text>
                    <Text style={styles.clock}>{clock}</Text>
                    {checkedIn === true
                        ? <Notice text="You have started your day." tone="info" />
                        : (
                            <CardButton
                                title="Start My Day"
                                detail="Clock on before the first leg"
                                tone="primary"
                                onPress={() => { void startDay(); }}
                                busy={busy}
                            />
                        )}
                </Panel>

                {/* Select Week. The phone has no flatpickr, so the week moves
                    by arrows rather than a calendar: the same five days, and
                    one fewer thing to mis-tap in a cab. */}
                <Panel style={styles.block}>
                    <Text style={styles.eyebrow}>SELECT WEEK</Text>
                    <View style={styles.weekRow}>
                        <Pressable style={styles.weekArrow} onPress={() => shiftWeek(-1)} accessibilityRole="button" accessibilityLabel="Previous week">
                            <Text style={styles.weekArrowText}>‹</Text>
                        </Pressable>
                        <Text style={styles.weekLabel}>{weekLabel(week)}</Text>
                        <Pressable style={styles.weekArrow} onPress={() => shiftWeek(1)} accessibilityRole="button" accessibilityLabel="Next week">
                            <Text style={styles.weekArrowText}>›</Text>
                        </Pressable>
                    </View>
                    <Pressable
                        style={styles.thisWeek}
                        onPress={() => { void loadWeek(today, routes); }}
                        accessibilityRole="button"
                    >
                        <Text style={styles.thisWeekText}>This week</Text>
                    </Pressable>
                </Panel>

                {/* The five day tabs. */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayTabs}>
                    {week.map((d) => {
                        const on = d.date === active;
                        const filled = (byDate[d.date] ?? []).some((l) => totesOf(l) > 0 || l.startTime !== '');
                        return (
                            <Pressable
                                key={d.date}
                                style={[styles.dayTab, on && styles.dayTabOn]}
                                onPress={() => setActive(d.date)}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: on }}
                            >
                                <Text style={[styles.dayTabName, on && styles.dayTabTextOn]}>{d.dayName}</Text>
                                <Text style={[styles.dayTabNum, on && styles.dayTabTextOn]}>{d.dayOfMonth}</Text>
                                {/* A dot where the web bolds a filled tab. */}
                                {filled && <View style={[styles.dot, on && styles.dotOn]} />}
                            </Pressable>
                        );
                    })}
                </ScrollView>

                {activeDay !== undefined && (
                    <Text style={styles.dayHeading}>
                        {parseYmd(activeDay.date).toLocaleDateString('en-US', {
                            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                        })}
                    </Text>
                )}

                {/* One card per leg: the table's seven columns, in order. */}
                {legs.map((leg, i) => (
                    <Panel key={i} style={styles.leg}>
                        <Text style={styles.legTitle}>
                            {i + 1}.  {leg.legFrom || '?'}  ▶  {leg.legTo || '?'}
                        </Text>
                        <View style={styles.row}>
                            <Field label="Start time" value={leg.startTime} onChange={(v) => setLeg(i, { startTime: v })} placeholder="08:00" editable={!busy} />
                            <Field label="End time" value={leg.endTime} onChange={(v) => setLeg(i, { endTime: v })} placeholder="09:20" editable={!busy} />
                        </View>
                        <View style={styles.row}>
                            <Field label="Sterile" value={leg.sterile} onChange={(v) => setLeg(i, { sterile: v })} numeric editable={!busy} />
                            <Field label="Soiled" value={leg.soiled} onChange={(v) => setLeg(i, { soiled: v })} numeric editable={!busy} />
                            <View style={styles.field}>
                                <Text style={styles.fieldLabel}>Total totes</Text>
                                {/* Computed, like the web. Never typed. */}
                                <View style={styles.computed}><Text style={styles.computedText}>{totesOf(leg)}</Text></View>
                            </View>
                            <Field label="Miles" value={leg.miles} onChange={(v) => setLeg(i, { miles: v })} numeric editable={!busy} />
                        </View>
                    </Panel>
                ))}

                {/* Daily Totals, the row under the table. */}
                <Panel style={styles.totalsBar}>
                    <Text style={styles.totalsTitle}>Daily Totals</Text>
                    <View style={styles.totalsRow}>
                        <Total label="Sterile" value={daily.sterile} />
                        <Total label="Soiled" value={daily.soiled} />
                        <Total label="Totes" value={daily.sterile + daily.soiled} />
                        <Total label="Miles" value={daily.miles} />
                    </View>
                </Panel>

                <CardButton
                    title="Add Extra Route Leg"
                    detail="For a trip outside your regular schedule"
                    tone="quiet"
                    onPress={() => setLegs([...legs, emptyLeg()])}
                />
                <CardButton title="Save Log" tone="primary" onPress={() => { void saveLog(); }} busy={busy} />
                <CardButton
                    title="Clear Day"
                    detail="Empties this day back to your route and saves it"
                    tone="danger"
                    onPress={() => { void clearDay(); }}
                    busy={busy}
                />

                {/* Weekly Summary, the four cards at the bottom of the web. */}
                <Panel style={styles.block}>
                    <Text style={styles.eyebrow}>WEEKLY SUMMARY</Text>
                    <View style={styles.totalsRow}>
                        <Total label="Total miles" value={summary.miles} />
                        <Total label="Total totes" value={summary.totes} />
                        <Total label="Routes" value={summary.routes} />
                        <Total label="Days logged" value={summary.days} />
                    </View>
                </Panel>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

function Field({ label, value, onChange, placeholder, numeric = false, editable = true }: {
    label: string; value: string; onChange: (v: string) => void;
    placeholder?: string; numeric?: boolean; editable?: boolean;
}) {
    return (
        <View style={styles.field}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
                style={styles.input}
                value={value}
                onChangeText={onChange}
                editable={editable}
                keyboardType={numeric ? 'decimal-pad' : 'numbers-and-punctuation'}
                placeholder={placeholder ?? ''}
                placeholderTextColor={theme.muted}
                accessibilityLabel={label}
            />
        </View>
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
    fill: { flex: 1 },
    wrap: { padding: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.xl },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },

    today: { marginBottom: SPACE.md },
    block: { marginBottom: SPACE.md },
    eyebrow: { fontSize: TYPE.meta, fontWeight: '700', color: theme.greenBright, letterSpacing: 1 },
    todayDate: { fontSize: TYPE.heading, fontWeight: '800', color: theme.ink, marginTop: SPACE.xs },
    clock: { fontSize: TYPE.label, color: theme.muted, marginBottom: SPACE.md },

    weekRow: { flexDirection: 'row', alignItems: 'center', marginTop: SPACE.sm },
    weekArrow: {
        width: TAP.minimum, height: TAP.minimum, alignItems: 'center', justifyContent: 'center',
        borderRadius: RADIUS.pill, backgroundColor: 'rgba(255,255,255,0.6)',
        borderWidth: 1, borderColor: GLASS.borderSubtle,
    },
    weekArrowText: { fontSize: 26, color: theme.green, lineHeight: 30 },
    weekLabel: { flex: 1, textAlign: 'center', fontSize: TYPE.label, fontWeight: '700', color: theme.ink },
    thisWeek: { minHeight: TAP.minimum, alignItems: 'center', justifyContent: 'center' },
    thisWeekText: { color: theme.greenBright, fontSize: TYPE.label, fontWeight: '600' },

    dayTabs: { gap: SPACE.sm, paddingVertical: SPACE.xs, paddingRight: SPACE.md },
    dayTab: {
        minWidth: 84, minHeight: TAP.standard, alignItems: 'center', justifyContent: 'center',
        paddingHorizontal: SPACE.sm, borderRadius: RADIUS.button,
        backgroundColor: 'rgba(255,255,255,0.55)', borderWidth: 1, borderColor: GLASS.borderSubtle,
    },
    dayTabOn: { backgroundColor: GLASS.fillGreen, borderColor: 'rgba(255,255,255,0.22)' },
    dayTabName: { fontSize: TYPE.meta, color: theme.muted, fontWeight: '600' },
    dayTabNum: { fontSize: TYPE.heading, color: theme.ink, fontWeight: '800' },
    dayTabTextOn: { color: '#ffffff' },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.greenBright, marginTop: 3 },
    dotOn: { backgroundColor: '#ffffff' },

    dayHeading: { fontSize: TYPE.heading, fontWeight: '800', color: theme.ink, marginVertical: SPACE.md },

    leg: { marginBottom: SPACE.sm, padding: SPACE.md },
    legTitle: { fontSize: TYPE.label, fontWeight: '700', color: theme.ink, marginBottom: SPACE.sm },
    row: { flexDirection: 'row', gap: SPACE.sm },
    field: { flex: 1 },
    fieldLabel: { fontSize: TYPE.meta, color: theme.muted, marginBottom: 4 },
    input: {
        backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button, minHeight: TAP.minimum, paddingHorizontal: SPACE.sm,
        fontSize: TYPE.body, color: theme.ink, marginBottom: SPACE.sm,
    },
    computed: {
        minHeight: TAP.minimum, justifyContent: 'center', alignItems: 'center',
        borderRadius: RADIUS.button, backgroundColor: 'rgba(22,163,74,0.1)',
        borderWidth: 1, borderColor: 'rgba(22,163,74,0.22)', marginBottom: SPACE.sm,
    },
    computedText: { fontSize: TYPE.body, fontWeight: '700', color: theme.green },

    totalsBar: { marginBottom: SPACE.sm, padding: SPACE.md },
    totalsTitle: { fontSize: TYPE.label, fontWeight: '700', color: theme.ink, marginBottom: SPACE.sm },
    totalsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.sm },
    total: { flex: 1, alignItems: 'center' },
    totalValue: { fontSize: TYPE.heading, fontWeight: '800', color: theme.green },
    totalLabel: { fontSize: TYPE.meta, color: theme.muted, marginTop: 2, textAlign: 'center' },
});
