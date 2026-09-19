/* Signing in on a phone (ticket 7.1).
 *
 * Username and password, because that is what a driver has on day one: the
 * PIN and the enrolled-phone path (tickets 2.3 and 5.4) belong to the web
 * shell and will be brought over in 7.2 once the app can hold a device
 * identity. Nothing here is a second way to get access: the same account, the
 * same membership check, the same refusals.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import { signIn } from '../lib/api';
import { ApiError } from '../lib/http';

interface Props {
    /** Which contract they said they drive for, shown so a wrong tap is
     *  caught before they type a password rather than after. */
    contractName: string;
    /** Back to the contract picker. */
    onBack: () => void;
    onSignedIn: (token: string) => void;
    /** Ticket 7.2: signing up is a first-class thing to do from this screen,
     *  not a link somebody has to be sent. */
    onApply: () => void;
}

export function SignIn({ contractName, onBack, onSignedIn, onApply }: Props) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await signIn(username.trim(), password);
            onSignedIn(res.token);
        } catch (err) {
            /* A phone at a pharmacy counter has no network tab. Say the thing
               that happened, or say that dispatch is unreachable. */
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch. Check your signal and try again.');
        } finally {
            setBusy(false);
        }
    };

    const ready = username.trim().length > 1 && password.length > 0 && !busy;

    return (
        <Ground>
        <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
            {/* Centred, as asked. The wordmark is the only thing on the
                screen wide enough to anchor a left edge to, so centring it
                and leaving the fields flush was the worst of both. */}
            <View style={styles.brandBlock}>
                <Text style={styles.brand}>TAG</Text>
                <Text style={styles.sub}>Izy Global Services LLC</Text>
            </View>

            <Panel>
                {/* Which contract, before the password rather than after.
                    A wrong tap on the first screen is cheap to fix here and
                    expensive to fix once somebody has typed credentials and
                    been refused. */}
                <Pressable onPress={onBack} accessibilityRole="button" style={styles.contract}>
                    <View style={styles.contractText}>
                        <Text style={styles.contractLabel}>Signing in to</Text>
                        <Text style={styles.contractName}>{contractName}</Text>
                    </View>
                    <Text style={styles.contractChange}>Change</Text>
                </Pressable>

                {error !== null && <Notice text={error} tone="bad" />}

            <Text style={styles.label}>Username</Text>
            <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                keyboardType="email-address"
                editable={!busy}
                accessibilityLabel="Username"
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
                editable={!busy}
                accessibilityLabel="Password"
                onSubmitEditing={() => { if (ready) void submit(); }}
            />

            <View style={styles.actions}>
                <CardButton
                    title="Sign in"
                    onPress={() => { void submit(); }}
                    disabled={!ready}
                    busy={busy}
                    tone="primary"
                />
                <CardButton
                    title="Apply to drive for Izy"
                    detail="New driver? Start here. It takes a couple of minutes."
                    onPress={onApply}
                    tone="secondary"
                />
            </View>
            </Panel>
        </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.lg },
    brandBlock: { alignItems: 'center', marginBottom: SPACE.xl },
    brand: { fontSize: 46, fontWeight: '800', color: theme.green, letterSpacing: 2, textAlign: 'center' },
    sub: { fontSize: TYPE.label, color: theme.muted, marginTop: SPACE.xs, textAlign: 'center' },

    contract: {
        minHeight: TAP.minimum,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'rgba(255,255,255,0.5)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.sm,
        marginBottom: SPACE.md,
    },
    contractText: { flex: 1 },
    contractLabel: { fontSize: TYPE.meta, color: theme.muted },
    contractName: { fontSize: TYPE.label, fontWeight: '700', color: theme.ink, marginTop: 2 },
    contractChange: { fontSize: TYPE.label, fontWeight: '600', color: theme.greenBright },

    label: { fontSize: TYPE.meta, color: theme.muted, marginBottom: SPACE.xs, marginTop: SPACE.md },
    input: {
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        paddingHorizontal: SPACE.md,
        /* Taller than the old 14: this is typed standing up. */
        minHeight: TAP.standard,
        fontSize: TYPE.body,
        color: theme.ink,
    },
    actions: { marginTop: SPACE.lg },
});
