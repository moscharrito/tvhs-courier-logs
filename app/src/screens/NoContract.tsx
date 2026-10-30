/* "You are signed in and you are not on a contract."
 *
 * This slot used to hold Onboarding: the applicant's own screen, where
 * somebody who had applied from the app watched their background check and
 * their licence tick over until a person approved them.
 *
 * That whole path came out on 30 October. Drivers on this contract are
 * onboarded by us and their accounts are created with a counter already
 * assigned, so an account on no contract is no longer a person waiting their
 * turn -- it is an account we have not finished setting up.
 *
 * So the screen says who to ring. There is deliberately nothing to fill in:
 * a form here would imply the driver can move this along, and they cannot.
 * The only thing they could usefully be told is that somebody at the office
 * has to add them, and that it takes a minute once asked.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import { SPACE, TYPE, theme } from '../theme';

export function NoContract({ onSignedOut }: { onSignedOut: () => void }) {
    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap}>
                <View style={styles.brand}>
                    <Text style={styles.wordmark}>TAG</Text>
                    <Text style={styles.company}>Izy Global Services LLC</Text>
                </View>

                <Panel>
                    <Text style={styles.title}>Your account is not on a contract</Text>

                    <Notice
                        tone="info"
                        text={'You are signed in, so your password is right. Nobody has added you '
                            + 'to a contract yet, which is something only the office can do.'}
                    />

                    <CardButton
                        title="Sign out"
                        detail="Nothing is lost. Sign in again once the office has added you."
                        tone="quiet"
                        onPress={onSignedOut}
                    />
                </Panel>

                <Text style={styles.footnote}>
                    Ring the Izy Global office and say your account has no contract on it. It is a
                    one-minute fix at their end, and there is nothing on this screen that speeds it up.
                </Text>
            </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.lg },
    brand: { alignItems: 'center', marginBottom: SPACE.lg },
    wordmark: { fontSize: TYPE.display, fontWeight: '800', color: theme.green, letterSpacing: 0.5 },
    company: { fontSize: TYPE.meta, color: theme.muted, marginTop: 2 },
    title: { fontSize: TYPE.heading, fontWeight: '700', color: theme.ink, marginBottom: SPACE.md },
    footnote: { fontSize: TYPE.meta, color: theme.muted, lineHeight: 20, textAlign: 'center', marginTop: SPACE.lg },
});
