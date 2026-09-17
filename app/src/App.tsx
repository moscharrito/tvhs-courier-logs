/* The shell (ticket 7.1).
 *
 * Signed out, applying, waiting to be approved, picking a contract, driving.
 * Plain state rather than a navigation library, on purpose: one linear path
 * does not need a router, and expo-router arrives in 7.3 when the board, a
 * stop and the request queue give it something to route. A dependency added
 * before it earns its place is a dependency nobody can later argue with.
 *
 * AN APPLICANT WITH NO MEMBERSHIP LANDS ON THEIR APPLICATION, not on an
 * empty list of contracts (ticket 7.2). Since the DoorDash change in 6.1 an
 * account exists from the moment somebody applies and belongs to no project
 * until they are approved, so "no projects" is the ordinary state of a real
 * person waiting on us, not an error. Showing them a blank screen would be
 * the app's way of saying nothing is happening.
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
import { Apply } from './screens/Apply';
import { Onboarding } from './screens/Onboarding';
import { Projects } from './screens/Projects';
import { Run } from './screens/Run';

export function App() {
    /* undefined while the Keychain is being read, null when there is nothing
       in it. The distinction matters: rendering the sign-in screen for the
       half second before the token loads would flash a password box at
       somebody who is already signed in. */
    const [token, setToken] = useState<string | null | undefined>(undefined);
    const [project, setProject] = useState<Project | null>(null);
    const [applying, setApplying] = useState(false);
    /* Undefined until the project list comes back. Null once it has and there
       is nothing on it, which is what sends somebody to their application. */
    const [hasProjects, setHasProjects] = useState<boolean | undefined>(undefined);

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
        setHasProjects(undefined);
        setApplying(false);
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
                applying
                    ? <Apply onDone={() => setApplying(false)} onCancel={() => setApplying(false)} />
                    : <SignIn onSignedIn={onSignedIn} onApply={() => setApplying(true)} />
            ) : hasProjects === false ? (
                /* Signed in, on no contract. Not an error: it is what every
                   applicant looks like until somebody approves them. */
                <Onboarding token={token} onSignedOut={onSignedOut} />
            ) : project === null ? (
                <Projects
                    token={token}
                    onPick={setProject}
                    onSignedOut={onSignedOut}
                    onEmpty={() => setHasProjects(false)}
                />
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
