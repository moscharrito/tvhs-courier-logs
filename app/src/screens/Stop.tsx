/* One stop, and what happened at it (ticket 7.5).
 *
 * The custody flow, on the phone, and the reason 7.1 and 7.3 both said this
 * would arrive all at once rather than a piece at a time: a courier who can
 * mark a delivery but cannot sign for it has broken the chain this contract
 * is built on, and half a flow is worse than none.
 *
 * ARRIVAL IS FIRST, AND IT COUNTS EVEN WHEN NOBODY ANSWERS. The deadline is
 * measured against arrival, not against the handover, so a courier who
 * reaches a door on time and waits four minutes for somebody to come to it
 * has made the delivery on time. The web shell puts arrival first for the
 * same reason and this screen does too.
 *
 * EVERYTHING GOES THROUGH THE QUEUE. Not "if offline": always. San Antonio
 * has basements, lift shafts and loading docks, and a courier standing in one
 * of them has still made the delivery. The alternative, try the network and
 * fall back to a queue, has two code paths and only one of them is exercised
 * on a good day, which is how the offline path rots.
 *
 * LEFT AT THE DOOR IS NOT OFFERED, and it is not an oversight. A doorstep
 * delivery needs a photograph, file storage is off until the AWS BAA in
 * ticket 0.10, and the web shell refuses it for exactly the same reason
 * rather than recording an unwitnessed drop. So a courier here has two
 * outcomes: handed over, or could not deliver.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { theme } from '../theme';
import { get, type Stop as StopRow } from '../lib/api';
import { isUnauthorized } from '../lib/http';
import { newId, type OutboxEntry } from '../lib/outbox';
import { queueAndSend } from '../lib/queue';
import { SignaturePad } from './SignaturePad';
import { SignatureMark } from './SignatureMark';
import { handwrittenInitials } from '../lib/handwriting';
import { initialsDescription, initialsOf } from '../lib/initials';
import { CardButton } from '../ui/Glass';
import type { Stroke } from '../lib/strokes';

/** Addendum 1's own list, in its own terms. */
const REASONS: Array<{ code: string; label: string }> = [
    { code: 'recipient_not_located', label: 'Could not find the recipient' },
    { code: 'incorrect_address', label: 'Address is wrong' },
    { code: 'no_access', label: 'Could not get access' },
    { code: 'incomplete_shipment', label: 'Shipment incomplete or wrong' },
    { code: 'refused', label: 'Recipient refused it' },
    { code: 'other', label: 'Something else' },
];

interface Props {
    token: string;
    code: string;
    stop: StopRow;
    onDone: () => void;
    onBack: () => void;
}

/* A failed delivery is recorded PER PACKAGE, because Addendum 1 bills a dry
 * run per item: three cold packs that could not be delivered is three, not
 * one. The run does not carry package ids, so the stop reads them, the same
 * way the web shell does. */
interface OrderDetail {
    status: string;
    packages: Array<{ id: number; description: string; quantity: number }>;
}

type Choice = null | 'deliver' | 'attempt';

