/* The first screen: which contract are you driving today.
 *
 * Before the password, because a driver knows which vans they drive before
 * they know their password, and because the app used to hardcode `uh` at
 * signup, which was wrong the moment Izy ran two contracts.
 *
 * IT GRANTS NOTHING. See the header of lib/contracts.ts: this is
 * unauthenticated and anybody holding the phone can tap either card. Access
 * is still the membership the server returns after sign-in, and a driver who
 * taps the wrong one is told so by name once they are signed in.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CardButton, Ground, Panel } from '../ui/Glass';
import { CONTRACTS, type Contract } from '../lib/contracts';
import { RADIUS, SPACE, TYPE, theme } from '../theme';

export function ChooseContract({ onChoose }: { onChoose: (contract: Contract) => void }) {
    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap}>
                {/* Centred, which is what was asked for and is also the only
                    arrangement that works here: there is nothing else on the
                    screen to align a left edge against. */}
                <View style={styles.brand}>
                    <Text style={styles.wordmark}>TAG</Text>
                    <Text style={styles.company}>Izy Global Services LLC</Text>
                </View>

                <Panel style={styles.panel}>
                    <Text style={styles.title}>Select Contract</Text>
                    {CONTRACTS.map((c) => (
                        <CardButton
                            key={c.code}
                            title={c.name}
                            detail={c.detail}
                            tone={c.code === 'uh' ? 'primary' : 'secondary'}
                            onPress={() => onChoose(c)}
                            accessibilityHint="Opens the sign in screen for this contract"
                        />
                    ))}
                </Panel>

            </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.lg },
    brand: { alignItems: 'center', marginBottom: SPACE.xl },
    wordmark: {
        fontSize: 46,
        fontWeight: '800',
        color: theme.green,
        letterSpacing: 2,
        textAlign: 'center',
    },
    company: {
        fontSize: TYPE.label,
        color: theme.muted,
        marginTop: SPACE.xs,
        textAlign: 'center',
    },
    panel: { borderRadius: RADIUS.card },
    title: {
        fontSize: TYPE.title,
        fontWeight: '700',
        color: theme.ink,
        textAlign: 'center',
        /* The explanation under this used to carry the gap. */
        marginBottom: SPACE.lg,
    },
});
