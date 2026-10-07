/* What a courier does all day.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THREE TABS, AND IT USED TO BE FIVE.
 *
 * Today, Work, Asked, History, You. Two of those were a driver browsing
 * unassigned deliveries and asking for the ones they fancied, which is not
 * the operating model University Health were shown: dispatch assigns from the
 * forecast, and a site lead moves a package at the counter when somebody is
 * late. A courier picking their own stops would compete with both.
 *
 * So Work and Asked are gone, along with lib/work.ts behind them. What is
 * left is the shape the job actually has: the round, what I have finished,
 * and who I am.
 *
 * It also fixes a thing five tabs caused. Five labels share a 390 point
 * phone, which is about 75 points each, and "Work going" truncated to
 * "Work goin..." at 14pt; the label was shortened to "Work" to live with it.
 * Three tabs have room for a word that means something.
 *
 * The lead shell next door is also three. That is not a coincidence worth
 * undoing: two people carrying the same app in the same pocket should not
 * have to learn two different shapes.
 *
 * NO ROUTER, STILL. These screens have no history, no back stack, no deep
 * links and no parameters. Ticket 7.4's push notification that opens one stop
 * is a deep link and is what will earn one.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ground } from '../ui/Glass';
import { TabBar, type TabDef } from '../ui/Nav';
import { HistoryIcon, ProfileIcon, RouteIcon } from '../ui/Icons';
import { Profile } from './Profile';
import { readQueue } from '../lib/queue';
import type { Project } from '../lib/api';
import { Run } from './Run';
import { History } from './History';

type Tab = 'run' | 'history' | 'you';

interface Props {
    token: string;
    project: Project;
    username: string;
    onSignedOut: () => void;
    onBack: () => void;
}

const TABS: ReadonlyArray<TabDef<Tab>> = [
    { key: 'run', label: 'Today', Icon: RouteIcon, hint: 'The stops assigned to you today' },
    { key: 'history', label: 'History', Icon: HistoryIcon, hint: 'The deliveries you have already finished' },
    /* Who is signed in and how to get out, which had no home anywhere in the
       app: an approved courier never sees the onboarding screen again, so a
       driver handed a shared phone could not tell whose account was on it. */
    { key: 'you', label: 'You', Icon: ProfileIcon, hint: 'Your account, switching contract, and signing out' },
];

export function Driving({ token, project, username, onSignedOut, onBack }: Props) {
    const [tab, setTab] = useState<Tab>('run');
    /* Only so the profile screen can warn before signing out discards them. */
    const [queued, setQueued] = useState(0);

    useEffect(() => {
        if (tab !== 'you') return;
        void readQueue().then((s) => setQueued(s.queue.length));
    }, [tab]);

    return (
        <Ground>
            <View style={styles.body}>
                {tab === 'run' && (
                    <Run token={token} project={project} onSignedOut={onSignedOut} onBack={onBack} />
                )}
                {tab === 'history' && (
                    <History token={token} code={project.code} onSignedOut={onSignedOut} />
                )}
                {tab === 'you' && (
                    <Profile
                        token={token}
                        username={username}
                        project={project}
                        queued={queued}
                        onBack={() => setTab('run')}
                        onSwitchContract={onBack}
                        onSignOut={onSignedOut}
                    />
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
