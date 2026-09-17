/* Signing in on a phone (ticket 7.1).
 *
 * Username and password, because that is what a driver has on day one: the
 * PIN and the enrolled-phone path (tickets 2.3 and 5.4) belong to the web
 * shell and will be brought over in 7.2 once the app can hold a device
 * identity. Nothing here is a second way to get access: the same account, the
 * same membership check, the same refusals.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { theme } from '../theme';
import { signIn } from '../lib/api';
import { ApiError } from '../lib/http';

interface Props {
    onSignedIn: (token: string) => void;
}

export function SignIn({ onSignedIn }: Props) {
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
        <View style={styles.wrap}>
            <Text style={styles.brand}>TAG</Text>
            <Text style={styles.sub}>Izy Global Services</Text>

            {error !== null && (
                <View style={styles.error} accessibilityRole="alert">
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            )}

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

            <Pressable
                style={[styles.button, !ready && styles.buttonOff]}
                onPress={() => { void submit(); }}
                disabled={!ready}
                accessibilityRole="button"
            >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.bg, padding: 24, justifyContent: 'center' },
    brand: { fontSize: 32, fontWeight: '700', color: theme.green },
    sub: { fontSize: 14, color: theme.muted, marginBottom: 28 },
    label: { fontSize: 13, color: theme.muted, marginBottom: 6, marginTop: 14 },
    input: {
        backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line, borderRadius: 10,
        paddingHorizontal: 14, paddingVertical: 14, fontSize: 17, color: theme.ink,
    },
    button: {
        backgroundColor: theme.green, borderRadius: 10, paddingVertical: 16,
        alignItems: 'center', marginTop: 28,
    },
    buttonOff: { opacity: 0.4 },
    buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
    error: { backgroundColor: theme.dangerSoft, borderRadius: 10, padding: 14 },
    errorText: { color: theme.danger, fontSize: 15, lineHeight: 21 },
});
