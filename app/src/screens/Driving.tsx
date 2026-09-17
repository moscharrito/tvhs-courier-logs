/* The three things a courier does all day (ticket 7.3).
 *
 * Today's run, work going, and what I asked for. A tab bar, because they are
 * siblings: a driver moves between them a dozen times an hour and none of
 * them is "inside" another.
 *
 * NO ROUTER, AND THAT IS A CHANGE OF MIND WORTH RECORDING. Ticket 7.1 said
 * expo-router would arrive here once there was something to route. Having
 * built it: there is not, yet. These three screens have no history, no back
 * stack, no deep links and no parameters. A router would add a dependency, a
 * directory move and a build-time plugin to produce the same three taps, and
 * I cannot run this app to find out what it broke.
 *
 * What WILL earn it is ticket 7.4: a push notification that opens one stop is
 * a deep link, and deep links are what routers are for. Adding it then means
 * adding it for a reason.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import type { Project } from '../lib/api';
import { Run } from './Run';
import { Board } from './Board';
import { Requests } from './Requests';

type Tab = 'run' | 'board' | 'asked';

interface Props {
    token: string;
    project: Project;
    onSignedOut: () => void;
    onBack: () => void;
}

const TABS: Array<{ key: Tab; label: string }> = [
    { key: 'run', label: 'Today' },
    { key: 'board', label: 'Work going' },
    { key: 'asked', label: 'Asked' },
];

export function Driving({ token, project, onSignedOut, onBack }: Props) {
    const [tab, setTab] = useState<Tab>('run');

    return (
        <View style={styles.wrap}>
            <View style={styles.body}>
                {tab === 'run' && (
                    <Run token={token} project={project} onSignedOut={onSignedOut} onBack={onBack} />
                )}
                {tab === 'board' && (
                    <Board token={token} code={project.code} onSignedOut={onSignedOut} />
                )}
                {tab === 'asked' && (
                    <Requests token={token} code={project.code} onSignedOut={onSignedOut} />
                )}
            </View>

            <View style={styles.tabs}>
                {TABS.map((t) => (
                    <Pressable
                        key={t.key}
                        style={styles.tab}
                        onPress={() => setTab(t.key)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: tab === t.key }}
                    >
                        <Text style={[styles.tabText, tab === t.key ? styles.tabTextOn : null]}>{t.label}</Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.bg },
    body: { flex: 1 },
    tabs: {
        flexDirection: 'row', borderTopWidth: 1, borderTopColor: theme.line,
        backgroundColor: theme.card, paddingBottom: 20,
    },
    /* Deliberately tall. This is pressed with a thumb, often in a van, often
       by somebody holding a package in the other hand. */
    tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
    tabText: { fontSize: 14, color: theme.muted },
    tabTextOn: { color: theme.green, fontWeight: '700' },
});
