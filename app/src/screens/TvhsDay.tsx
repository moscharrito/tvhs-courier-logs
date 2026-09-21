/* The TVHS driver's day, on the phone.
 *
 * Check in, then the legs: where it went, when it started and finished, how
 * many sterile and soiled totes moved, and the mileage. The same sheet the
 * web app has carried for months, and the same endpoints.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ADMIN CONSOLE IS NOT HERE, DELIBERATELY.
 *
 * The web app at /projects/tvhs/tvhs has an Overview, every driver's logs
 * and every check-in. None of that is a driver's day: it is the fleet, and
 * it belongs on a desk. A driver gets the sheet they fill in and their own
 * history, and nothing about the other van.
 *
 * THE WHOLE DAY SAVES AT ONCE. `POST /logs` replaces the date: it upserts
 * each leg by index and deletes anything beyond the list. That makes a save
 * idempotent and therefore safe to retry, which is what the stretch between
 * Murfreesboro and Clarksville with no signal needs.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
    StyleSheet, Text, TextInput, View,
} from 'react-native';
import { CardButton, Chip, Ground, Notice, Panel, Sheet } from '../ui/Glass';
import { TopBar } from '../ui/Nav';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { get, post } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import {
    legsForRoute, legsFromSaved, problemsIn, toPayload, totals,
    type Leg, type Routes, type SavedLeg,
} from '../lib/tvhs';

const TVHS = '/api/projects/tvhs/tvhs';

export function TvhsDay({ token, route, name, onSignedOut, onBack }: {
    token: string;
    /** northbound or southbound: which van, and which legs. */
    route: string;
    name: string;
    onSignedOut: () => void;
    onBack: () => void;
}) {
    const [today, setToday] = useState<string | null>(null);
    const [checkedIn, setCheckedIn] = useState<boolean | null>(null);
    const [legs, setLegs] = useState<Leg[] | null>(null);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            /* The server's date, not the phone's. A driver crossing midnight
               on an after-hours run should file against the day the rest of
               the system calls today. */
            const config = await get<{ timezone: string; today: string }>('/api/config', token);
            const date = config.today;
            setToday(date);

            const [status, routes, saved] = await Promise.all([
                get<{ checkedIn: boolean }>(`${TVHS}/checkin?date=${date}`, token),
                get<Routes>(`${TVHS}/routes`, token),
                get<SavedLeg[]>(`${TVHS}/logs?startDate=${date}&endDate=${date}`, token),
            ]);
            setCheckedIn(status.checkedIn);
            /* What is already filed wins over the route's defaults: a driver
               reopening the app mid-round must not lose the morning. */
            setLegs(saved.length > 0 ? legsFromSaved(saved) : legsForRoute(routes, route));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cannot reach the server.' });
            setLegs([]);
        }
    }, [token, route, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    const checkIn = async () => {
        if (today === null) return;
        setBusy(true);
        try {
            await post(`${TVHS}/checkin`, token, { date: today });
            setCheckedIn(true);
            setMsg({ kind: 'ok', text: 'Checked in.' });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not check in.' });
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        if (today === null || legs === null) return;
        const problems = problemsIn(legs);
        if (problems.length > 0) {
            setMsg({ kind: 'error', text: problems[0]!.message });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            await post(`${TVHS}/logs`, token, toPayload(today, legs));
            const t = totals(legs);
            setMsg({
                kind: 'ok',
                text: `Saved. ${t.legs} ${t.legs === 1 ? 'leg' : 'legs'}, ${t.miles} miles, `
                    + `${t.sterile} sterile and ${t.soiled} soiled.`,
            });
        } catch (err) {
            setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save the day.' });
        } finally {
            setBusy(false);
        }
    };

    const setLeg = (index: number, patch: Partial<Leg>) => {
        setLegs((current) => (current ?? []).map((l, i) => (i === index ? { ...l, ...patch } : l)));
    };

    if (legs === null || today === null) {
        return (
            <Ground>
                <View style={styles.centre}>
                    {msg?.kind === 'error'
                        ? <Notice text={msg.text} tone="bad" />
                        : <ActivityIndicator color={theme.green} />}
                </View>
            </Ground>
        );
    }

    const t = totals(legs);

    return (
        <Ground>
            <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <View style={styles.context}>
                    <TopBar backLabel="Contracts" onBack={onBack} onSignOut={onSignedOut} />
                    <Text style={styles.title}>{name}</Text>
                    <Text style={styles.sub}>{route} · {today}</Text>
                    <View style={styles.chips}>
                        <Chip label={`${t.legs} legs`} />
                        <Chip label={`${t.miles} miles`} />
                        <Chip label={`${t.sterile} sterile`} />
                        <Chip label={`${t.soiled} soiled`} tone={t.soiled > 0 ? 'warn' : 'neutral'} />
                    </View>
                </View>

                <Sheet style={styles.sheet}>
                    <ScrollView contentContainerStyle={styles.sheetInner} keyboardShouldPersistTaps="handled">
                        {msg !== null && <Notice text={msg.text} tone={msg.kind === 'error' ? 'bad' : 'info'} />}

                        {/* Checking in is the first thing and it is idempotent
                            on the server, so a second tap is harmless. */}
                        {checkedIn === false && (
                            <CardButton
                                title="Check in for today"
                                detail="Clock on before the first leg"
                                tone="primary"
                                onPress={() => { void checkIn(); }}
                                busy={busy}
                            />
                        )}
                        {checkedIn === true && <Notice text="Checked in for today." tone="info" />}

                        {legs.map((leg, i) => (
                            <Panel key={i} style={styles.leg}>
                                <Text style={styles.legTitle}>
                                    Leg {i + 1}: {leg.legFrom || '?'} to {leg.legTo || '?'}
                                </Text>

                                <View style={styles.row}>
                                    <Field
                                        label="Start"
                                        value={leg.startTime}
                                        onChange={(v) => setLeg(i, { startTime: v })}
                                        placeholder="08:00"
                                        editable={!busy}
                                    />
                                    <Field
                                        label="Finish"
                                        value={leg.endTime}
                                        onChange={(v) => setLeg(i, { endTime: v })}
                                        placeholder="09:20"
                                        editable={!busy}
                                    />
                                </View>

                                <View style={styles.row}>
                                    <Field
                                        label="Sterile"
                                        value={leg.sterile}
                                        onChange={(v) => setLeg(i, { sterile: v })}
                                        numeric
                                        editable={!busy}
                                    />
                                    <Field
                                        label="Soiled"
                                        value={leg.soiled}
                                        onChange={(v) => setLeg(i, { soiled: v })}
                                        numeric
                                        editable={!busy}
                                    />
                                    <Field
                                        label="Miles"
                                        value={leg.miles}
                                        onChange={(v) => setLeg(i, { miles: v })}
                                        numeric
                                        editable={!busy}
                                    />
                                </View>
                            </Panel>
                        ))}

                        <CardButton
                            title="Add a leg"
                            detail="For a journey that is not on the usual route"
                            tone="quiet"
                            onPress={() => setLegs([...legs, { legFrom: '', legTo: '', startTime: '', endTime: '', sterile: '', soiled: '', miles: '' }])}
                        />

                        <CardButton
                            title="Save the day"
                            detail={`${t.legs} ${t.legs === 1 ? 'leg' : 'legs'} filled in. Saving replaces what is filed for today.`}
                            tone="primary"
                            onPress={() => { void save(); }}
                            busy={busy}
                        />
                    </ScrollView>
                </Sheet>
            </KeyboardAvoidingView>
        </Ground>
    );
}

function Field({ label, value, onChange, placeholder, numeric = false, editable = true }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    numeric?: boolean;
    editable?: boolean;
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

const styles = StyleSheet.create({
    fill: { flex: 1 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
    context: { paddingHorizontal: SPACE.lg, paddingTop: 56, paddingBottom: SPACE.md },
    title: { fontSize: TYPE.title, fontWeight: '800', color: theme.ink, marginTop: SPACE.sm },
    sub: { fontSize: TYPE.label, color: theme.muted, marginTop: 2 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
    sheet: { flex: 1 },
    sheetInner: { paddingBottom: SPACE.xl },
    leg: { marginBottom: SPACE.sm, padding: SPACE.md },
    legTitle: { fontSize: TYPE.label, fontWeight: '700', color: theme.ink, marginBottom: SPACE.sm },
    row: { flexDirection: 'row', gap: SPACE.sm },
    field: { flex: 1 },
    fieldLabel: { fontSize: TYPE.meta, color: theme.muted, marginBottom: 4 },
    input: {
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        minHeight: TAP.minimum,
        paddingHorizontal: SPACE.sm,
        fontSize: TYPE.body,
        color: theme.ink,
        marginBottom: SPACE.sm,
    },
});
