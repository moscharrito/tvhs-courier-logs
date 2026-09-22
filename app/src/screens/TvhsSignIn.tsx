/* TVHS sign-in: pick your van, type the PIN.
 *
 * TVHS is two vans with one driver each and a phone in the cab, and it has
 * worked that way for months. The app only offered a username and a
 * password, which is the UH flow: a TVHS driver picking their contract on
 * the first screen arrived at a password box they have never had.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO SERVER CHANGE WAS NEEDED, WHICH IS THE POINT.
 *
 * `/api/drivers/list?project=tvhs` already returns the roster and
 * `/api/login/pin` already takes a route and a PIN. Sending the app's
 * client header gets a bearer token back rather than a cookie, exactly as
 * the password path does, so the session works the same afterwards.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO is remember which driver was
 * picked. A shared cab phone with a remembered driver is how one courier's
 * round gets recorded against the other one's name, and there is no
 * correcting that afterwards.
 *
 * AND IT SAYS WHAT THE PIN PROTECTS. TVHS PIN sign-in is accepted from any
 * device, which server.js says in its own comment; the PIN is the only
 * thing between a stranger and a driver's account. The screen does not
 * pretend otherwise, and it does not show the PIN as it is typed.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
    StyleSheet, Text, TextInput, View,
} from 'react-native';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import { BackPill } from '../ui/Nav';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { get, setPinWithPassword, signInWithPin, type DriverPick } from '../lib/api';
import { ApiError } from '../lib/http';

export function TvhsSignIn({ onSignedIn, onBack }: {
    /** The driver comes back with the token: their route picks the legs. */
    onSignedIn: (token: string, driver: { route: string; name: string }) => void;
    onBack: () => void;
}) {
    const [drivers, setDrivers] = useState<DriverPick[] | null>(null);
    const [driver, setDriver] = useState<DriverPick | null>(null);
    const [pin, setPin] = useState('');
    /* Set a new PIN with the account password, which is what the web calls
       "Forgot PIN? Use password". Off unless the driver asks for it: the PIN
       is the everyday way in and a password box on the front screen invites
       typing one into a phone held up at a window. */
    const [resetting, setResetting] = useState(false);
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setError(null);
        try {
            const all = await fetchDrivers();
            /* Only the ones who can actually use a PIN. A driver with no PIN
               set would be a card that always refuses, which is worse than
               not being offered. */
            setDrivers(all.filter((d) => d.route !== null && d.hasPin));
        } catch {
            setError('Cannot reach dispatch. Check the signal and try again.');
            setDrivers([]);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const submit = async () => {
        if (driver === null || driver.route === null || pin.length < 4) return;
        if (resetting && password.trim() === '') return;
        setBusy(true);
        setError(null);
        try {
            const out = resetting
                ? await setPinWithPassword(driver.route, password, pin)
                : await signInWithPin(driver.route, pin);
            onSignedIn(out.token, { route: driver.route, name: driver.name });
        } catch (err) {
            /* The server's own sentence. It says "Incorrect PIN" and counts
               the attempt, and inventing a friendlier one here would hide
               the throttle that is about to start refusing. */
            setError(err instanceof ApiError ? err.message : 'Could not sign in.');
            setPin('');
            setPassword('');
        } finally {
            setBusy(false);
        }
    };

    /* ------------------------------------------------------- pick a driver */
    if (driver === null) {
        return (
            <Ground>
                <ScrollView contentContainerStyle={styles.wrap}>
                    <BackPill label="Contracts" onPress={onBack} />

                    <View style={styles.brand}>
                        <Text style={styles.wordmark}>TAG</Text>
                        <Text style={styles.company}>TVHS RMD Courier</Text>
                    </View>

                    <Panel>
                        <Text style={styles.title}>Who is driving?</Text>

                        {error !== null && <Notice text={error} tone="bad" />}

                        {drivers === null ? (
                            <ActivityIndicator color={theme.green} style={styles.spinner} />
                        ) : drivers.length === 0 ? (
                            <Notice
                                tone="warn"
                                text="No driver on this contract has a PIN set. An administrator sets one from the Users screen."
                            />
                        ) : drivers.map((d) => (
                            <CardButton
                                key={d.username}
                                title={d.name}
                                /* The route is how a driver knows which card
                                   is theirs: two names, two vans. */
                                detail={d.route ?? ''}
                                tone="primary"
                                onPress={() => { setDriver(d); setPin(''); setError(null); }}
                            />
                        ))}
                    </Panel>
                </ScrollView>
            </Ground>
        );
    }

    /* ------------------------------------------------------------ the PIN */
    return (
        <Ground>
            <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
                    <BackPill label="Drivers" onPress={() => { setDriver(null); setPin(''); setError(null); }} />

                    <View style={styles.brand}>
                        <Text style={styles.wordmark}>{driver.name}</Text>
                        <Text style={styles.company}>{driver.route}</Text>
                    </View>

                    <Panel>
                        {error !== null && <Notice text={error} tone="bad" />}

                        {resetting && (
                            <>
                                <Text style={styles.label}>Account password</Text>
                                <TextInput
                                    style={styles.password}
                                    value={password}
                                    onChangeText={setPassword}
                                    secureTextEntry
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    editable={!busy}
                                    accessibilityLabel="Account password"
                                />
                            </>
                        )}

                        <Text style={styles.label}>{resetting ? 'New PIN' : 'PIN'}</Text>
                        <TextInput
                            style={styles.pin}
                            value={pin}
                            onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
                            keyboardType="number-pad"
                            /* Not shown as it is typed. A cab phone is held in
                               front of whoever is standing at the window. */
                            secureTextEntry
                            editable={!busy}
                            autoFocus
                            accessibilityLabel={`PIN for ${driver.name}`}
                            onSubmitEditing={() => { void submit(); }}
                        />

                        <CardButton
                            title={resetting ? 'Set PIN and sign in' : 'Sign in'}
                            onPress={() => { void submit(); }}
                            disabled={pin.length < 4 || (resetting && password.trim() === '')}
                            busy={busy}
                            tone="primary"
                        />
                        <CardButton
                            title={resetting ? 'I remember my PIN' : 'Forgot PIN? Use your password'}
                            {...(resetting ? {} : { detail: 'Sets a new PIN for this van' })}
                            tone="quiet"
                            compact
                            onPress={() => {
                                setResetting(!resetting);
                                setPin('');
                                setPassword('');
                                setError(null);
                            }}
                        />
                        <CardButton
                            title="Not me"
                            detail="Back to the driver list"
                            tone="quiet"
                            onPress={() => { setDriver(null); setPin(''); setPassword(''); setResetting(false); setError(null); }}
                        />
                    </Panel>

                    <Text style={styles.footnote}>
                        Sign out at the end of your shift. Everything you record goes against whoever is signed
                        in, and it cannot be corrected afterwards.
                    </Text>
                </ScrollView>
            </KeyboardAvoidingView>
        </Ground>
    );
}

/* Unauthenticated, like the web sign-in page: it is the roster on the side
   of two vans, not a secret. It carries no PIN and no password hash.
   Through the shared client with a null token, so the base URL and the
   error shaping stay in one place. */
const fetchDrivers = (): Promise<DriverPick[]> =>
    get<DriverPick[]>('/api/drivers/list?project=tvhs', null);

const styles = StyleSheet.create({
    /* Not the big spaced-out PIN box: a password is typed, not tapped. */
    password: {
        minHeight: TAP.standard,
        backgroundColor: 'rgba(255,255,255,0.92)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        paddingHorizontal: SPACE.md,
        fontSize: TYPE.body,
        color: theme.ink,
        marginBottom: SPACE.sm,
    },
    fill: { flex: 1 },
    wrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.lg },
    brand: { alignItems: 'center', marginVertical: SPACE.xl },
    wordmark: { fontSize: 34, fontWeight: '800', color: theme.green, textAlign: 'center' },
    company: { fontSize: TYPE.label, color: theme.muted, marginTop: SPACE.xs, textAlign: 'center' },
    title: { fontSize: TYPE.title, fontWeight: '700', color: theme.ink, textAlign: 'center', marginBottom: SPACE.lg },
    label: { fontSize: TYPE.meta, color: theme.muted, marginBottom: SPACE.xs },
    pin: {
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        minHeight: TAP.primary,
        paddingHorizontal: SPACE.md,
        /* Wide-spaced and large: this is typed with a thumb in a cab. */
        fontSize: 30,
        letterSpacing: 12,
        textAlign: 'center',
        color: theme.ink,
        marginBottom: SPACE.md,
    },
    spinner: { marginVertical: SPACE.lg },
    footnote: { fontSize: TYPE.meta, color: theme.muted, textAlign: 'center', lineHeight: 21, marginTop: SPACE.lg },
});
