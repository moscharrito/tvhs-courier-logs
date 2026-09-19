/* "You are signed in, but not on this contract."
 *
 * Its own screen rather than an error banner, because it is not a failure
 * the driver caused and there is something useful to do about it. Two of the
 * three outcomes here are ordinary states of a real person:
 *
 *   wrongContract   they drive for the other one and tapped the wrong card
 *   noMembership    they applied and we have not finished checking (6.1)
 *
 * Neither is "access denied", and neither should read like it.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import type { ChoiceOutcome } from '../lib/contracts';
import { SPACE, TYPE, theme } from '../theme';

export function WrongContract({ outcome, onSwitch, onSignOut }: {
    outcome: Extract<ChoiceOutcome, { kind: 'wrongContract' } | { kind: 'noMembership' }>;
    /** Jump straight to a contract they do belong to. */
    onSwitch: (code: string) => void;
    onSignOut: () => void;
}) {
    const waiting = outcome.kind === 'noMembership';
    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap}>
                <View style={styles.brand}>
                    <Text style={styles.wordmark}>TAG</Text>
                    <Text style={styles.company}>Izy Global Services LLC</Text>
                </View>

                <Panel>
                    <Text style={styles.title}>
                        {waiting ? 'Not on this contract yet' : 'Wrong contract'}
                    </Text>

                    <Notice text={outcome.message} tone={waiting ? 'info' : 'warn'} />

                    {/* The switch, when there is somewhere to switch to. One
                        tap rather than sign out, choose again, sign in. */}
                    {outcome.kind === 'wrongContract' && outcome.belongsTo.map((m) => (
                        <CardButton
                            key={m.code}
                            title={`Open ${m.name}`}
                            detail="The contract your account is on"
                            tone="primary"
                            onPress={() => onSwitch(m.code)}
                        />
                    ))}

                    <CardButton
                        title="Sign out"
                        detail={waiting
                            ? 'Your application keeps its place. Nothing is lost.'
                            : 'Use a different account'}
                        tone="quiet"
                        onPress={onSignOut}
                    />
                </Panel>

                <Text style={styles.footnote}>
                    {waiting
                        ? 'Onboarding is checked by a person, not automatically. Nothing you do here speeds it up.'
                        : 'If you believe you should be on this contract, ring dispatch. Nobody can grant it from the app.'}
                </Text>
            </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.lg },
    brand: { alignItems: 'center', marginBottom: SPACE.xl },
    wordmark: { fontSize: 46, fontWeight: '800', color: theme.green, letterSpacing: 2, textAlign: 'center' },
    company: { fontSize: TYPE.label, color: theme.muted, marginTop: SPACE.xs, textAlign: 'center' },
    title: {
        fontSize: TYPE.title,
        fontWeight: '700',
        color: theme.ink,
        textAlign: 'center',
        marginBottom: SPACE.md,
    },
    footnote: {
        fontSize: TYPE.meta,
        color: theme.muted,
        textAlign: 'center',
        lineHeight: 21,
        marginTop: SPACE.lg,
        paddingHorizontal: SPACE.sm,
    },
});
