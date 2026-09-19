/* Which contract am I driving for (ticket 7.1).
 *
 * One project today and more later, which is the whole reason the platform is
 * shaped this way. A courier with exactly one is sent straight through: the
 * web shell has a note against it for making somebody tap a list of one at a
 * pharmacy counter, and repeating that mistake on the phone would be worse.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import { get, type Project } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';

interface Props {
    token: string;
    onPick: (project: Project) => void;
    onSignedOut: () => void;
    /** Called when the list comes back empty, so the shell can send them to
     *  their application instead of leaving them on a blank screen. */
    onEmpty: () => void;
}

export function Projects({ token, onPick, onSignedOut, onEmpty }: Props) {
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setProjects(await get<Project[]>('/api/me/projects', token));
        } catch (err) {
            /* A credential that stopped working is the one error that is not
               worth showing: it means sign in again, so do that. */
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch.');
            setProjects([]);
        }
    }, [token, onSignedOut]);

    useEffect(() => { void load(); }, [load]);

    /* Straight through when there is only one. See the header. */
    useEffect(() => {
        if (projects?.length === 1) onPick(projects[0]!);
    }, [projects, onPick]);

    /* And to their application when there are none, which is what an
       applicant waiting on approval looks like (ticket 7.2). */
    useEffect(() => {
        if (projects?.length === 0 && error === null) onEmpty();
    }, [projects, error, onEmpty]);

    if (projects === null) {
        return (
            <View style={styles.centre}>
                <ActivityIndicator color={theme.green} />
            </View>
        );
    }

    return (
        <ScrollView style={styles.wrap} contentContainerStyle={styles.inner}>
            <Text style={styles.title}>Which contract</Text>

            {error !== null && (
                <View style={styles.error} accessibilityRole="alert">
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            )}

            {projects.length === 0 && (
                /* The onboarding gate from tickets 6.1 and 6.2, seen from the
                   phone: an approved application is what grants a membership,
                   and until then there is nothing to show. Said in words
                   rather than as an empty screen. */
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>Nothing assigned to you yet</Text>
                    <Text style={styles.cardBody}>
                        Your account is set up, and you are not on a contract yet. Dispatch adds you once your
                        onboarding checks are all recorded.
                    </Text>
                </View>
            )}

            {projects.map((p) => (
                <Pressable key={p.code} style={styles.card} onPress={() => onPick(p)} accessibilityRole="button">
                    <Text style={styles.cardTitle}>{p.name}</Text>
                    <Text style={styles.cardBody}>{p.code} · {p.timezone}</Text>
                </Pressable>
            ))}

            <Pressable style={styles.signOut} onPress={onSignedOut} accessibilityRole="button">
                <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: 'transparent' },
    inner: { padding: 20, paddingTop: 60 },
    centre: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: 24, fontWeight: '700', color: theme.ink, marginBottom: 18 },
    card: {
        backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
        borderRadius: 22, padding: 18, marginBottom: 12,
    },
    cardTitle: { fontSize: 17, fontWeight: '600', color: theme.ink },
    cardBody: { fontSize: 16, color: theme.muted, marginTop: 6, lineHeight: 20 },
    error: { backgroundColor: theme.dangerSoft, borderRadius: 18, padding: 14, marginBottom: 12 },
    errorText: { color: theme.danger, fontSize: 16 },
    signOut: { alignItems: 'center', paddingVertical: 16, marginTop: 8 },
    signOutText: { color: theme.muted, fontSize: 16 },
});
