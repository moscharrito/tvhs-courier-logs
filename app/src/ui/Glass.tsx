/* The glass pieces every screen is built from.
 *
 * One file, so "make the buttons bigger" is one change rather than ten, and
 * so a screen cannot quietly ship a 13px tap target again. Every control
 * here is at least TAP.minimum tall and nothing carries an unlabelled icon.
 */

import type { ReactNode } from 'react';
import {
    ActivityIndicator, Pressable, StyleSheet, Text, View,
    type StyleProp, type ViewStyle,
} from 'react-native';
import { GLASS, GROUND, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';

/* The gradient ground, without pulling in expo-linear-gradient for three
   bands. Three stacked Views cost nothing and cannot fail to install. */
export function Ground({ children }: { children: ReactNode }) {
    return (
        <View style={styles.ground}>
            <View style={[styles.band, { backgroundColor: GROUND.top, flex: 3 }]} />
            <View style={[styles.band, { backgroundColor: GROUND.middle, flex: 4 }]} />
            <View style={[styles.band, { backgroundColor: GROUND.bottom, flex: 3 }]} />
            <View style={styles.groundContent}>{children}</View>
        </View>
    );
}

/** A translucent panel. The default surface for anything grouped. */
export function Panel({ children, style, strong = false }: {
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
    /** Use on a sheet that sits above content and must stay readable. */
    strong?: boolean;
}) {
    return (
        <View
            style={[
                styles.panel,
                { backgroundColor: strong ? GLASS.fillStrong : GLASS.fill },
                style,
            ]}
        >
            {children}
        </View>
    );
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE BOTTOM SHEET, which is the shape a rideshare app has and this one now
 * borrows: context above, everything you can DO in a panel at the bottom,
 * where a thumb reaches without the hand moving.
 * ───────────────────────────────────────────────────────────────────────── */
export function Sheet({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
    return (
        <View style={[styles.sheet, style]}>
            {/* The grabber. Decoration, and it is what makes the shape read
                as a sheet rather than as a footer. */}
            <View style={styles.grabber} />
            {children}
        </View>
    );
}

export type ButtonTone = 'primary' | 'secondary' | 'danger' | 'quiet';

/**
 * A button that is a card.
 *
 * `title` is the action. `detail` is the sentence under it, and it is the
 * reason these are cards rather than pills: a courier deciding between
 * "Collect from the pharmacy" and "Take undelivered back" is helped more by
 * a line of explanation than by a tidier row of chips.
 */
export function CardButton({ title, detail, onPress, tone = 'primary', disabled = false, busy = false, accessibilityHint }: {
    title: string;
    detail?: string;
    onPress: () => void;
    tone?: ButtonTone;
    disabled?: boolean;
    busy?: boolean;
    accessibilityHint?: string;
}) {
    const off = disabled || busy;
    return (
        <Pressable
            onPress={onPress}
            disabled={off}
            accessibilityRole="button"
            accessibilityState={{ disabled: off, busy }}
            {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
            style={({ pressed }) => [
                styles.cardButton,
                toneStyles[tone].box,
                /* Pressed state is a lift rather than a colour change, so it
                   reads through sunglasses and in direct sun. */
                pressed && !off && styles.pressed,
                off && styles.disabled,
            ]}
        >
            <View style={styles.cardButtonText}>
                <Text style={[styles.cardButtonTitle, toneStyles[tone].title]}>{title}</Text>
                {detail !== undefined && (
                    <Text style={[styles.cardButtonDetail, toneStyles[tone].detail]}>{detail}</Text>
                )}
            </View>
            {busy && <ActivityIndicator color={tone === 'primary' || tone === 'danger' ? '#fff' : theme.green} />}
        </Pressable>
    );
}

/** A short label on a translucent chip. Never the only way something is said. */
export function Chip({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'warn' | 'bad' | 'good' }) {
    return (
        <View style={[styles.chip, chipTones[tone].box]}>
            <Text style={[styles.chipText, chipTones[tone].text]}>{label}</Text>
        </View>
    );
}

/** A sentence the courier has to be able to act on. Never a bare code. */
export function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' | 'bad' }) {
    return (
        <View
            style={[styles.notice, noticeTones[tone].box]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
        >
            <Text style={[styles.noticeText, noticeTones[tone].text]}>{text}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    ground: { flex: 1, backgroundColor: GROUND.middle },
    band: { width: '100%' },
    /* absoluteFillObject is gone from the RN 0.86 types; the four edges
       spelled out is the same thing and does not depend on a typing. */
    groundContent: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },

    panel: {
        borderRadius: RADIUS.card,
        borderWidth: 1,
        borderColor: GLASS.border,
        padding: SPACE.lg,
        ...GLASS.shadow,
    },

    sheet: {
        backgroundColor: GLASS.fillStrong,
        borderTopLeftRadius: RADIUS.sheet,
        borderTopRightRadius: RADIUS.sheet,
        borderTopWidth: 1,
        borderColor: GLASS.border,
        paddingHorizontal: SPACE.lg,
        paddingTop: SPACE.sm,
        paddingBottom: SPACE.xl,
        ...GLASS.shadowLifted,
    },
    grabber: {
        alignSelf: 'center',
        width: 44,
        height: 5,
        borderRadius: RADIUS.pill,
        backgroundColor: 'rgba(17,24,39,0.18)',
        marginBottom: SPACE.md,
    },

    cardButton: {
        minHeight: TAP.primary,
        borderRadius: RADIUS.button,
        borderWidth: 1,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        marginBottom: SPACE.sm,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACE.md,
    },
    cardButtonText: { flex: 1 },
    cardButtonTitle: { fontSize: TYPE.body, fontWeight: '700' },
    cardButtonDetail: { fontSize: TYPE.meta, marginTop: 3, lineHeight: 20 },
    pressed: { transform: [{ scale: 0.985 }], opacity: 0.92 },
    disabled: { opacity: 0.45 },

    chip: {
        minHeight: 30,
        justifyContent: 'center',
        paddingHorizontal: SPACE.sm + 2,
        borderRadius: RADIUS.pill,
        borderWidth: 1,
    },
    chipText: { fontSize: TYPE.meta, fontWeight: '600' },

    notice: {
        borderRadius: RADIUS.button,
        borderWidth: 1,
        padding: SPACE.md,
        marginBottom: SPACE.sm,
    },
    noticeText: { fontSize: TYPE.label, lineHeight: 23 },
});

const toneStyles: Record<ButtonTone, { box: ViewStyle; title: object; detail: object }> = {
    primary: {
        box: { backgroundColor: GLASS.fillGreen, borderColor: 'rgba(255,255,255,0.22)' },
        title: { color: '#ffffff' },
        detail: { color: 'rgba(255,255,255,0.82)' },
    },
    secondary: {
        box: { backgroundColor: GLASS.fill, borderColor: GLASS.border },
        title: { color: theme.green },
        detail: { color: theme.muted },
    },
    danger: {
        box: { backgroundColor: 'rgba(185,28,28,0.92)', borderColor: 'rgba(255,255,255,0.2)' },
        title: { color: '#ffffff' },
        detail: { color: 'rgba(255,255,255,0.85)' },
    },
    quiet: {
        box: { backgroundColor: 'rgba(255,255,255,0.4)', borderColor: GLASS.borderSubtle },
        title: { color: theme.ink },
        detail: { color: theme.muted },
    },
};

const chipTones = {
    neutral: { box: { backgroundColor: 'rgba(255,255,255,0.6)', borderColor: GLASS.borderSubtle }, text: { color: theme.muted } },
    good: { box: { backgroundColor: 'rgba(22,163,74,0.14)', borderColor: 'rgba(22,163,74,0.3)' }, text: { color: '#166534' } },
    warn: { box: { backgroundColor: 'rgba(217,119,6,0.14)', borderColor: 'rgba(217,119,6,0.3)' }, text: { color: '#92400e' } },
    bad: { box: { backgroundColor: 'rgba(185,28,28,0.12)', borderColor: 'rgba(185,28,28,0.3)' }, text: { color: theme.danger } },
} as const;

const noticeTones = {
    info: { box: { backgroundColor: 'rgba(255,255,255,0.62)', borderColor: GLASS.borderSubtle }, text: { color: theme.ink } },
    warn: { box: { backgroundColor: 'rgba(217,119,6,0.12)', borderColor: 'rgba(217,119,6,0.32)' }, text: { color: '#92400e' } },
    bad: { box: { backgroundColor: 'rgba(185,28,28,0.1)', borderColor: 'rgba(185,28,28,0.32)' }, text: { color: theme.danger } },
} as const;
