/* Applying to drive, from the phone (ticket 7.2).
 *
 * The DoorDash shape, decided on 16 September: this creates an account with
 * the password they chose, and that account can sign in immediately and see
 * nothing. Not "nothing useful" — nothing. No board, no addresses, no names,
 * because it belongs to no project until somebody approves the application.
 *
 * WHAT THIS SCREEN MUST NOT DO IS IMPLY OTHERWISE. Somebody who fills this in
 * has not got a job, and a cheerful "welcome aboard" here is a promise nobody
 * made. The confirmation says what actually happened and what happens next.
 *
 * The server answers a duplicate email and an unknown project code exactly
 * like a good application, so there is nothing for this screen to branch on:
 * one response, one message. That is deliberate on the server side (a form
 * that says "you have already applied" tells a stranger who drives for us)
 * and it means this screen cannot accidentally leak it either.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { theme } from '../theme';
import { applyToDrive } from '../lib/api';
import { ApiError } from '../lib/http';

interface Props {
    /** The contract chosen on the first screen. */
    projectCode: string;
    onDone: () => void;
    onCancel: () => void;
}

/* Was a hardcoded 'uh', which was wrong the moment Izy ran two contracts:
   somebody applying to drive TVHS was filed against University Health. It
   now comes from the contract chosen on the first screen. */

export function Apply({ projectCode, onDone, onCancel }: Props) {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const ready = name.trim().length > 1
        && email.trim().includes('@')
        && phone.trim().length >= 7
        && password.length >= 8
        && !busy;

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await applyToDrive({
                projectCode,
                name: name.trim(),
                email: email.trim(),
                phone: phone.trim(),
                password,
            });
            setSent(true);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Cannot reach us right now. Try again in a moment.');
        } finally {
            setBusy(false);
        }
    };

    if (sent) {
        return (
            <View style={styles.wrap}>
                <Text style={styles.title}>Application received</Text>
                <Text style={styles.body}>
                    You can sign in with that email and password now. There will be nothing to see yet: we check a
                    few things before anybody gets an address, and the app will show you what is outstanding.
                </Text>
                <Pressable style={styles.button} onPress={onDone} accessibilityRole="button">
                    <Text style={styles.buttonText}>Sign in</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
            <Text style={styles.title}>Drive for Izy</Text>
            <Text style={styles.body}>
                Fill this in and you can sign in straight away. Before you can take a delivery we need HIPAA
                training, a signed confidentiality agreement, a background check we run ourselves, a current
                licence and insurance.
            </Text>

            {error !== null && (
                <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text></View>
            )}

            <Field label="Your name" value={name} onChange={setName} editable={!busy} autoComplete="name" />
            <Field
                label="Email"
                value={email}
                onChange={setEmail}
                editable={!busy}
                autoComplete="email"
                keyboardType="email-address"
            />
            <Field label="Phone" value={phone} onChange={setPhone} editable={!busy} keyboardType="phone-pad" autoComplete="tel" />
            <Field label="Choose a password" value={password} onChange={setPassword} editable={!busy} secure autoComplete="new-password" />
            <Text style={styles.hint}>At least eight characters. This is the password you will sign in with.</Text>

            <Pressable
                style={[styles.button, !ready && styles.buttonOff]}
                onPress={() => { void submit(); }}
                disabled={!ready}
                accessibilityRole="button"
            >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Apply</Text>}
            </Pressable>

            <Pressable style={styles.link} onPress={onCancel} accessibilityRole="button">
                <Text style={styles.linkText}>I already have an account</Text>
            </Pressable>
        </ScrollView>
    );
}

function Field(props: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    editable: boolean;
    secure?: boolean;
    keyboardType?: 'default' | 'email-address' | 'phone-pad';
    autoComplete?: 'name' | 'email' | 'tel' | 'new-password';
}) {
    return (
        <View>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput
                style={styles.input}
                value={props.value}
                onChangeText={props.onChange}
                editable={props.editable}
                secureTextEntry={props.secure === true}
                autoCapitalize={props.autoComplete === 'name' ? 'words' : 'none'}
                autoCorrect={false}
                keyboardType={props.keyboardType ?? 'default'}
                accessibilityLabel={props.label}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    scroll: { flex: 1, backgroundColor: theme.bg },
    wrap: { padding: 24, paddingTop: 60, paddingBottom: 48, flexGrow: 1, justifyContent: 'center' },
    title: { fontSize: 28, fontWeight: '700', color: theme.ink, marginBottom: 10 },
    body: { fontSize: 15, color: theme.muted, lineHeight: 22, marginBottom: 18 },
    label: { fontSize: 13, color: theme.muted, marginBottom: 6, marginTop: 14 },
    input: {
        backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line, borderRadius: 10,
        paddingHorizontal: 14, paddingVertical: 14, fontSize: 17, color: theme.ink,
    },
    hint: { fontSize: 13, color: theme.muted, marginTop: 8 },
    button: { backgroundColor: theme.green, borderRadius: 10, paddingVertical: 16, alignItems: 'center', marginTop: 26 },
    buttonOff: { opacity: 0.4 },
    buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
    link: { alignItems: 'center', paddingVertical: 18 },
    linkText: { color: theme.green, fontSize: 15 },
    error: { backgroundColor: theme.dangerSoft, borderRadius: 10, padding: 14, marginBottom: 6 },
    errorText: { color: theme.danger, fontSize: 15, lineHeight: 21 },
});
