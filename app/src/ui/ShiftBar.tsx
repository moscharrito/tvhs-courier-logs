/* The shift control, and the banner that is never empty.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCREEN TICKETS 7.3 AND 7.4 NEVER GOT.
 *
 * Both were recorded as done. Both were also unwired: nothing imported
 * lib/tracking.ts, nothing called startShift, and `trackingState` -- the
 * function whose entire job is to tell a driver whether they are being
 * recorded -- was referenced only by its own test. The permissions were in
 * the manifest, so the app asked for the right to follow people around and
 * then never used it.
 *
 * It lives in Driving rather than in the Today tab because of what trace.ts
 * promises: "There is no state in which this returns an empty string". A
 * banner that appears on one tab of three is not that. Sitting above the tab
 * content, it is on screen whenever the app is, which is also what the store
 * submission says we do.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ORDER OF OPERATIONS IS NOT IN THIS FILE.
 *
 * It is in lib/shift.ts as a list of steps, because it is the part that is
 * wrong in a way that still looks like it works, and because nothing in this
 * file can be tested on this machine -- the app's test runner cannot parse
 * JSX. The same split as SignaturePad over lib/strokes.ts and Pager over
 * lib/paging.ts. What is left here is execution: take the steps and do them.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SPACE, TAP, TYPE, RADIUS, theme } from '../theme';
import { trackingState, type StopReason } from '../lib/trace';
import { goOffShift, goOnShift, shiftButton, type Step } from '../lib/shift';
import {
    askPermission, permissionState, startTracking, stopTracking, stoppedBecause,
    type PermissionState,
} from '../lib/tracking';
import { myShift, startShift, endShift } from '../lib/api';

interface Props {
    token: string;
    /** Project code: the tracker posts fixes against one contract. */
    code: string;
    onSignedOut: () => void;
}

export function ShiftBar({ token, code, onSignedOut }: Props) {
    const [onShift, setOnShift] = useState(false);
    const [permission, setPermission] = useState<PermissionState>('undetermined');
    const [stopped, setStopped] = useState<StopReason | null>(null);
    const [busy, setBusy] = useState(false);
    /* Until the first read answers, the banner would otherwise claim "off
       shift" to somebody who is on one -- which is the one direction this
       must not get wrong. */
    const [known, setKnown] = useState(false);

    const reread = useCallback(async () => {
        try {
            const [state, perm] = await Promise.all([myShift(token, code), permissionState()]);
            setOnShift(state.shift?.open === true);
            setPermission(perm);
            setStopped(stoppedBecause());
            setKnown(true);
        } catch (err) {
            /* A dead session is the shell's business, not this bar's. */
            if ((err as { status?: number }).status === 401) onSignedOut();
        }
    }, [token, code, onSignedOut]);

    useEffect(() => { void reread(); }, [reread]);

    /* The background task stops itself when the server says so, and the only
       way the screen learns is by asking. Thirty seconds is slow enough to be
       free and fast enough that a driver is not told they are tracked for
       long after they stopped being. */
    useEffect(() => {
        const t = setInterval(() => { setStopped(stoppedBecause()); }, 30_000);
        return () => clearInterval(t);
    }, []);

    const run = async (steps: Step[]) => {
        for (const step of steps) {
            if (step === 'startShift') await startShift(token, code);
            else if (step === 'endShift') await endShift(token, code);
            else if (step === 'askPermission') setPermission(await askPermission());
            else if (step === 'startTracking') setPermission(await startTracking(code));
            else if (step === 'stopTracking') await stopTracking('notOnShift');
        }
    };

    const toggle = async () => {
        if (busy) return;
        setBusy(true);
        try {
            if (onShift) {
                await run(goOffShift());
            } else {
                /* Read fresh rather than trusting state: the driver may have
                   changed the permission in Settings since this mounted. */
                await run(goOnShift(await permissionState()));
            }
            await reread();
        } catch (err) {
            if ((err as { status?: number }).status === 401) { onSignedOut(); return; }
            /* Whatever happened, the server is the truth about whether a
                shift is open. Asking again is more honest than assuming the
                toggle did what it was asked. */
            await reread();
        } finally {
            setBusy(false);
        }
    };

    const state = known
        ? trackingState({ onShift, permission, stopped })
        : { on: false, text: 'Checking whether you are on shift…' };

    return (
        <View style={styles.bar}>
            <View style={styles.textSide}>
                <View
                    style={[styles.dot, state.on ? styles.dotOn : styles.dotOff]}
                    /* Decorative: the sentence beside it already says this,
                       and a screen reader announcing "green circle" adds
                       nothing to "Dispatch can see where you are". */
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                />
                <Text style={styles.text} accessibilityRole="alert" accessibilityLiveRegion="polite">
                    {state.text}
                </Text>
            </View>
            <Pressable
                onPress={() => { void toggle(); }}
                disabled={busy || !known}
                style={({ pressed }) => [
                    styles.button,
                    onShift ? styles.buttonOff : styles.buttonOn,
                    (busy || !known) && styles.buttonBusy,
                    pressed && styles.buttonPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || !known, busy }}
                accessibilityHint={onShift
                    ? 'Ends your shift and stops recording your location'
                    : 'Starts your shift so dispatch can see where you are'}
            >
                <Text style={[styles.buttonText, onShift ? styles.buttonTextOff : styles.buttonTextOn]}>
                    {shiftButton(onShift, busy)}
                </Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.sm,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.sm,
        backgroundColor: theme.card,
        borderBottomWidth: 1,
        borderBottomColor: theme.line,
    },
    textSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    dot: { width: 10, height: 10, borderRadius: 5 },
    dotOn: { backgroundColor: theme.greenBright },
    dotOff: { backgroundColor: theme.muted },
    /* meta, not body: this is the one line on the screen a driver reads once
       and then stops noticing, and it must not crowd out the stop they are
       actually working. */
    text: { flex: 1, fontSize: TYPE.meta, color: theme.ink, lineHeight: 20 },
    button: {
        minHeight: TAP.minimum,
        justifyContent: 'center',
        paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.button,
        borderWidth: 1,
    },
    buttonOn: { backgroundColor: theme.green, borderColor: theme.green },
    buttonOff: { backgroundColor: theme.card, borderColor: theme.line },
    buttonBusy: { opacity: 0.6 },
    buttonPressed: { opacity: 0.8 },
    buttonText: { fontSize: TYPE.label, fontWeight: '600' },
    buttonTextOn: { color: '#ffffff' },
    buttonTextOff: { color: theme.ink },
});
