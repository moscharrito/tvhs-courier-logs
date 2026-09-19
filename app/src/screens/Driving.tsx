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
import { StyleSheet, View } from 'react-native';
import { Ground } from '../ui/Glass';
import { TabBar, type TabDef } from '../ui/Nav';
import { AskedIcon, BoardIcon, RouteIcon } from '../ui/Icons';
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

const TABS: ReadonlyArray<TabDef<Tab>> = [
    { key: 'run', label: 'Today', Icon: RouteIcon, hint: 'The stops assigned to you today' },
    { key: 'board', label: 'Work going', Icon: BoardIcon, hint: 'Deliveries you can ask for' },
    { key: 'asked', label: 'Asked', Icon: AskedIcon, hint: 'What you have asked for and the answers' },
];

export function Driving({ token, project, onSignedOut, onBack }: Props) {
    const [tab, setTab] = useState<Tab>('run');

    return (
        <Ground>
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

            <TabBar tabs={TABS} current={tab} onChange={setTab} />
        </Ground>
    );
}

const styles = StyleSheet.create({
    /* The tab bar floats over the ground rather than sitting on a white
       strip, so the glass has something to be translucent against. */
    body: { flex: 1 },
});
