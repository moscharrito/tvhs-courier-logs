/* The top of a screen, drawn one way.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCALES ALREADY EXISTED AND THREE SCREENS IGNORED THEM.
 *
 * theme.ts carries TYPE and SPACE, with a note explaining why: a windscreen
 * glare floor of 16 for anything a courier reads and 17 for anything they act
 * on. Profile uses them. Run has a 32 title, the lead screens I wrote have 28,
 * History has its own, and the subtitles underneath them were 15, 16 and
 * whatever each file happened to pick.
 *
 * Nobody notices one screen. What they notice is the heading moving when they
 * change tab, which reads as two apps stitched together, and this is one app
 * two different people carry.
 *
 * So: one component, the scale it uses is the one in the theme, and a screen
 * that wants a different size has to come here and argue for it.
 *
 * The right-hand slot is for the thing a screen is doing rather than a menu:
 * the live indicator on the counter, a refresh control. It sits on the
 * baseline of the title because a control floating above a 32 point heading
 * looks like it belongs to the status bar.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SPACE, TYPE, theme } from '../theme';

export function ScreenHeader({ title, subtitle, right }: {
    title: string;
    /** One line. What this screen is for, or what it is showing right now. */
    subtitle?: string | undefined;
    /** A control belonging to this screen, not to the app. */
    right?: ReactNode;
}) {
    return (
        <View style={styles.wrap}>
            <View style={styles.row}>
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
                {right !== undefined && <View style={styles.right}>{right}</View>}
            </View>
            {subtitle !== undefined && subtitle !== '' && (
                <Text style={styles.subtitle}>{subtitle}</Text>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { marginBottom: SPACE.md },
    row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: SPACE.sm },
    /* display, not title: this is the one word on screen somebody reads from
       arm's length while holding a crate. */
    title: { fontSize: TYPE.display, fontWeight: '800', color: theme.ink, flexShrink: 1 },
    right: { flexShrink: 0 },
    subtitle: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.xs },
});
