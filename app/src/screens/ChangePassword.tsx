/* Changing your own password, on the phone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE MISSING HALF OF A SERVER RULE.
 *
 * A password an administrator chose is temporary: the server refuses almost
 * everything until the person replaces it (core/auth/must-change.ts). That
 * holds for staff on the web, where a form exists, and NOT for drivers,
 * because this app had nowhere to change one. So eight pharmacy leads and
 * every courier are exempt from a rule that exists precisely because two
 * people knowing the credential to an account that reaches patient data is
 * the wrong arrangement.
 *
 * mustChangeFor in server/src/core/users/routes.ts is the one line that lifts
 * the exemption, AND IT MUST NOT BE LIFTED UNTIL A BUILD CARRYING THIS SCREEN
 * IS ON THE PHONES. Drivers and leads run an APK with no such screen; turning
 * the rule on for them before they update refuses every request they make
 * with no way to comply, which is somebody standing at a pharmacy counter at
 * seven in the morning whose only remedy is telephoning us. The screen ships
 * first, the exemption goes after.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO REASONS SOMEBODY IS HERE, AND THEY NEED DIFFERENT SCREENS.
 *
 * `required` is the forced case: the server has already refused them, so
 * there is no way out except through the form or signing out. The voluntary
 * case is a courier who thinks somebody watched them type, and that one has
 * a back button.
 *
 * The forced case cannot happen yet, by the paragraph above. It is written
 * now so that lifting the exemption is one line on the server rather than a
 * line plus an app release.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SESSION DOING THE CHANGING SURVIVES.
 *
 * The endpoint revokes every other session and excepts this one, and a bearer
 * token gets a real session id (core/auth/sessions.ts), so the app is covered
 * by that exception rather than relying on a cookie. The token in the Keychain
 * stays a session: nothing here re-signs-in, and a courier mid-round does not
 * lose their run because they changed a password at a red light.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SPACE, TYPE, theme } from '../theme';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import { BackPill } from '../ui/Nav';
import { ScreenHeader } from '../ui/Screen';
import { SecretField } from '../ui/SecretField';
import { post } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { hintFor, readyToSend } from '../lib/password';

export function ChangePassword({ token, required = false, onBack, onChanged, onSignedOut }: {
    token: string;
    /** The server is refusing everything until this is done. */
    required?: boolean;
    /** Absent in the forced case: there is nowhere to go back to. */
    onBack?: (() => void) | undefined;
    /** Done. The shell re-reads the session and carries on. */
    onChanged: () => void;
    onSignedOut: () => void;
}) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [again, setAgain] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /* The rules live in lib/password.ts, which is pure and tested. */
    const draft = { current, next, again };
    const hint = hintFor(draft);
    const ready = readyToSend(draft) && !busy;

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await post('/api/me/password', token, { currentPassword: current, password: next });
            onChanged();
        } catch (err) {
            /* A dead credential is not this screen's problem to explain. */
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError
                ? err.message
                : 'Cannot reach dispatch. Check your signal and try again.');
            setBusy(false);
        }
    };

    return (
        <Ground>
            <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
                {/* Only when there is somewhere to go. In the forced case the
                    way out is downwards, through the form, or Sign out. */}
                {!required && onBack !== undefined && <BackPill label="Your account" onPress={onBack} />}

                <ScreenHeader
                    title={required ? 'Choose a password' : 'Your password'}
                    subtitle={required
                        ? 'The one you were given was chosen by somebody else.'
                        : 'Changing it signs you out on every other phone.'}
                />

                {required && (
                    <Notice
                        tone="warn"
                        text={'Until this is done the app cannot load your run. What you choose here is not '
                            + 'shown to dispatch or to us.'}
                    />
                )}

                {error !== null && <Notice tone="bad" text={error} />}

                <Panel style={styles.panel}>
                    {/* Every one of these can be revealed. A generated
                        sixteen-character password typed blind with a thumb is
                        how somebody locks themselves out on the first
                        morning; see ui/SecretField.tsx. */}
                    <SecretField
                        label={required ? 'The password you were given' : 'Your current password'}
                        value={current}
                        onChangeText={setCurrent}
                        autoComplete="current-password"
                        editable={!busy}
                    />

                    <SecretField
                        label="Your new password"
                        value={next}
                        onChangeText={setNext}
                        autoComplete="new-password"
                        editable={!busy}
                    />

                    <SecretField
                        label="Type it again"
                        value={again}
                        onChangeText={setAgain}
                        autoComplete="new-password"
                        editable={!busy}
                        invalid={hint !== ''}
                        onSubmitEditing={() => { if (ready) void submit(); }}
                    />

                    {/* Said while it can still be fixed, rather than as a
                        refusal after the button. See lib/password.ts. */}
                    {hint !== '' && <Text style={styles.hint}>{hint}</Text>}
                </Panel>

                <CardButton
                    title="Change my password"
                    detail="Every other phone signed in as you is signed out. This one stays."
                    tone="primary"
                    onPress={() => { void submit(); }}
                    disabled={!ready}
                    busy={busy}
                />

                {required && (
                    /* The only other way out of a screen with no back button.
                       An account somebody cannot leave is a trap, even when
                       the thing holding them there is right. */
                    <View style={styles.escape}>
                        <CardButton
                            title="Sign out instead"
                            detail="Nothing changes. You will be asked again next time."
                            tone="quiet"
                            compact
                            onPress={onSignedOut}
                            disabled={busy}
                        />
                    </View>
                )}

                <Text style={styles.footnote}>
                    Pick something you can type one-handed and remember. Keep it to yourself: a delivery is
                    recorded against whoever is signed in, and nobody can correct that afterwards.
                </Text>
            </ScrollView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    wrap: { padding: SPACE.lg, paddingTop: 56, paddingBottom: 40 },
    panel: { marginBottom: SPACE.md },
    label: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.md },
    hint: { fontSize: TYPE.meta, color: theme.danger, marginTop: SPACE.sm },
    escape: { marginTop: SPACE.md },
    footnote: { fontSize: TYPE.meta, color: theme.muted, lineHeight: 21, marginTop: SPACE.lg },
});
