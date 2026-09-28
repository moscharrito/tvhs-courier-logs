/* The wordmark, arriving.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * TAG fades up from faint and small to full size and full weight over about
 * two seconds, holds for a moment, and hands over to the contract picker. It
 * runs once, when the app is first opened, and never again in that session:
 * not on sign-out, not when a driver switches contract, not on a reload.
 * An animation a courier has to sit through eleven times a shift is not an
 * animation, it is a delay.
 *
 * IT NEVER BLOCKS ANYTHING. The token is read from the Keychain while this
 * plays, so the two happen at once rather than one after the other, and
 * `onDone` fires on a timer that cannot be jammed by a slow read. If the
 * animation callback were ever the only thing that ended it, a dropped frame
 * would leave the app on a logo forever; the timeout exists for that.
 *
 * TAPPING SKIPS IT. Somebody who has seen it does not need to see it again,
 * and on a doorstep in the rain two seconds is two seconds.
 *
 * REDUCED MOTION IS HONOURED. iOS and Android both let a person say they do
 * not want interfaces moving, often because motion makes them ill. When that
 * is set, the mark simply appears and the screen moves on quickly.
 * ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ground } from '../ui/Glass';
import { RADIUS, SPACE, theme } from '../theme';

/* Long enough to read as deliberate, short enough that nobody waits. The
   owner asked for two to three seconds; this lands at about 2.1 including
   the hold and the fade out. */
const GROW_MS = 1500;
const HOLD_MS = 350;
const FADE_MS = 260;
const TOTAL_MS = GROW_MS + HOLD_MS + FADE_MS;

/** What it collapses to when the phone is set to reduce motion. */
const REDUCED_MS = 450;

export function Splash({ onDone }: { onDone: () => void }) {
    /* One driver for both properties. Opacity and scale move together, so
       they are the same animation and not two that might drift apart. */
    const progress = useRef(new Animated.Value(0)).current;
    const out = useRef(new Animated.Value(1)).current;
    const [reduced, setReduced] = useState<boolean | null>(null);

    useEffect(() => {
        let live = true;
        void AccessibilityInfo.isReduceMotionEnabled()
            .then((on) => { if (live) setReduced(on); })
            /* Unknown means animate: the default behaviour of the app should
               not depend on a query that failed. */
            .catch(() => { if (live) setReduced(false); });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        if (reduced === null) return;
        let live = true;

        if (reduced) {
            progress.setValue(1);
            const t = setTimeout(() => { if (live) onDone(); }, REDUCED_MS);
            return () => { live = false; clearTimeout(t); };
        }

        Animated.sequence([
            Animated.timing(progress, {
                toValue: 1,
                duration: GROW_MS,
                /* Fast at the start, settling at the end. A linear grow reads
                   mechanical; this reads like something arriving. */
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }),
            Animated.delay(HOLD_MS),
            Animated.timing(out, { toValue: 0, duration: FADE_MS, useNativeDriver: true }),
        ]).start();

        /* The timer, not the animation callback, is what ends this. See the
           header: a dropped frame must not strand anybody on a logo. */
        const t = setTimeout(() => { if (live) onDone(); }, TOTAL_MS);
        return () => { live = false; clearTimeout(t); };
    }, [reduced, progress, out, onDone]);

    const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
    /* scaleX, NOT width.
     *
     * The native driver can only animate opacity and transforms; `width` is a
     * layout property and handing it a natively driven value throws "Style
     * property 'width' is not supported by native animated module" the first
     * time this screen renders. The rule keeps a fixed width and is scaled,
     * which looks the same, runs off the UI thread, and cannot throw. */
    const ruleScale = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

    return (
        <Ground>
            <StatusBar style="dark" />
            <Pressable style={styles.fill} onPress={onDone} accessibilityRole="button" accessibilityLabel="Skip">
                <Animated.View style={[styles.centre, { opacity: out }]}>
                    <Animated.Text
                        style={[styles.wordmark, { opacity: progress, transform: [{ scale }] }]}
                        /* Announced once, as a heading, rather than as a
                           button somebody is invited to press. */
                        accessibilityRole="header"
                    >
                        TAG
                    </Animated.Text>
                    {/* The same rule the contract picker has, drawn on. It is
                        what makes this read as the next screen assembling
                        itself rather than a separate logo screen. */}
                    <Animated.View style={[styles.rule, { transform: [{ scaleX: ruleScale }] }]} />
                </Animated.View>
            </Pressable>
        </Ground>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    /* The same 54 and the same tight tracking as the contract picker, so the
       handover does not jump. */
    wordmark: {
        fontSize: 54,
        fontWeight: '800',
        color: theme.green,
        letterSpacing: -1.5,
        textAlign: 'center',
    },
    rule: {
        width: 48,
        height: 4,
        borderRadius: RADIUS.pill,
        backgroundColor: theme.greenBright,
        marginTop: SPACE.md,
    },
});
