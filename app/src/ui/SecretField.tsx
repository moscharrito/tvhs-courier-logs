/* A password box a courier can look at.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SAME REASON AS THE WEB, AND MORE OF IT.
 *
 * The passwords this system hands out are generated and sixteen characters
 * long, and on a phone they are typed with a thumb, on a small keyboard,
 * often in a van or at a counter. Typed blind behind dots, a transposed
 * character is not a typo: it is a courier who cannot sign in at seven in
 * the morning, and a telephone call to dispatch.
 *
 * Hiding a password protects it from somebody looking over a shoulder. Being
 * unable to CHECK it protects nothing.
 *
 * OFF BY DEFAULT and per field, because the person holding the phone is the
 * one who knows whether anybody is behind them, and because the field worth
 * revealing is usually the new password rather than the old one.
 *
 * The control is a real button with an accessible label that changes with
 * the state. It is also TAP.minimum across, because everything on this screen
 * is pressed by a thumb and a 20 point eye icon is not.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';

type Props = Omit<TextInputProps, 'secureTextEntry'> & {
    label: string;
    /** Marks the field when what is in it is wrong, as the web one does. */
    invalid?: boolean;
};

export function SecretField({ label, invalid = false, style, ...input }: Props) {
    const [shown, setShown] = useState(false);

    return (
        <View>
            <Text style={styles.label}>{label}</Text>
            <View style={styles.row}>
                <TextInput
                    {...input}
                    style={[styles.input, invalid ? styles.inputWrong : null, style]}
                    secureTextEntry={!shown}
                    /* Never corrected or capitalised, whatever the keyboard
                       would like to do: a password is not a word. */
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel={label}
                />
                <Pressable
                    onPress={() => setShown((was) => !was)}
                    style={styles.toggle}
                    accessibilityRole="button"
                    accessibilityState={{ selected: shown }}
                    accessibilityLabel={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
                    /* The icon is small; the thing a thumb lands on is not. */
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Text style={[styles.toggleText, shown ? styles.toggleOn : null]}>
                        {shown ? 'Hide' : 'Show'}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    label: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.md },
    row: { position: 'relative', justifyContent: 'center' },
    input: {
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        paddingHorizontal: SPACE.md,
        /* Room for the control, so a long password does not run under it. */
        paddingRight: 76,
        paddingVertical: 14,
        fontSize: TYPE.body,
        color: theme.ink,
        marginTop: SPACE.xs,
    },
    inputWrong: { borderColor: theme.danger },
    toggle: {
        position: 'absolute',
        right: 0,
        height: TAP.minimum,
        minWidth: 68,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: SPACE.md,
    },
    /* Words rather than an eye glyph. An icon needs a legend and this screen
       is read once, in a hurry, by somebody who has never seen it before. */
    toggleText: { fontSize: TYPE.meta, fontWeight: '700', color: theme.muted },
    toggleOn: { color: theme.green },
});
