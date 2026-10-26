/* Resetting a forgotten password, on the phone.
 *
 * The same two steps as the web shell (web/src/pages/PasswordReset.tsx) and
 * the same two endpoints. It exists separately because this is where it will
 * actually be used: a courier signs in at a pharmacy counter with a password
 * somebody read out to them, and the phone is the thing in their hand when
 * it does not work. Leaving this on the web only would have meant telling a
 * driver to go and find a browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT DOES NOT SAY WHETHER THE ADDRESS IS KNOWN, because the server does not.
 * After step one it always moves on, and the wording keeps the conditional.
 * A screen that added "we don't recognise that email" would hand out the
 * staff directory the server is careful not to.
 *
 * WHAT IT DOES SAY IN FULL is a server that has email switched off, which is
 * a fact about the server rather than about the address. Somebody who would
 * otherwise wait for a code that cannot come is told to ring the office.
 *
 * AND IT WARNS BEFORE IT WORKS. Finishing signs every device out, including
 * this one. A courier mid-shift should know that before they tap, not after
 * their run disappears.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SPACE, TYPE, theme } from '../theme';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import { BackPill } from '../ui/Nav';
import { SecretField } from '../ui/SecretField';
import { requestPasswordReset, confirmPasswordReset } from '../lib/api';
import { ApiError } from '../lib/http';

type Step = 'email' | 'code' | 'done';

export function ForgotPassword({ onBack }: { onBack: () => void }) {
    const [step, setStep] = useState<Step>('email');
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const ask = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await requestPasswordReset(email.trim().toLowerCase());
            setNote(res.message);
            setStep('code');
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'That did not go through. Check your signal and try again.');
        } finally {
            setBusy(false);
        }
    };

    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            /* THE SERVER'S OWN SENTENCE. Only it knows whether this account
               had a phone PIN, which the reset revokes along with the
               sessions -- and on this shell the reader is usually the person
               who had one. See core/auth/password-reset.ts. */
            const res = await confirmPasswordReset(email.trim().toLowerCase(), code.trim(), password);
            setNote(res?.message ?? null);
            setStep('done');
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'That did not go through. Check your signal and try again.');
        } finally {
            setBusy(false);
        }
    };

    const canAsk = email.trim().length > 3 && email.includes('@') && !busy;
    const canConfirm = code.trim().length === 6 && password.length >= 8 && !busy;

    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
                <BackPill label="Sign in" onPress={onBack} />
                <Text style={styles.title}>
                    {step === 'done' ? 'Password changed' : 'Reset your password'}
                </Text>

                {error !== null && <Notice text={error} tone="bad" />}

                {step === 'email' && (
                    <Panel>
                        <Text style={styles.label}>Your email address</Text>
                        <TextInput
                            style={styles.input}
                            value={email}
                            onChangeText={setEmail}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="email"
                            keyboardType="email-address"
                            editable={!busy}
                            accessibilityLabel="Your email address"
                        />
                        <Text style={styles.note}>
                            The address the office has for you. Not your username.
                        </Text>
                        <View style={styles.actions}>
                            <CardButton
                                title="Send me a code"
                                onPress={() => { void ask(); }}
                                disabled={!canAsk}
                                busy={busy}
                                tone="primary"
                            />
                        </View>
                    </Panel>
                )}

                {step === 'code' && (
                    <Panel>
                        {note !== null && <Text style={styles.note}>{note}</Text>}
                        <Text style={styles.label}>The six digit code</Text>
                        <TextInput
                            style={styles.input}
                            value={code}
                            /* Digits only: a code pasted out of an email
                               arrives with whatever was around it. */
                            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                            keyboardType="number-pad"
                            autoComplete="one-time-code"
                            maxLength={6}
                            editable={!busy}
                            accessibilityLabel="The six digit code"
                        />
                        <SecretField
                            label="New password"
                            value={password}
                            onChangeText={setPassword}
                            autoComplete="new-password"
                            editable={!busy}
                        />
                        {/* SAID BEFORE, NOT AFTER. A courier mid-shift whose
                            run vanished without warning would ring dispatch
                            thinking the app had broken. */}
                        <Notice
                            tone="warn"
                            text={'Finishing this signs out every device, including this phone. '
                                + 'You will sign in again with the new password.'}
                        />
                        <View style={styles.actions}>
                            <CardButton
                                title="Set the new password"
                                onPress={() => { void confirm(); }}
                                disabled={!canConfirm}
                                busy={busy}
                                tone="primary"
                            />
                        </View>
                        <Text style={styles.note}>
                            The code expires in 15 minutes and works once. If nothing arrives,
                            check the address you typed, then ring dispatch — they can reset it
                            for you.
                        </Text>
                    </Panel>
                )}

                {step === 'done' && (
                    <Panel>
                        <Text style={styles.note}>
                            {note ?? 'Every device signed in as you has been signed out. '
                                + 'Sign in with the new password.'}
                        </Text>
                        <View style={styles.actions}>
                            <CardButton title="Back to sign in" onPress={onBack} tone="primary" />
                        </View>
                    </Panel>
                )}
            </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { padding: SPACE.lg, paddingTop: 56, paddingBottom: 40 },
    title: { fontSize: TYPE.display, fontWeight: '800', color: theme.ink, marginTop: SPACE.md, marginBottom: SPACE.lg },
    label: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.sm, marginBottom: 4 },
    input: {
        borderWidth: 1, borderColor: theme.line, borderRadius: 12,
        paddingHorizontal: SPACE.md, paddingVertical: 12,
        fontSize: TYPE.label, color: theme.ink, backgroundColor: '#fff',
    },
    note: { fontSize: TYPE.meta, color: theme.muted, lineHeight: 21, marginTop: SPACE.sm },
    actions: { marginTop: SPACE.lg },
});
