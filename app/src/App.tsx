/* The shell (ticket 7.1).
 *
 * Three screens and the state between them: signed out, picking a contract,
 * driving. Plain state rather than a navigation library, on purpose. Three
 * screens with one linear path do not need a router, and expo-router arrives
 * in 7.3 when the board, a stop and the request queue give it something to
 * route. A dependency added before it earns its place is a dependency nobody
 * can later argue with.
 *
 * ONE PLACE DECIDES WHAT A DEAD CREDENTIAL MEANS. Every screen that touches
 * the API takes `onSignedOut` and calls it on a 401, and this is where that
 * lands: forget the token in memory, delete it from the Keychain, and show
 * the sign-in screen. A courier whose session expired mid-round should see a
 * password box, not an error they cannot act on.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { theme } from './theme';
import { clearToken, loadToken, saveToken } from './lib/session';
import { signOut, type Project } from './lib/api';
import { SignIn } from './screens/SignIn';
import { Projects } from './screens/Projects';
import { Run } from './screens/Run';

export function App() {
    /* undefined while the Keychain is being read, null when there is nothing
       in it. The distinction matters: rendering the sign-in screen for the
       half second before the token loads would flash a password box at
       somebody who is already signed in. */
    const [token, setToken] = useState<string | null | undefined>(undefined);
    const [project, setProject] = useState<Project | null>(null);

    useEffect(() => {
        void loadToken().then((found) => setToken(found));
    }, []);

    const onSignedIn = useCallback((fresh: string) => {
        setToken(fresh);
        /* Saved after the state, not before. If the Keychain refuses, the
           session still works for as long as the app is open, which is a bad
           day rather than a courier who cannot sign in at all. */
        void saveToken(fresh);
    }, []);

    const onSignedOut = useCallback(() => {
        const had = token;
        setToken(null);
        setProject(null);
        void clearToken();
        /* Best effort, and after the local sign-out. The point of telling the
           server is to revoke the row so the token cannot be replayed; the
           point of not waiting is that a courier tapping Sign out with no
           signal is still signed out of this phone. */
        if (had) void signOut(had).catch(() => undefined);
    }, [token]);

    if (token === undefined) {
        return (
            <View style={styles.centre}>
                <StatusBar style="dark" />
                <ActivityIndicator color={theme.green} />
            </View>
        );
    }

    return (
        <View style={styles.root}>
            <StatusBar style="dark" />
            {token === null ? (
                <SignIn onSignedIn={onSignedIn} />
            ) : project === null ? (
                <Projects token={token} onPick={setProject} onSignedOut={onSignedOut} />
            ) : (
                <Run
                    token={token}
                    project={project}
                    onSignedOut={onSignedOut}
                    onBack={() => setProject(null)}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    centre: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
});
