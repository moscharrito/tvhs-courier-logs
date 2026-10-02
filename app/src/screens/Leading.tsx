/* What a site lead does all day.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A SEPARATE SHELL, NOT MORE TABS ON THE DRIVER'S.
 *
 * Driving.tsx is five tabs about one person's own round: today, work going,
 * asked, history, you. None of them is a thing a lead does. A lead has a
 * counter and a handful of people in front of it, and bolting that on as a
 * sixth tab would mean every driver carrying a screen they must never use
 * and a lead scrolling past four they do not.
 *
 * The split is on the membership role, which the server already sends with
 * the project. Nothing here grants anything: a lead signing in gets these
 * screens because the server says they are a lead, and the server refuses
 * them everything else regardless of what the app renders.
 *
 * TWO TABS, DELIBERATELY. The counter and the people. Returns intake and the
 * pickup signature are the next two and are not here yet; a tab bar with
 * placeholder tabs is worse than one that grows.
 */

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ground } from '../ui/Glass';
import { TabBar, type TabDef } from '../ui/Nav';
import { BoxIcon, ProfileIcon, ShiftIcon } from '../ui/Icons';
import { Profile } from './Profile';
import { Counter } from './lead/Counter';
import { Drivers } from './lead/Drivers';
import type { Project } from '../lib/api';
import type { ZoneBatch } from '../lib/lead';

type Tab = 'counter' | 'drivers' | 'you';

interface Props {
    token: string;
    project: Project;
    username: string;
    onSignedOut: () => void;
    onBack: () => void;
}

const TABS: ReadonlyArray<TabDef<Tab>> = [
    { key: 'counter', label: 'Counter', Icon: BoxIcon, hint: 'Packages waiting to go out from this pharmacy' },
    { key: 'drivers', label: 'Drivers', Icon: ShiftIcon, hint: 'Who is here and what they are carrying' },
    { key: 'you', label: 'You', Icon: ProfileIcon, hint: 'Your account, switching contract, and signing out' },
];

export function Leading({ token, project, username, onSignedOut, onBack }: Props) {
    const [tab, setTab] = useState<Tab>('counter');
    /* The batch picked up on the counter and carried to the people tab. Held
       here rather than in either screen, because it is the thing the two tabs
       are passing between them and neither of them owns it. */
    const [holding, setHolding] = useState<ZoneBatch | null>(null);

    return (
        <Ground>
            <View style={styles.body}>
                {tab === 'counter' && (
                    <Counter
                        token={token}
                        code={project.code}
                        onSignedOut={onSignedOut}
                        onHandOver={(batch) => { setHolding(batch); setTab('drivers'); }}
                    />
                )}
                {tab === 'drivers' && (
                    <Drivers
                        token={token}
                        code={project.code}
                        onSignedOut={onSignedOut}
                        holding={holding}
                        /* Cleared on the way back, so a lead who wanders into
                           the people tab later is not still holding a pile
                           they handed over an hour ago. */
                        onHandedOver={() => { setHolding(null); setTab('counter'); }}
                    />
                )}
                {tab === 'you' && (
                    <Profile
                        username={username}
                        project={project}
                        queued={0}
                        onBack={() => setTab('counter')}
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
    body: { flex: 1 },
});
