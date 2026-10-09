/* Changing your own password, on the phone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE REASON SOMEBODY IS HERE, AND IT IS THEIR OWN.
 *
 * A courier who thinks somebody watched them type, or who has shared a
 * password they should not have. They came from the profile screen, they can
 * go back, and nothing is holding them here.
 *
 * It had a second mode, `required`, for an account whose password an
 * administrator had chosen: the server refused almost everything until it was
 * replaced, and this screen was the only way out, so it had no back button.
 * That rule is gone (drizzle/0050), and with it the two things that mode cost
 * -- a screen somebody could be trapped on, and a second set of wordings to
 * keep true.
 *
 * WHAT TOOK ITS PLACE, for the case it was built for: a pharmacy that has
 * lost its password rings its own contract manager, who sets a new one from
 * the portal (server/src/modules/uh/portal-reset.ts). Nobody is compelled and
 * nobody waits for us.
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
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SPACE, TYPE, theme } from '../theme';
import { CardButton, Ground, Notice, Panel } from '../ui/Glass';
import { BackPill } from '../ui/Nav';
import { ScreenHeader } from '../ui/Screen';
import { SecretField } from '../ui/SecretField';
import { post } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { hintFor, readyToSend } from '../lib/password';

export function ChangePassword({ token, onBack, onChanged, onSignedOut }: {
    token: string;
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
                {onBack !== undefined && <BackPill label="Your account" onPress={onBack} />}

                <ScreenHeader
                    title="Your password"
                    subtitle="Changing it signs you out on every other phone."
                />

                {error !== null && <Notice tone="bad" text={error} />}

                <Panel style={styles.panel}>
                    {/* Every one of these can be revealed. A generated
                        sixteen-character password typed blind with a thumb is
                        how somebody locks themselves out on the first
                        morning; see ui/SecretField.tsx. */}
                    <SecretField
                        label="Your current password"
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
    footnote: { fontSize: TYPE.meta, color: theme.muted, lineHeight: 21, marginTop: SPACE.lg },
});