export function Stop({ token, code, stop, onDone, onBack }: Props) {
    const [detail, setDetail] = useState<OrderDetail | null>(null);
    const [choice, setChoice] = useState<Choice>(null);
    const [signedName, setSignedName] = useState('');
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    /* The same three choices a collection has (migration 0035). A
       doorstep needs them more, not less: the person receiving may have
       their hands full, be elderly, or be behind a screen door. */
    const [method, setMethod] = useState<'initials' | 'drawn'>('initials');
    const [cannotSign, setCannotSign] = useState(false);
    const [noSignatureReason, setNoSignatureReason] = useState('');
    const [reason, setReason] = useState(REASONS[0]!.code);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<string | null>(null);

    const base = `/api/projects/${code}/uh/orders/${stop.orderId}`;

    const loadDetail = useCallback(async () => {
        try {
            setDetail(await get<OrderDetail>(base, token));
        } catch (err) {
            if (isUnauthorized(err)) return;
            /* Not fatal. Arriving and handing over need nothing from here;
               only a failed delivery does, and that button says why. */
            setDetail(null);
        }
    }, [base, token]);

    useEffect(() => { void loadDetail(); }, [loadDetail]);

    /** Queue one event. The id is the idempotency key: see lib/outbox.ts. */
    const queue = async (path: string, body: Record<string, unknown>, label: string) => {
        setBusy(true);
        try {
            const id = newId();
            const entry: Omit<OutboxEntry, 'attempts'> = {
                id,
                path,
                /* The phone's own timestamp travels with it, so an event
                   queued in a basement at 2:14 is recorded as 2:14 and not as
                   whenever the signal came back. */
                body: { ...body, clientEventId: id, at: new Date().toISOString() },
                label,
                queuedAt: new Date().toISOString(),
            };
            const state = await queueAndSend(entry);
            const waiting = state.queue.length;
            setSaid(waiting === 0
                ? 'Sent.'
                : 'Saved on this phone. It will send itself when you have signal.');
        } finally {
            setBusy(false);
        }
    };

    const arrive = () => queue(`${base}/arrive`, {}, `Arrival at ${stop.recipientName}`);

    const deliver = async () => {
        await queue(
            `${base}/deliver`,
            {
                signedName: signedName.trim(),
                strokes: mark,
                captureMethod: method,
                noSignatureReason: cannotSign ? noSignatureReason.trim() : '',
                note: note.trim(),
            },
            `Delivery for ${stop.recipientName}`,
        );
        onDone();
    };

    const attempt = async () => {
        await queue(
            `${base}/attempt`,
            {
                packages: (detail?.packages ?? []).map((pkg) => ({
                    packageId: pkg.id, reasonCode: reason, note: note.trim(),
                })),
            },
            `Could not deliver to ${stop.recipientName}`,
        );
        onDone();
    };

    const arrived = stop.status === 'picked_up' || stop.status === 'assigned';
    /* Derived as the name is typed, so the courier sees the mark before
       recording it, with the person it belongs to stood in front of them. */
    const auto = method === 'initials' ? handwrittenInitials(signedName) : [];
    const mark = cannotSign ? [] : (method === 'initials' ? auto : strokes);
    /* The name never stops being required: a delivery with nobody's name
       against it is an anonymous handover of a prescription. */
    const hasMark = cannotSign ? noSignatureReason.trim().length > 0 : mark.length > 0;
    const canDeliver = signedName.trim().length > 1 && hasMark && !busy;
    /* Refused rather than sent empty: an attempt with no packages on it bills
       nothing and records nothing about what was in the van. */
    const knowsPackages = (detail?.packages.length ?? 0) > 0;

    return (
        <ScrollView style={styles.wrap} contentContainerStyle={styles.inner}>
            <Pressable onPress={onBack} accessibilityRole="button"><Text style={styles.back}>Today</Text></Pressable>

            <Text style={styles.title}>{stop.recipientName}</Text>
            <Text style={styles.address}>{stop.address}</Text>
            <Text style={styles.address}>{stop.city} {stop.zip}</Text>

            {said !== null && (
                <View style={styles.said} accessibilityLiveRegion="polite">
                    <Text style={styles.saidText}>{said}</Text>
                </View>
            )}

            {choice === null && (
                <>
                    {/* First, and on its own. The deadline is measured
                        against this, and it counts even when nobody answers
                        the door. */}
                    <Pressable
                        style={styles.primary}
                        onPress={() => { void arrive(); }}
                        disabled={busy || !arrived}
                        accessibilityRole="button"
                    >
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>I have arrived</Text>}
                    </Pressable>

                    <Pressable style={styles.secondary} onPress={() => setChoice('deliver')} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Handed over</Text>
                    </Pressable>
                    <Pressable style={styles.secondary} onPress={() => setChoice('attempt')} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Could not deliver</Text>
                    </Pressable>

                    <Text style={styles.footnote}>
                        Left at the door is not offered: it needs a photograph, and photo storage is not switched
                        on yet. Hand it over, or record it as could not deliver.
                    </Text>
                </>
            )}

            {choice === 'deliver' && (
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>Handed over</Text>
                    <Text style={styles.label}>Printed name of whoever took it</Text>
                    <TextInput
                        style={styles.input}
                        value={signedName}
                        onChangeText={setSignedName}
                        autoCapitalize="words"
                        editable={!busy}
                        accessibilityLabel="Printed name of whoever took it"
                    />

                    {!cannotSign && method === 'initials' && (
                        <>
                            <Text style={styles.label}>Their signature</Text>
                            <SignatureMark strokes={auto} />
                            <Text style={styles.hint}>{initialsDescription(signedName)}</Text>
                        </>
                    )}

                    {!cannotSign && method === 'drawn' && (
                        <SignaturePad
                            label="Their signature"
                            onChange={(next) => setStrokes(next)}
                        />
                    )}

                    {cannotSign && (
                        <>
                            <Text style={styles.label}>Why nobody signed</Text>
                            <TextInput
                                style={styles.input}
                                value={noSignatureReason}
                                onChangeText={setNoSignatureReason}
                                multiline
                                editable={!busy}
                                placeholder="This is what University Health sees instead of a signature."
                                accessibilityLabel="Why nobody signed"
                            />
                        </>
                    )}

                    {!cannotSign && (
                        <CardButton
                            title={method === 'initials' ? 'Let them sign instead' : 'Use typed initials'}
                            detail={method === 'initials'
                                ? 'Hand over the phone and let them write it'
                                : `Signs as ${initialsOf(signedName) || 'their initials'}, recorded as typed`}
                            tone="quiet"
                            onPress={() => { setMethod(method === 'initials' ? 'drawn' : 'initials'); setStrokes([]); }}
                        />
                    )}

                    <CardButton
                        title={cannotSign ? 'They can sign after all' : 'They cannot sign'}
                        detail={cannotSign
                            ? 'Go back to the signature'
                            : 'Records the delivery without one, and asks why'}
                        tone="quiet"
                        onPress={() => { setCannotSign(!cannotSign); setNoSignatureReason(''); }}
                    />

                    <Text style={styles.label}>Anything worth noting</Text>
                    <TextInput style={styles.input} value={note} onChangeText={setNote} editable={!busy} />

                    <Pressable
                        style={[styles.primary, !canDeliver && styles.off]}
                        onPress={() => { void deliver(); }}
                        disabled={!canDeliver}
                        accessibilityRole="button"
                    >
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Record the delivery</Text>}
                    </Pressable>
                    <Pressable style={styles.cancel} onPress={() => setChoice(null)} accessibilityRole="button">
                        <Text style={styles.cancelText}>Back</Text>
                    </Pressable>
                </View>
            )}

            {choice === 'attempt' && (
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>Could not deliver</Text>
                    <Text style={styles.label}>What happened</Text>
                    {REASONS.map((r) => (
                        <Pressable
                            key={r.code}
                            style={[styles.reason, reason === r.code && styles.reasonOn]}
                            onPress={() => setReason(r.code)}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: reason === r.code }}
                        >
                            <Text style={[styles.reasonText, reason === r.code && styles.reasonTextOn]}>{r.label}</Text>
                        </Pressable>
                    ))}

                    <Text style={styles.label}>Anything worth noting</Text>
                    <TextInput style={styles.input} value={note} onChangeText={setNote} editable={!busy} />

                    <Text style={styles.footnote}>
                        The packages stay with you. Hand them back to a pharmacy before you go off shift.
                    </Text>

                    {!knowsPackages && (
                        <Text style={styles.footnote}>
                            Waiting for the package list. A dry run is billed per item, so it cannot be recorded
                            without knowing what was in the van.
                        </Text>
                    )}
                    <Pressable
                        style={[styles.primary, (busy || !knowsPackages) && styles.off]}
                        onPress={() => { void attempt(); }}
                        disabled={busy || !knowsPackages}
                        accessibilityRole="button"
                    >
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Record it</Text>}
                    </Pressable>
                    <Pressable style={styles.cancel} onPress={() => setChoice(null)} accessibilityRole="button">
                        <Text style={styles.cancelText}>Back</Text>
                    </Pressable>
                </View>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: 'transparent' },
    inner: { padding: 16, paddingTop: 56, paddingBottom: 48 },
    back: { color: theme.green, fontSize: 16, marginBottom: 10 },
    title: { fontSize: 24, fontWeight: '700', color: theme.ink },
    address: { fontSize: 17, color: theme.ink, lineHeight: 24 },
    card: {
        backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
        borderRadius: 22, padding: 16, marginTop: 16,
    },
    cardTitle: { fontSize: 18, fontWeight: '600', color: theme.ink },
    hint: { fontSize: 15, color: theme.muted, lineHeight: 21, marginTop: 6, marginBottom: 6 },
    label: { fontSize: 15, color: theme.muted, marginTop: 16, marginBottom: 6 },
    input: {
        backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 8,
        paddingHorizontal: 12, paddingVertical: 12, fontSize: 17, color: theme.ink,
    },
    primary: { backgroundColor: theme.green, borderRadius: 18, paddingVertical: 16, alignItems: 'center', marginTop: 20 },
    primaryText: { color: '#fff', fontSize: 17, fontWeight: '600' },
    off: { opacity: 0.4 },
    secondary: {
        borderWidth: 1, borderColor: theme.green, borderRadius: 18,
        paddingVertical: 15, alignItems: 'center', marginTop: 12,
    },
    secondaryText: { color: theme.green, fontSize: 17, fontWeight: '600' },
    cancel: { alignItems: 'center', paddingVertical: 14 },
    cancelText: { color: theme.muted, fontSize: 16 },
    reason: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 8, padding: 14, marginBottom: 8 },
    reasonOn: { borderColor: theme.green, backgroundColor: 'rgba(22,163,74,0.12)' },
    reasonText: { fontSize: 16, color: theme.ink },
    reasonTextOn: { color: theme.green, fontWeight: '600' },
    said: { backgroundColor: 'rgba(22,163,74,0.12)', borderRadius: 18, padding: 14, marginTop: 14 },
    saidText: { color: theme.green, fontSize: 16, lineHeight: 21 },
    footnote: { fontSize: 15, color: theme.muted, lineHeight: 19, marginTop: 14 },
});
