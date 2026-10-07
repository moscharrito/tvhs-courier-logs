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
 * THE CONTRACT IS CHOSEN BEFORE THE PASSWORD. Izy runs two, a driver knows
 * which one they drive before they know their password, and the app used to
 * hardcode `uh` at signup. The choice is a hint and grants nothing: the
 * server's membership list still decides, and a driver who taps the wrong
 * card signs in fine and is then told, by name, which contract is theirs.
 * See lib/contracts.ts.
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
import { clearToken, loadBase, loadToken, saveToken } from './lib/session';
import { clearQueue } from './lib/queue';
import { baseUrl, forgetServer, get, signOut, useContractServer, useServer, type Project } from './lib/api';
import { SignIn } from './screens/SignIn';
import { Apply } from './screens/Apply';
import { Onboarding } from './screens/Onboarding';
import { Projects } from './screens/Projects';
import { Driving } from './screens/Driving';
import { Leading } from './screens/Leading';
import { ChooseContract } from './screens/ChooseContract';
import { Splash } from './screens/Splash';
import { TvhsSignIn } from './screens/TvhsSignIn';
import { TvhsShell } from './screens/tvhs/TvhsShell';
import { WrongContract } from './screens/WrongContract';
import { ChangePassword } from './screens/ChangePassword';
import { outcomeFor, type ChoiceOutcome, type Contract } from './lib/contracts';

