/* Navigation: the tab bar and the back control.
 *
 * Both were bare text before. "Contracts" in green at the top left was a
 * link only because it was green, and the tab bar was three words with
 * nothing to aim at.
 *
 * ICON AND WORD, ALWAYS. See the header of Icons.tsx: the word is not a
 * caption under a glyph, it is the label, and the glyph is what makes it
 * findable at a glance. A courier who has used this twice should not have
 * to decode a pictogram.
 */

import type { ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { BackIcon, SignOutIcon, type IconProps } from './Icons';

export interface TabDef<K extends string> {
    key: K;
    label: string;
    Icon: ComponentType<IconProps>;
    /** Read out instead of the label when there is more to say. */
    hint?: string;
}

/**
 * The bottom bar.
 *
 * Glass, floating clear of the screen edge, so it reads as a layer over the
 * sheet rather than a strip welded to the bottom.
 */
export function TabBar<K extends string>({ tabs, current, onChange }: {
    tabs: ReadonlyArray<TabDef<K>>;
    current: K;
    onChange: (key: K) => void;
}) {
    return (
        <View style={styles.tabWrap}>
            <View style={styles.tabBar}>
                {tabs.map((t) => {
                    const on = t.key === current;
                    return (
                        <Pressable
                            key={t.key}
                            style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && styles.tabPressed]}
                            onPress={() => onChange(t.key)}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: on }}
                            accessibilityLabel={t.label}
                            {...(t.hint === undefined ? {} : { accessibilityHint: t.hint })}
                        >
                            <t.Icon
                                size={24}
                                color={on ? theme.green : theme.muted}
                                /* Weight, not just colour: it reads faster in
                                   sun and survives a colourblind eye. */
                                strokeWidth={on ? 2.3 : 1.8}
                            />
                            <Text style={[styles.tabText, on && styles.tabTextOn]} numberOfLines={1}>
                                {t.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

/**
 * The back control, as a glass pill rather than a coloured word.
 *
 * `label` says where it goes, not "Back": a courier who has been three
 * screens deep wants to know what they are returning to.
 */
export function BackPill({ label, onPress }: { label: string; onPress: () => void }) {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Back to ${label}`}
            style={({ pressed }) => [styles.back, pressed && styles.tabPressed]}
        >
            <BackIcon size={20} color={theme.green} />
            <Text style={styles.backText}>{label}</Text>
        </Pressable>
    );
}

/**
 * Sign out, from anywhere.
 *
 * Small and top-right because it is not the work; labelled all the same,
 * because an unlabelled door glyph on a shared phone is the control nobody
 * presses when they should and somebody presses when they should not.
 */
export function SignOutButton({ onPress }: { onPress: () => void }) {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            accessibilityHint="Ends this session on this phone"
            style={({ pressed }) => [styles.signOut, pressed && styles.tabPressed]}
        >
            <SignOutIcon size={19} color={theme.danger} />
            <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
    );
}

/** Back on the left, sign out on the right, on every secondary screen. */
export function TopBar({ backLabel, onBack, onSignOut }: {
    backLabel: string;
    onBack: () => void;
    onSignOut: () => void;
}) {
    return (
        <View style={styles.topBar}>
            <BackPill label={backLabel} onPress={onBack} />
            <SignOutButton onPress={onSignOut} />
        </View>
    );
}

const styles = StyleSheet.create({
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACE.sm,
    },
    signOut: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.xs,
        minHeight: TAP.minimum,
        paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.pill,
        backgroundColor: 'rgba(185,28,28,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(185,28,28,0.22)',
    },
    signOutText: { color: theme.danger, fontSize: TYPE.meta, fontWeight: '700' },
    /* Floats clear of the edge so the glass has something to sit over. */
    tabWrap: {
        paddingHorizontal: SPACE.md,
        paddingBottom: SPACE.lg,
        paddingTop: SPACE.sm,
        backgroundColor: 'transparent',
    },
    tabBar: {
        flexDirection: 'row',
        backgroundColor: GLASS.fillStrong,
        borderRadius: RADIUS.sheet,
        borderWidth: 1,
        borderColor: GLASS.border,
        padding: SPACE.xs,
        ...GLASS.shadow,
    },
    tab: {
        flex: 1,
        minHeight: TAP.standard,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        borderRadius: RADIUS.button,
        paddingVertical: SPACE.sm,
    },
    /* The selected tab is a lit panel rather than a coloured word. */
    tabOn: { backgroundColor: 'rgba(22,163,74,0.12)' },
    tabPressed: { opacity: 0.6 },
    /* 14 rather than the 15 floor the rest of the app keeps, and the only
       deliberate exception to it. Three tabs share a phone width and one of
       them is "Work going"; at 15 that truncates on a small handset, and a
       truncated label is less readable than a slightly smaller whole one.
       It sits under a 24px icon and carries 600/800 weight, so it is not
       doing the work alone. */
    tabText: { fontSize: 14, color: theme.muted, fontWeight: '600' },
    tabTextOn: { color: theme.green, fontWeight: '800' },

    back: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.xs,
        minHeight: TAP.minimum,
        paddingRight: SPACE.md,
        paddingLeft: SPACE.sm,
        borderRadius: RADIUS.pill,
        backgroundColor: 'rgba(255,255,255,0.6)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
    },
    backText: { color: theme.green, fontSize: TYPE.label, fontWeight: '700' },
});
