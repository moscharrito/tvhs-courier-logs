/* Where my application has got to (ticket 7.2).
 *
 * The screen an applicant sees every day until somebody approves them, so the
 * whole job of it is answering one question: is anybody waiting on me.
 *
 * WHAT IT CAN SEND, AND WHAT IT CANNOT. It takes a reference for each gate
 * that is the applicant's to supply: a training certificate number, a licence
 * number, a policy number. It does NOT photograph documents, and that is not
 * an oversight.
 *
 *   There is nowhere to put one. File storage is off until the AWS BAA in
 *   ticket 0.10 is filed, which is the same reason a doorstep photo is
 *   refused rather than recorded without evidence.
 *
 *   And even with a bucket, the design in 6.2 does not store them: the table
 *   records that a named person saw a document, when, and what it was called.
 *   A background check report sitting in a courier database is a second
 *   breach waiting for the first one.
 *
 * SENDING A REFERENCE VERIFIES NOTHING, and the screen says so rather than
 * turning a row green and letting somebody think they are done. A named
 * member of staff checks each one; that is the whole of ticket 6.2 and a
 * phone cannot be allowed to route around it.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { theme } from '../theme';
import { myApplication, submitCheck, type MyApplication } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { CHECK_COPY, checkState, outstanding, overallState, type CheckKind } from '../lib/checks';

interface Props {
    token: string;
    onSignedOut: () => void;
}

export function Onboarding({ token, onSignedOut }: Props) {
    const [data, setData] = useState<MyApplication | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [drafts, setDrafts] = useState<Partial<Record<CheckKind, string>>>({});
    const [saving, setSaving] = useState<CheckKind | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setData(await myApplication(token));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            if (err instanceof ApiError && err.status === 404) { setData(null); setError(null); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach us right now.');
        }
    }, [token, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    const send = async (kind: CheckKind) => {
        const reference = (drafts[kind] ?? '').trim();
        if (reference === '') return;
        setSaving(kind);
        try {
            await submitCheck(token, kind, reference);
            setDrafts((d) => ({ ...d, [kind]: '' }));
            await load();
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'That did not send. Try again.');
        } finally {
            setSaving(null);
        }
    };

    if (data === null && error === null) {
        return <View style={styles.centre}><ActivityIndicator color={theme.green} /></View>;
    }

    const left = data ? outstanding(data.checks).length : 0;

    return (
        <ScrollView
            style={styles.wrap}
            contentContainerStyle={styles.inner}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
                setRefreshing(true);
                void load().finally(() => setRefreshing(false));
            }} />}
        >
            <Text style={styles.title}>Your application</Text>

            {error !== null && (
                <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{error}</Text></View>
            )}

            {data !== null && (
                <>
                    <Text style={styles.headline}>{overallState(data.status, data.clearance.ready, left)}</Text>

                    {data.status === 'rejected' && data.decisionReason !== '' && (
                        /* The reason is handed back deliberately. Being turned
                           down with no reason is the thing people write in
                           about, and they are right to. */
                        <View style={styles.card}>
                            <Text style={styles.cardBody}>{data.decisionReason}</Text>
                        </View>
                    )}

                    {data.checks.map((c) => {
                        const copy = CHECK_COPY[c.kind];
                        const sent = c.submittedReference !== '';
                        const canSend = copy.yours && c.status === 'pending' && data.status !== 'rejected';
                        return (
                            <View key={c.kind} style={styles.card}>
                                <View style={styles.row}>
                                    <Text style={styles.cardTitle}>{copy.title}</Text>
                                    <Text style={[styles.pill, c.status === 'verified' ? styles.pillDone : null]}>
                                        {checkState(c.kind, c.status, sent)}
                                    </Text>
                                </View>
                                <Text style={styles.cardBody}>{copy.what}</Text>

                                {sent && <Text style={styles.sent}>You sent: {c.submittedReference}</Text>}

                                {canSend && (
                                    <View style={styles.sendRow}>
                                        <TextInput
                                            style={styles.input}
                                            value={drafts[c.kind] ?? ''}
                                            onChangeText={(v) => setDrafts((d) => ({ ...d, [c.kind]: v }))}
                                            placeholder={copy.placeholder}
                                            autoCapitalize="characters"
                                            autoCorrect={false}
                                            editable={saving !== c.kind}
                                            accessibilityLabel={`${copy.title}: ${copy.placeholder}`}
                                        />
                                        <Pressable
                                            style={styles.send}
                                            onPress={() => { void send(c.kind); }}
                                            disabled={saving === c.kind || (drafts[c.kind] ?? '').trim() === ''}
                                            accessibilityRole="button"
                                        >
                                            {saving === c.kind
                                                ? <ActivityIndicator color={theme.green} />
                                                : <Text style={styles.sendText}>Send</Text>}
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        );
                    })}

                    {/* Said plainly. A row that turned green on submission
                        would tell somebody they were done when nobody has
                        looked at it yet. */}
                    <Text style={styles.footnote}>
                        Sending a number does not tick anything off. Somebody here checks each one, and you will
                        see it change when they have.
                    </Text>
                </>
            )}

            {data === null && error === null && (
                <View style={styles.card}>
                    <Text style={styles.cardBody}>
                        There is no application on this account. If you were added by dispatch, sign out and back
                        in and your contract will be there.
                    </Text>
                </View>
            )}

            <Pressable style={styles.signOut} onPress={onSignedOut} accessibilityRole="button">
                <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.bg },
    inner: { padding: 16, paddingTop: 60, paddingBottom: 40 },
    centre: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: 26, fontWeight: '700', color: theme.ink },
    headline: { fontSize: 16, color: theme.ink, marginTop: 8, marginBottom: 18, lineHeight: 23 },
    card: {
        backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line,
        borderRadius: 12, padding: 16, marginBottom: 12,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
    cardTitle: { fontSize: 16, fontWeight: '600', color: theme.ink, flex: 1 },
    cardBody: { fontSize: 14, color: theme.muted, marginTop: 8, lineHeight: 20 },
    pill: { fontSize: 12, color: theme.muted, flexShrink: 0, maxWidth: 150, textAlign: 'right' },
    pillDone: { color: theme.greenBright, fontWeight: '600' },
    sent: { fontSize: 13, color: theme.ink, marginTop: 10 },
    sendRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
    input: {
        flex: 1, backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.line,
        borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: theme.ink,
    },
    send: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 8, borderWidth: 1, borderColor: theme.green },
    sendText: { color: theme.green, fontSize: 15, fontWeight: '600' },
    footnote: { fontSize: 13, color: theme.muted, lineHeight: 19, marginTop: 6, paddingHorizontal: 4 },
    error: { backgroundColor: theme.dangerSoft, borderRadius: 10, padding: 14, marginBottom: 12 },
    errorText: { color: theme.danger, fontSize: 15, lineHeight: 21 },
    signOut: { alignItems: 'center', paddingVertical: 18, marginTop: 8 },
    signOutText: { color: theme.muted, fontSize: 15 },
});
