/* The TVHS driver shell: the web's sidebar, as a glass footer.
 *
 * The web puts DAILY WORK (New Entry) and RECORDS (My Logs, My Check-Ins) in
 * a left rail. A phone has no room for a rail and a thumb cannot reach the
 * top of one, so the same three destinations sit in the footer, which is
 * where the rest of this app already puts them.
 *
 * Nothing else moves. The three screens carry the same cards, in the same
 * order, with the same numbers.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ground, Notice } from '../../ui/Glass';
import { TabBar, TopBar, type TabDef } from '../../ui/Nav';
import { BoardIcon, RouteIcon, ShiftIcon } from '../../ui/Icons';
import { SPACE, TYPE, theme } from '../../theme';
import { get } from '../../lib/api';
import { ApiError, isUnauthorized } from '../../lib/http';
import { NewEntry } from './NewEntry';
import { MyLogs, MyCheckins } from './Records';

type Tab = 'entry' | 'logs' | 'checkins';

const TABS: ReadonlyArray<TabDef<Tab>> = [
    { key: 'entry', label: 'New Entry', Icon: RouteIcon, hint: 'Check in and log this week’s routes' },
    { key: 'logs', label: 'My Logs', Icon: BoardIcon, hint: 'The legs you have filed' },
    { key: 'checkins', label: 'Check-Ins', Icon: ShiftIcon, hint: 'The days you clocked on' },
];

export function TvhsShell({ token, route, name, onSignedOut, onBack }: {
    token: string;
    route: string;
    name: string;
    onSignedOut: () => void;
    onBack: () => void;
}) {
    const [tab, setTab] = useState<Tab>('entry');
    /* The server's date, fetched once and handed to every tab, so the three
       screens cannot disagree about what today is. */
    const [today, setToday] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const config = await get<{ today: string }>('/api/config', token);
            setToday(config.today);
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach the server.');
        }
    }, [token, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    return (
        <Ground>
            <View style={styles.header}>
                <TopBar backLabel="Contracts" onBack={onBack} onSignOut={onSignedOut} />
                <Text style={styles.title}>{TABS.find((t) => t.key === tab)?.label}</Text>
                <Text style={styles.sub}>{name} · {route}</Text>
            </View>

            <View style={styles.body}>
                {today === null ? (
                    <View style={styles.centre}>
                        {error === null
                            ? <ActivityIndicator color={theme.green} />
                            : <Notice text={error} tone="bad" />}
                    </View>
                ) : (
                    <>
                        {tab === 'entry' && <NewEntry token={token} route={route} onSignedOut={onSignedOut} />}
                        {tab === 'logs' && <MyLogs token={token} today={today} onSignedOut={onSignedOut} />}
                        {tab === 'checkins' && <MyCheckins token={token} today={today} onSignedOut={onSignedOut} />}
                    </>
                )}
            </View>

            <TabBar tabs={TABS} current={tab} onChange={setTab} />
        </Ground>
    );
}

const styles = StyleSheet.create({
    header: { paddingHorizontal: SPACE.lg, paddingTop: 56, paddingBottom: SPACE.sm },
    title: { fontSize: TYPE.title, fontWeight: '800', color: theme.ink, marginTop: SPACE.sm },
    sub: { fontSize: TYPE.label, color: theme.muted, marginTop: 2 },
    body: { flex: 1 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
});
