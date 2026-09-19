/* Collecting a pharmacy's batch into the van.
 *
 * The gap found on the first day anybody held this app. The server has had
 * `POST /runs/:id/pickup` since ticket 2.4; `Run.tsx` carried a footnote
 * saying collection was "still on the web app", which meant a driver could
 * not do a whole day on the phone.
 *
 * RIDESHARE SHAPE: what is happening on top, what you can do at the bottom.
 * The count and the pad sit in the sheet under the thumb, because this is
 * done standing at a counter holding a crate.
 *
 * ONE SIGNATURE COVERS THE BATCH (Scope 1.2.8), so the work here is counting
 * boxes, not signing. The count rule lives in lib/pickup.ts and is the same
 * rule the server enforces, stated early so a mismatch is caught before the
 * pharmacist signs rather than after.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
    StyleSheet, Text, TextInput, View,
} from 'react-native';
import { CardButton, Chip, Ground, Notice, Sheet } from '../ui/Glass';
import { SignaturePad } from './SignaturePad';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { get } from '../lib/api';
import { ApiError, isUnauthorized } from '../lib/http';
import { queueAndSend } from '../lib/queue';
import { canCollect, checkCount, pickupLabel, type PickupBoard, type PickupSite } from '../lib/pickup';
import type { Stroke } from '../lib/strokes';

export function Collect({ token, code, runId, onDone, onCancel, onSignedOut }: {
    token: string;
    code: string;
    runId: number;
    onDone: () => void;
    onCancel: () => void;
    onSignedOut: () => void;
}) {
    const [board, setBoard] = useState<PickupBoard | null>(null);
    const [site, setSite] = useState<PickupSite | null>(null);
    const [counted, setCounted] = useState('');
    const [note, setNote] = useState('');
    const [signedName, setSignedName] = useState('');
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setError(null);
        try {
            setBoard(await get<PickupBoard>(`/api/projects/${code}/uh/runs/${runId}/pickup`, token));
        } catch (err) {
            if (isUnauthorized(err)) { onSignedOut(); return; }
            setError(err instanceof ApiError ? err.message : 'Cannot reach dispatch.');
        }
    }, [code, runId, token, onSignedOut]);
    useEffect(() => { void load(); }, [load]);

    const check = site === null
        ? checkCount(0, '', '')
        : checkCount(site.packages, counted, note);
    const ready = site !== null && canCollect(check, signedName, strokes.length);

    const submit = async () => {
        if (site === null || !ready) return;
        setBusy(true);
        setError(null);
        try {
            /* Through the outbox like every other courier write (7.5): in
               order, one at a time, the phone chooses the idempotency key,
               and a pharmacy basement with no signal records the handover at
               the time it happened rather than whenever signal returns. */
            await queueAndSend({
                id: `pickup-${runId}-${site.site.id}-${Date.now()}`,
                path: `/api/projects/${code}/uh/runs/${runId}/pickup`,
                body: {
                    siteId: site.site.id,
                    signedName: signedName.trim(),
                    strokes,
                    countedPackages: check.kind === 'incomplete' ? 0 : check.counted,
                    note: note.trim(),
                    at: new Date().toISOString(),
                },
                label: pickupLabel(site),
                queuedAt: new Date().toISOString(),
            });
            onDone();
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not record the collection.');
        } finally {
            setBusy(false);
        }
    };

    if (board === null) {
        return (
            <Ground>
                <View style={styles.centre}>
                    {error === null
                        ? <ActivityIndicator color={theme.green} />
                        : <Notice text={error} tone="bad" />}
                </View>
            </Ground>
        );
    }

    /* ------------------------------------------------ pick a pharmacy first */
    if (site === null) {
        return (
            <Ground>
                <View style={styles.context}>
                    <Text style={styles.title}>Collect</Text>
                    <Text style={styles.sub}>
                        {board.totals.orders} {board.totals.orders === 1 ? 'order' : 'orders'} waiting,{' '}
                        {board.totals.packages} {board.totals.packages === 1 ? 'package' : 'packages'}
                    </Text>
                </View>

                <Sheet style={styles.sheet}>
                    <ScrollView>
                        {board.sites.length === 0 ? (
                            <Notice
                                text="Nothing on this run is waiting to be collected. Everything has already been picked up."
                                tone="info"
                            />
                        ) : board.sites.map((s) => (
                            <CardButton
                                key={s.site.id}
                                title={s.site.name}
                                detail={`${s.orders.length} ${s.orders.length === 1 ? 'order' : 'orders'}, `
                                    + `${s.packages} ${s.packages === 1 ? 'package' : 'packages'}`}
                                tone="primary"
                                onPress={() => { setSite(s); setCounted(''); setNote(''); }}
                            />
                        ))}
                        <CardButton title="Back to today" tone="quiet" onPress={onCancel} />
                    </ScrollView>
                </Sheet>
            </Ground>
        );
    }

    /* ------------------------------------------------------- the handover */
    return (
        <Ground>
            <KeyboardAvoidingView
                style={styles.fill}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <View style={styles.context}>
                    <Text style={styles.title}>{site.site.name}</Text>
                    <View style={styles.chips}>
                        <Chip label={`${site.orders.length} orders`} />
                        <Chip label={`${site.packages} expected`} tone="warn" />
                    </View>
                </View>

                <Sheet style={styles.sheet}>
                    <ScrollView keyboardShouldPersistTaps="handled">
                        {error !== null && <Notice text={error} tone="bad" />}

                        <Text style={styles.label}>Packages counted into the van</Text>
                        {/* Deliberately empty, never prefilled with the
                            expected number: a box that starts correct is a
                            box everybody taps through without counting. */}
                        <TextInput
                            style={styles.input}
                            value={counted}
                            onChangeText={setCounted}
                            keyboardType="number-pad"
                            editable={!busy}
                            placeholder={`The list says ${site.packages}`}
                            placeholderTextColor={theme.muted}
                            accessibilityLabel="Packages counted into the van"
                        />

                        {(check.kind === 'needsNote' || check.kind === 'explained') && (
                            <>
                                {check.kind === 'needsNote' && <Notice text={check.message} tone="warn" />}
                                <Text style={styles.label}>What happened</Text>
                                <TextInput
                                    style={[styles.input, styles.multiline]}
                                    value={note}
                                    onChangeText={setNote}
                                    multiline
                                    editable={!busy}
                                    placeholder="The pharmacy will be asked about this."
                                    placeholderTextColor={theme.muted}
                                    accessibilityLabel="Why the count does not match"
                                />
                            </>
                        )}
                        {check.kind === 'incomplete' && <Notice text={check.message} tone="info" />}

                        <Text style={styles.label}>Name of the person handing over</Text>
                        <TextInput
                            style={styles.input}
                            value={signedName}
                            onChangeText={setSignedName}
                            editable={!busy}
                            autoCapitalize="words"
                            placeholder="Printed name"
                            placeholderTextColor={theme.muted}
                            accessibilityLabel="Name of the person handing over"
                        />

                        <Text style={styles.label}>Their signature</Text>
                        <SignaturePad label="Signature of the person handing over" onChange={setStrokes} />

                        <View style={styles.actions}>
                            <CardButton
                                title="Record the collection"
                                detail={ready
                                    ? `${check.kind === 'incomplete' ? '' : check.counted} packages into the van`
                                    : 'Count, name and signature are all needed'}
                                tone="primary"
                                onPress={() => { void submit(); }}
                                disabled={!ready}
                                busy={busy}
                            />
                            <CardButton
                                title="Choose another pharmacy"
                                tone="quiet"
                                onPress={() => { setSite(null); setStrokes([]); setSignedName(''); }}
                            />
                        </View>
                    </ScrollView>
                </Sheet>
            </KeyboardAvoidingView>
        </Ground>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
    /* The upper region. Where a rideshare app puts the map, and where this
       one puts what is happening until there is a map to put there. */
    context: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.xl, paddingBottom: SPACE.lg },
    title: { fontSize: TYPE.title, fontWeight: '800', color: theme.ink },
    sub: { fontSize: TYPE.label, color: theme.muted, marginTop: SPACE.xs },
    chips: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.sm },
    sheet: { flex: 1 },
    label: { fontSize: TYPE.meta, color: theme.muted, marginTop: SPACE.md, marginBottom: SPACE.xs },
    input: {
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        paddingHorizontal: SPACE.md,
        minHeight: TAP.standard,
        fontSize: TYPE.body,
        color: theme.ink,
    },
    multiline: { minHeight: 88, paddingTop: SPACE.md, textAlignVertical: 'top' },
    actions: { marginTop: SPACE.lg },
});
