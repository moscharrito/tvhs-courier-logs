/* Who am I signed in as, and how do I get out.
 *
 * Added because there was no answer to either question anywhere in the app
 * except the onboarding screen, which an approved courier never sees again.
 * A driver handed a shared phone could not tell whose account was on it.
 *
 * SIGNING OUT IS THE POINT OF THIS SCREEN, and it is deliberately not a
 * small icon in a corner: it ends a shift's worth of context, and on a
 * shared phone it is the thing that stops one courier recording deliveries
 * under another's name. It also empties the offline queue, which is why the
 * button says so rather than leaving somebody to wonder.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CardButton, Chip, Ground, Notice, Panel } from '../ui/Glass';
import { BackPill } from '../ui/Nav';
import { ShiftIcon } from '../ui/Icons';
import { SPACE, TYPE, theme } from '../theme';
import type { Project } from '../lib/api';

export function Profile({ username, project, queued, onBack, onSwitchContract, onSignOut }: {
    username: string;
    project: Project;
    /** How many writes are still waiting to send. */
    queued: number;
    onBack: () => void;
    onSwitchContract: () => void;
    onSignOut: () => void;
}) {
    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap}>
                <BackPill label="Today" onPress={onBack} />

                <Text style={styles.title}>Your account</Text>

                <Panel style={styles.panel}>
                    <Text style={styles.label}>Signed in as</Text>
                    <Text style={styles.value}>{username}</Text>

                    <Text style={styles.label}>Driving for</Text>
                    <Text style={styles.value}>{project.name}</Text>
                    <View style={styles.chips}>
                        <Chip label={project.role} />
                        <Chip label={project.timezone} />
                    </View>
                </Panel>

                {/* Said before the sign-out button rather than after it, so
                    nobody discovers it by losing work. */}
                {queued > 0 && (
                    <Notice
                        tone="warn"
                        text={`${queued} ${queued === 1 ? 'thing is' : 'things are'} still waiting to send. `
                            + 'Signing out now discards them: wait for signal first if you can.'}
                    />
                )}

                <Panel style={styles.panel}>
                    <CardButton
                        title="Switch contract"
                        Icon={ShiftIcon}
                        detail="Back to the contract list. You stay signed in."
                        tone="secondary"
                        onPress={onSwitchContract}
                    />
                    <CardButton
                        title="Sign out"
                        detail="Ends this session on this phone and empties anything still queued."
                        tone="danger"
                        onPress={onSignOut}
                    />
                </Panel>

                <Text style={styles.footnote}>
                    Sign out if somebody else is taking this phone. Deliveries are recorded against whoever is
                    signed in, and there is no way to correct that afterwards.
                </Text>
            </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { padding: SPACE.lg, paddingTop: 56, paddingBottom: 40 },
    title: { fontSize: TYPE.display, fontWeight: '800', color: theme.ink, marginTop: SPACE.md, marginBottom: SPACE.lg },
    panel: { marginBottom: SPACE.md },
    label: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.sm },
    value: { fontSize: TYPE.heading, fontWeight: '700', color: theme.ink, marginTop: 2 },
    chips: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
    footnote: { fontSize: TYPE.meta, color: theme.muted, lineHeight: 21, marginTop: SPACE.sm },
});
