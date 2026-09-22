/* New Entry: the web app's driver screen, on a phone.
 *
 * A translation, not a redesign. The web has, top to bottom: a TODAY card
 * with the date, a running clock and Start My Day; a Select Week card whose
 * date picker auto-selects Monday to Friday; five day tabs; the day's table
 * with Clear Day and Save Log; Daily Totals; Add Extra Route Leg; and a
 * Weekly Summary. All of it is here, in that order.
 *
 * The seven-column table is a real table, in LegTable.tsx: it scrolls
 * sideways with ROUTE LEG frozen, rather than being flattened into cards.
 * The first attempt at this screen turned it into cards and the owner asked
 * for the table back, which was the right call: a driver reads down a
 * column to check a day, and cards cannot be read down.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
    ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { CardButton, Confirm, Ground, Notice, Panel } from '../../ui/Glass';
import { LegTable } from './LegTable';
import { LegEditor } from './LegEditor';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../../theme';
import { del, get, post } from '../../lib/api';
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
    /* Which of the two one-tap, hard-to-undo actions is waiting on a yes. */
    const [asking, setAsking] = useState<'save' | 'clear' | null>(null);
    /** Which leg is open in the full-width editor, if any. */
    const [editing, setEditing] = useState<number | null>(null);

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
            /* One path, saved or not. legsFromSaved starts from the route,
               so an untouched day and a half-filled one both come back as a
               full sheet with the legs named. */
            grouped[day.date] = legsFromSaved(rows, defs[route]?.legs ?? []);
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

    /* Legs the route defines. Anything past this on the sheet is an extra
       leg: it names itself, it can be removed, and it is what decides the
       leg_index the server files the row under. */
    const standardLegs = routes[route]?.legs.length ?? 0;
    const legs = active === null ? [] : (byDate[active] ?? []);
    const setLegs = (next: Leg[]) => { if (active !== null) setByDate({ ...byDate, [active]: next }); };
    const setLeg = (i: number, patch: Partial<Leg>) =>
        setLegs(legs.map((l, n) => (n === i ? { ...l, ...patch } : l)));

    /* What the yes actually writes, in the driver's own numbers. A dialog
       that only says "are you sure" moves the tap without adding anything to
       decide with. Saving overwrites the whole day on the server, so the
       count of legs is the thing worth checking before it does. */
    const dayTotals = totals(legs);
    const saveSummary = dayTotals.legs === 0
        ? 'Nothing is filled in on this day, so saving it will overwrite whatever is on the server with an empty day.'
        : `${dayTotals.legs} ${dayTotals.legs === 1 ? 'leg' : 'legs'}, ${dayTotals.sterile + dayTotals.soiled} totes and `
          + `${dayTotals.miles} miles. This replaces whatever is saved for this day.`;

    const saveLog = async () => {
        if (active === null) return;
        const problems = problemsIn(legs, standardLegs);
        if (problems.length > 0) { setMsg({ kind: 'error', text: problems[0]!.message }); return; }
        setBusy(true);
        setMsg(null);
        try {
            await post(`${TVHS}/logs`, token, toPayload(active, legs, standardLegs));
            const t = totals(legs);
            setMsg({ kind: 'ok', text: `Saved. ${t.legs} ${t.legs === 1 ? 'leg' : 'legs'}, ${t.miles} miles.` });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' });
        } finally { setBusy(false); setAsking(null); }
    };

    /* Clear Day DELETES the day, which is what the web has always done.
     *
     * This used to POST a sheet of empty legs instead, and the two are not
     * the same thing. A POST writes a row per leg holding zeros, so the day
     * still exists: it counts as a day worked in the weekly summary, it
     * appears in the administrator's Driver Logs export, and a driver who
     * cleared a day on the phone found it still there on the web. DELETE
     * removes the rows, and `legsFromSaved` rebuilds the blank sheet from
     * the route on the next read, exactly as the web's buildLogTable does.
     *
     * TVHS is live with two drivers filing against it, so mobile and web
     * writing different things for the same button is not a cosmetic
     * difference. See server.js `tvhs.delete('/logs')`. */
    const clearDay = async () => {
        if (active === null) return;
        const fresh = legsForRoute(routes, route);
        setLegs(fresh);
        setBusy(true);
        try {
            await del(`${TVHS}/logs`, token, { date: active });
            setMsg({ kind: 'ok', text: 'Day cleared.' });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not clear the day.' });
        } finally { setBusy(false); setAsking(null); }
    };

    const shiftWeek = (weeks: number) => {
        if (week === null) return;
        const d = parseYmd(week[0]!.date);
        d.setDate(d.getDate() + weeks * 7);
        void loadWeek(ymd(d), routes);
    };

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

                {/* The table, seven columns, panned sideways with ROUTE LEG
                    frozen. Daily Totals is its last row, as on the web. */}
                <LegTable
                    legs={legs}
                    onChange={setLeg}
                    onOpen={(i) => setEditing(i)}
                    onRemove={(i) => setLegs(legs.filter((_, n) => n !== i))}
                    standardLegs={standardLegs}
                    editable={!busy}
                />
                <Text style={styles.panHint}>Swipe the table sideways for totes and miles.</Text>

                <CardButton
                    title="Add Extra Route Leg"
                    detail="For a trip outside your regular schedule"
                    tone="quiet"
                    onPress={() => setLegs([...legs, emptyLeg()])}
                />
                <View style={styles.dayActions}>
                    <View style={styles.dayAction}>
                        <CardButton
                            title="Save Log"
                            tone="calm"
                            compact
                            onPress={() => setAsking('save')}
                            busy={busy && asking === 'save'}
                        />
                    </View>
                    <View style={styles.dayAction}>
                        <CardButton
                            title="Clear Day"
                            tone="calmDanger"
                            compact
                            onPress={() => setAsking('clear')}
                            busy={busy && asking === 'clear'}
                        />
                    </View>
                </View>

                <LegEditor
                    open={editing !== null}
                    index={editing ?? 0}
                    isExtra={editing !== null && editing >= standardLegs}
                    leg={editing === null ? null : (legs[editing] ?? null)}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) => {
                        if (editing !== null) setLeg(editing, patch);
                        setEditing(null);
                    }}
                    {...(editing !== null && editing >= standardLegs
                        ? { onRemove: () => { setLegs(legs.filter((_, n) => n !== editing)); setEditing(null); } }
                        : {})}
                />

                <Confirm
                    open={asking === 'save'}
                    title="Save this day?"
                    body={saveSummary}
                    confirmLabel="Save the log"
                    tone="calm"
                    busy={busy}
                    onConfirm={() => { void saveLog(); }}
                    onCancel={() => setAsking(null)}
                />
                <Confirm
                    open={asking === 'clear'}
                    title="Clear this day?"
                    body="Every time, tote count and mileage on this day is emptied and the empty day is saved to the server. This cannot be undone."
                    confirmLabel="Clear the day"
                    tone="calmDanger"
                    busy={busy}
                    onConfirm={() => { void clearDay(); }}
                    onCancel={() => setAsking(null)}
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

    /* Side by side, so the pair reads as "finish the day" rather than as two
       separate announcements stacked down the screen. */
    dayActions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },
    dayAction: { flex: 1 },
    panHint: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.xs, marginBottom: SPACE.md, textAlign: 'center' },
    totalsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.sm },
    total: { flex: 1, alignItems: 'center' },
    totalValue: { fontSize: TYPE.heading, fontWeight: '800', color: theme.green },
    totalLabel: { fontSize: TYPE.meta, color: theme.muted, marginTop: 2, textAlign: 'center' },
});