export function App() {
    /* undefined while the Keychain is being read, null when there is nothing
       in it. The distinction matters: rendering the sign-in screen for the
       half second before the token loads would flash a password box at
       somebody who is already signed in. */
    /* The wordmark animation, once per launch.
     *
     * Not per sign-out and not per contract switch: a courier signs out at
     * the end of every shift and switching contract is a back button, so
     * replaying it there would put two seconds between a driver and their
     * work several times a day. It sits above `token` deliberately, because
     * the Keychain read below happens WHILE it plays rather than after. */
    const [intro, setIntro] = useState(true);
    const [token, setToken] = useState<string | null | undefined>(undefined);
    const [project, setProject] = useState<Project | null>(null);
    const [applying, setApplying] = useState(false);
    /* Undefined until the project list comes back. Null once it has and there
       is nothing on it, which is what sends somebody to their application. */
    const [hasProjects, setHasProjects] = useState<boolean | undefined>(undefined);
    /* Which contract they said they drive for, before signing in. A hint. */
    const [chosen, setChosen] = useState<Contract | null>(null);

    /* CHOOSING A CONTRACT CHOOSES THE SERVER. TVHS is live on its own; UH is
       still in test on the default one. Done here rather than inside each
       screen so there is exactly one place where it happens, and so it
       happens before the first request of the session. */
    const chooseContract = useCallback((c: Contract | null) => {
        setChosen(c);
        if (c === null) forgetServer(); else useContractServer(c.code);
    }, []);
    /* Set once the server has told us what they actually belong to and it
       does not include what they chose. */
    const [mismatch, setMismatch] = useState<ChoiceOutcome | null>(null);
    /* Shown on the profile screen. Empty until the session call lands, which
       is fine: that screen is several taps away from a cold start. */
    const [who, setWho] = useState('');
    /* THE PASSWORD SOMEBODY ELSE CHOSE.
     *
     * The server refuses everything but the session read, the logout and the
     * change itself for an account in this state, so a client that does not
     * know about it shows a courier a 403 on every screen with no way out.
     *
     * False until the session call says otherwise, deliberately: the gate
     * below must never appear because a request failed. The screens all
     * handle a dead credential already, and a wrong "no" here costs nothing
     * because the server is the thing actually refusing.
     *
     * Today no courier or lead can be in this state at all: mustChangeFor on
     * the server exempts platform-role drivers precisely because this screen
     * did not exist. The exemption comes off once this build is on the
     * phones, and this is what it will land on. */
    const [mustChange, setMustChange] = useState(false);
    /* Which van the PIN signed in to. TVHS only: a route is what picks the
       legs, and the UH side has none. */
    const [tvhs, setTvhs] = useState<{ route: string; name: string } | null>(null);

    /* Check the choice against the truth, once, as soon as we are signed in.
       Deliberately after authentication: nothing before it knows anything. */
    useEffect(() => {
        if (token === null || token === undefined || chosen === null) return;
        let live = true;
        void get<{ username: string; mustChangePassword?: boolean }>('/api/session', token)
            .then((me) => {
                if (!live) return;
                setWho(me.username);
                setMustChange(me.mustChangePassword === true);
            })
            .catch(() => undefined);
        void get<Array<{ code: string; name: string }>>('/api/me/projects', token)
            .then((mine: Array<{ code: string; name: string }>) => {
                if (!live) return;
                const outcome = outcomeFor(chosen.code, mine);
                setMismatch(outcome.kind === 'ok' ? null : outcome);
                /* Feeds the existing applicant path: no memberships at all
                   still means "waiting on us", which Onboarding already says
                   far better than a mismatch screen would. */
                setHasProjects(mine.length > 0);
            })
            /* A failure here is not the place to sign anybody out: the
               screens below make the same call and handle a dead credential
               properly. Leaving `mismatch` null lets them through to it. */
            .catch(() => undefined);
        return () => { live = false; };
    }, [token, chosen]);

    useEffect(() => {
        /* The server first, then the token. A token is only a session on the
           server that minted it, so restoring them the other way round would
           fire the first request at the wrong one. */
        void (async () => {
            const base = await loadBase();
            if (base !== null) useServer(base);
            setToken(await loadToken());
        })();
    }, []);

    const onSignedIn = useCallback((fresh: string) => {
        setToken(fresh);
        /* Saved after the state, not before. If the Keychain refuses, the
           session still works for as long as the app is open, which is a bad
           day rather than a courier who cannot sign in at all. */
        /* Saved with the server that issued it. */
        void saveToken(fresh, baseUrl());
    }, []);

    const onSignedOut = useCallback(() => {
        const had = token;
        setToken(null);
        setProject(null);
        setHasProjects(undefined);
        setApplying(false);
        setMismatch(null);
        setWho('');
        setMustChange(false);
        setTvhs(null);
        /* The contract choice goes too. The next person to hold this phone
           might drive the other one, and a remembered choice would send them
           to a refusal they did not cause. */
        setChosen(null);
        /* The server goes with the contract choice. The next person to hold
           this phone may drive the other one. */
        forgetServer();
        void clearToken();
        /* THE QUEUE GOES TOO, and this call is the bug the owner found: a
           courier signing in after somebody else saw the previous account's
           refusals on their own screen. clearQueue() was written in 7.5 and
           documented as "signing out empties it", and nothing ever called
           it. The web shell has stamped every entry with its owner since
           2.7 for exactly this reason; the app copied the four queue rules
           and not the fifth. It is also a PHI question rather than a tidiness
           one: what sits in that queue is patient names and addresses, and it
           must not outlive the session that created it. */
        void clearQueue();
        /* Best effort, and after the local sign-out. The point of telling the
           server is to revoke the row so the token cannot be replayed; the
           point of not waiting is that a courier tapping Sign out with no
           signal is still signed out of this phone. */
        if (had) void signOut(had).catch(() => undefined);
    }, [token]);

    /* Before the spinner, not instead of it. If the Keychain is slow the
       spinner still gets its turn afterwards; if it is quick, which it
       normally is, nobody ever sees one. */
    if (intro) return <Splash onDone={() => setIntro(false)} />;

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
            {chosen === null ? (
                /* First, before the password. */
                <ChooseContract onChoose={chooseContract} />
            ) : token === null && chosen.code === 'tvhs' ? (
                /* TVHS is two vans, one driver each, a phone in the cab, and
                   a PIN. It has worked that way for months. Sending a TVHS
                   driver to the UH password box was sending them to a
                   credential they have never had. */
                <TvhsSignIn
                    onSignedIn={(t, driver) => { setTvhs(driver); onSignedIn(t); }}
                    onBack={() => chooseContract(null)}
                />
            ) : token === null ? (
                applying
                    ? <Apply
                        projectCode={chosen.code}
                        onDone={() => setApplying(false)}
                        onCancel={() => setApplying(false)}
                      />
                    : <SignIn
                        contractName={chosen.name}
                        onBack={() => chooseContract(null)}
                        onSignedIn={onSignedIn}
                        onApply={() => setApplying(true)}
                      />
            ) : mustChange ? (
                /* BEFORE THE CONTRACT CHECK AND BEFORE EVERY SHELL, because
                   the server refuses /api/me/projects to an account in this
                   state along with everything else. Putting the gate any
                   later would mean the first thing a courier saw was the
                   mismatch screen or an empty run, both of them wrong, and
                   both of them caused by a 403 nobody could read.

                   No back button and no contract switch: there is nothing
                   else this session can do. Sign out is on the screen. */
                <ChangePassword
                    token={token}
                    required
                    onChanged={() => setMustChange(false)}
                    onSignedOut={onSignedOut}
                />
            ) : mismatch !== null && mismatch.kind === 'wrongContract' ? (
                <WrongContract
                    outcome={mismatch}
                    onSwitch={(code) => {
                        const next = mismatch.belongsTo.find((m) => m.code === code);
                        if (next) { chooseContract({ code: next.code, name: next.name, detail: '' }); setMismatch(null); }
                    }}
                    onSignOut={onSignedOut}
                />
            ) : chosen.code === 'tvhs' ? (
                /* TVHS drivers get their sheet, not the UH run board. The
                   fleet overview on the web is a desk thing and stays there. */
                <TvhsShell
                    token={token}
                    route={tvhs?.route ?? ''}
                    name={tvhs?.name ?? who}
                    onSignedOut={onSignedOut}
                    onBack={() => { chooseContract(null); setTvhs(null); }}
                />
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
            ) : project.role === 'lead' ? (
                /* THE SPLIT. A site lead and a driver share a login, a
                   contract and almost no screens: one has a counter and the
                   people in front of it, the other has their own round. The
                   role comes from the membership the server already sends,
                   and rendering the wrong shell would grant nothing anyway,
                   because the server refuses a lead everything outside their
                   own pharmacies regardless. */
                <Leading
                    token={token}
                    project={project}
                    username={who}
                    onSignedOut={onSignedOut}
                    onBack={() => { setProject(null); chooseContract(null); setMismatch(null); }}
                />
            ) : (
                <Driving
                    token={token}
                    project={project}
                    username={who}
                    onSignedOut={onSignedOut}
                    /* Clears the CONTRACT, not just the project, and that is
                       the fix for a button that did nothing. It used to call
                       setProject(null) alone; Projects.tsx auto-picks when a
                       courier belongs to exactly one contract, which every
                       real driver does, so the picker mounted, re-picked the
                       single option and put them straight back. The label
                       says Contracts and there is a contract screen now, so
                       that is where it goes. */
                    onBack={() => { setProject(null); chooseContract(null); setMismatch(null); }}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    centre: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
});
