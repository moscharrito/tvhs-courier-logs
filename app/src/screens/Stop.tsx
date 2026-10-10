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
    ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { theme } from '../theme';
import { get, type Stop as StopRow } from '../lib/api';
import { isUnauthorized } from '../lib/http';
import { newId, type OutboxEntry } from '../lib/outbox';
import { queueAndSend } from '../lib/queue';
import { capturePhoto, podAvailable, uploadPhoto, type Captured } from '../lib/pod';
import { SignatureMark } from './SignatureMark';
import { handwrittenInitials } from '../lib/handwriting';
import { readablePhone } from '../lib/phone';
import { needsSignerExplanation } from '../lib/handling';

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
    /* ─────────────────────────────────────────────────────────────────
     * TYPED INITIALS ARE THE ONLY WAY TO SIGN HERE, by request.
     *
     * Migration 0035 gave a doorstep the same three choices a collection
     * has, on the reasoning that a doorstep needs them more rather than
     * less: the person receiving may have their hands full, be elderly, or
     * be behind a screen door. The two links that reached the other two
     * are removed.
     *
     * The cost, stated plainly: a recipient who wants to sign in their own
     * hand cannot, and a delivery nobody will give a name for cannot be
     * recorded as delivered, because the name is what the initials are
     * drawn from. The courier's remaining option there is to record it as
     * a failed attempt with a reason, which is a truthful record of a
     * doorstep where nothing was handed over, and the wrong record for one
     * where something was. The server still accepts `drawn` and `none`, so
     * putting either path back is a UI change, not a migration.
     * ───────────────────────────────────────────────────────────────── */
    const [reason, setReason] = useState(REASONS[0]!.code);
    const [note, setNote] = useState('');
    /* Why somebody other than the patient took a Medicare delivery. Only
       ever asked for, and only ever sent, when that is what happened. */
    const [signerReason, setSignerReason] = useState('');
    const [busy, setBusy] = useState(false);
    /* Proof of delivery. Undefined until the server has been asked; the step
       is not drawn at all while storage is off, so no camera is ever opened
       for a photo that has nowhere lawful to go. See lib/pod.ts. */
    const [podOn, setPodOn] = useState<boolean | undefined>(undefined);
    const [photo, setPhoto] = useState<Captured | null>(null);
    const [photoNote, setPhotoNote] = useState<string | null>(null);
    /* ─────────── University Health, 29 September 2026 ───────────────────
     * The signature moved onto their own paper form, which the recipient
     * signs and the courier photographs. `formPhoto` is what proves a
     * handover now; the typed initials below remain only as the fallback
     * for a handset that cannot upload at all.
     *
     * `idPhoto` is identification, and only where the pharmacy stamped the
     * form. `checked` is the three identifiers the courier could actually
     * confirm at the door, which is a subset and not a boolean: a phone the
     * pharmacy never sent cannot be checked, and a form that made somebody
     * tick it anyway would be manufacturing a fact. */
    const [formPhoto, setFormPhoto] = useState<Captured | null>(null);
    const [idPhoto, setIdPhoto] = useState<Captured | null>(null);
    const [checked, setChecked] = useState<string[]>([]);
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

    useEffect(() => {
        void podAvailable(token, code).then((c) => setPodOn(c.available));
    }, [token, code]);

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

    const takePhoto = async () => {
        const shot = await capturePhoto();
        if (shot.kind === 'cancelled') return;
        if (shot.kind === 'refused') { setPhotoNote(shot.message); return; }
        setPhoto(shot.photo);
        setPhotoNote(null);
    };

    /** One camera open, one photograph, no library access. See lib/pod.ts. */
    const captureInto = async (set: (c: Captured | null) => void) => {
        const shot = await capturePhoto();
        if (shot.kind !== 'captured') {
            if (shot.kind === 'refused') setPhotoNote(shot.message);
            return;
        }
        set(shot.photo);
        setPhotoNote(null);
    };

    const toggle = (field: string) =>
        setChecked((was) => (was.includes(field) ? was.filter((f) => f !== field) : [...was, field]));

    const deliver = async () => {
        /* THE PHOTO GOES FIRST, AND NEVER INTO THE OUTBOX. It is uploaded
           straight to S3 now, before the delivery is recorded, so a failure
           is something the courier finds out about while they are still
           standing there. If it fails the delivery still goes: a delivery
           with no photo is a delivery, and a photo held on a shared handset
           waiting for signal is PHI nobody agreed to store there. */
        if (photo !== null) {
            setBusy(true);
            const up = await uploadPhoto(token, code, stop.orderId, photo);
            setBusy(false);
            if (up.kind === 'failed') {
                setPhotoNote(`${up.message} The delivery was recorded without it.`);
                setPhoto(null);
            }
        }
        /* The form and the identification go up the same way and for the
           same reason: now, while the courier is still standing there, so a
           failure is something they find out about rather than something
           discovered a week later by somebody reading a report.
           UNLIKE THE DOORSTEP PHOTO, a failure here stops the delivery. A
           doorstep drop without its picture is still a delivery; a handover
           whose proof did not upload is a handover we cannot evidence, and
           where the form was stamped ID Required it is one the pharmacy
           forbade outright. */
        let courierFormFileId: number | undefined;
        let patientIdFileId: number | undefined;
        for (const [shot, kind, label] of [
            [formPhoto, 'courier_form', 'signed form'],
            [idPhoto, 'patient_id', 'identification'],
        ] as const) {
            if (shot === null) continue;
            setBusy(true);
            const up = await uploadPhoto(token, code, stop.orderId, shot, kind);
            setBusy(false);
            if (up.kind === 'failed') {
                setPhotoNote(`The ${label} photo could not be sent: ${up.message} Nothing was recorded. Try again, or record this as a failed attempt.`);
                return;
            }
            if (kind === 'courier_form') courierFormFileId = up.fileId;
            else patientIdFileId = up.fileId;
        }

        await queue(
            `${base}/deliver`,
            {
                signedName: signedName.trim(),
                /* Only when there is no photographed form: the initials are
                   the fallback for a handset that cannot upload, not a
                   second signature sitting beside the paper one. */
                strokes: courierFormFileId === undefined ? auto : [],
                captureMethod: 'initials',
                noSignatureReason: '',
                note: note.trim(),
                ...(signerReason.trim() === '' ? {} : { signerNotPatientReason: signerReason.trim() }),
                ...(courierFormFileId !== undefined ? { courierFormFileId } : {}),
                ...(patientIdFileId !== undefined ? { patientIdFileId } : {}),
                identifiersChecked: checked,
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
    const auto = handwrittenInitials(signedName);
    /* The name never stops being required: a delivery with nobody's name
       against it is an anonymous handover of a prescription. */
    /* WHAT THE PHARMACY REQUIRES, IN THE ORDER IT MATTERS.
     *
     * With storage on, the photographed form is the proof and the initials
     * are not offered. With it off there is nowhere to put a photograph, so
     * the initials remain the fallback rather than stranding a courier at a
     * door with no way to record a handover that happened.
     *
     * ID Required with storage off is the one case with no way through: the
     * pharmacy forbade the handover without a photograph and there is
     * nowhere to put one. The screen says so and offers the failed attempt,
     * which is the truthful record. */
    const canPhotograph = podOn === true;
    const needsId = stop.idRequired;
    /* ASKED AT THE DOOR, NOT REFUSED AFTERWARDS. This app queues, so a
       server refusal arrives when the courier is three streets away and the
       medication has already changed hands. See lib/handling.ts. */
    const mustExplainSigner = needsSignerExplanation(
        {
            signatureRequired: stop.signatureRequired ?? true,
            signatureRule: stop.signatureRule,
            authorisedSigners: stop.authorisedSigners,
            recipientName: stop.recipientName,
        },
        signedName,
    );
    const signerExplained = !mustExplainSigner || signerReason.trim().length > 2;
    const idSatisfied = !needsId || idPhoto !== null;
    const proofSatisfied = canPhotograph ? formPhoto !== null : auto.length > 0;
    const blockedByStorage = needsId && !canPhotograph;
    const canDeliver = signedName.trim().length > 1 && proofSatisfied && idSatisfied
        && signerExplained && !blockedByStorage && !busy;
    /* Refused rather than sent empty: an attempt with no packages on it bills
       nothing and records nothing about what was in the van. */
    const knowsPackages = (detail?.packages.length ?? 0) > 0;

    return (
        <ScrollView style={styles.wrap} contentContainerStyle={styles.inner}>
            <Pressable onPress={onBack} accessibilityRole="button"><Text style={styles.back}>Today</Text></Pressable>

            <Text style={styles.title}>{stop.recipientName}</Text>
            <Text style={styles.address}>{stop.address}</Text>
            <Text style={styles.address}>{stop.city} {stop.zip}</Text>

            {/* HOW THE PHARMACY SENT IT, above everything else on the screen.
            
                A courier reads this before knocking or not at all. Putting it
                beside the signature box would be putting it after the moment
                it changes what they do: whether to go back to the van for the
                cooler, and whether the person opening the door is allowed to
                take this at all.
            
                The words come from the server already phrased, so this screen
                and the proof of delivery cannot describe the same delivery
                differently. */}
            {(stop.handlingFlags ?? []).length > 0 && (
                <View style={styles.flags}>
                    {(stop.handlingFlags ?? []).map((f) => (
                        <Text key={f} style={styles.flag}>{f}</Text>
                    ))}
                </View>
            )}
            {stop.signingInstruction !== undefined && stop.signingInstruction !== '' && (
                <Text style={styles.instruction}>{stop.signingInstruction}</Text>
            )}

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

                    {/* Appears the moment the typed name is neither the
                        patient nor anybody the pharmacy named, and only for
                        a Medicare delivery.
                    
                        A REASON, NOT A REFUSAL. The courier is looking at a
                        highlighted paper form, a person and their ID; we are
                        comparing two strings. Married names, nicknames and
                        the pharmacy's own transcription would all fail an
                        exact match at a door at seven in the morning with
                        the medication already in hand. What must not happen
                        is the handover being recorded SILENTLY as though the
                        patient took it. */}
                    {mustExplainSigner && (
                        <View style={styles.warnBox}>
                            <Text style={styles.warnTitle}>
                                {signedName.trim()} is not {stop.recipientName}
                            </Text>
                            <Text style={styles.warnBody}>
                                This one is Medicare. If they are not the patient and the pharmacy did not
                                name them, take it back. If you are handing it over anyway, say why.
                            </Text>
                            <TextInput
                                style={styles.input}
                                value={signerReason}
                                onChangeText={setSignerReason}
                                editable={!busy}
                                multiline
                                placeholder="e.g. Patient bedbound, daughter showed the patient ID"
                                accessibilityLabel="Why somebody other than the patient is taking this"
                            />
                        </View>
                    )}

                    {/* THE THREE IDENTIFIERS, checked against the person at
                        the door. University Health asks for name, address and
                        phone before anything is handed over.

                        Each is ticked separately and the phone is disabled
                        when the pharmacy sent none, because "not provided" and
                        "not checked" are different facts and a form that let
                        somebody tick an empty field would be manufacturing
                        one. What is ticked is what gets recorded. */}
                    <Text style={styles.label}>Check these against the person</Text>
                    {([
                        ['name', 'Name', stop.recipientName],
                        ['address', 'Address', `${stop.address}, ${stop.zip}`],
                        ['phone', 'Phone', readablePhone(stop.recipientPhone)],
                    ] as const).map(([field, label, value]) => {
                        const missing = value.trim() === '';
                        return (
                            <Pressable
                                key={field}
                                style={[styles.check, checked.includes(field) && styles.checkOn, missing && styles.off]}
                                onPress={() => { if (!missing) toggle(field); }}
                                disabled={missing || busy}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: checked.includes(field), disabled: missing }}
                                accessibilityLabel={`${label}: ${missing ? 'not provided by the pharmacy' : value}`}
                            >
                                <Text style={styles.checkBox}>{checked.includes(field) ? '✓' : ' '}</Text>
                                <View style={styles.checkBody}>
                                    <Text style={styles.checkLabel}>{label}</Text>
                                    <Text style={styles.checkValue}>
                                        {missing ? 'Not provided by the pharmacy' : value}
                                    </Text>
                                </View>
                            </Pressable>
                        );
                    })}

                    {/* THE SIGNED PAPER FORM, which replaced the drawn
                        signature at the client's request. Their document,
                        signed by the recipient, photographed by us.
                        The typed initials below are shown only when there is
                        nowhere to put a photograph, so a courier is never
                        stranded at a door by a storage outage. */}
                    {canPhotograph ? (
                        <>
                            <Text style={styles.label}>Photo of the signed courier form</Text>
                            <Pressable
                                style={styles.photo}
                                onPress={() => { void captureInto(setFormPhoto); }}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={formPhoto === null ? 'Photograph the signed courier form' : 'Retake the courier form photo'}
                            >
                                {formPhoto === null
                                    ? <Text style={styles.photoText}>Take a photo  ·  required</Text>
                                    : <Image source={{ uri: formPhoto.uri }} style={styles.photoShot} resizeMode="cover" />}
                            </Pressable>
                            {formPhoto !== null && (
                                <Pressable onPress={() => setFormPhoto(null)} style={styles.photoDrop}>
                                    <Text style={styles.photoDropText}>Retake it</Text>
                                </Pressable>
                            )}
                        </>
                    ) : (
                        <>
                            <Text style={styles.label}>Their signature</Text>
                            <SignatureMark strokes={auto} />
                            <Text style={styles.photoNote}>
                                Photo storage is unavailable, so the signed form cannot be captured.
                                Their initials are being recorded instead.
                            </Text>
                        </>
                    )}

                    {/* ID REQUIRED. The pharmacy stamped this one, so the
                        medication may only go to somebody who proved who they
                        are. The server refuses the delivery without it, and
                        this says so before the courier knocks rather than at
                        the moment they are turned away. */}
                    {needsId && canPhotograph && (
                        <>
                            <Text style={[styles.label, styles.warnLabel]}>ID REQUIRED  ·  photograph their identification</Text>
                            <Pressable
                                style={styles.photo}
                                onPress={() => { void captureInto(setIdPhoto); }}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={idPhoto === null ? 'Photograph the recipient identification' : 'Retake the identification photo'}
                            >
                                {idPhoto === null
                                    ? <Text style={styles.photoText}>Take a photo  ·  required</Text>
                                    : <Image source={{ uri: idPhoto.uri }} style={styles.photoShot} resizeMode="cover" />}
                            </Pressable>
                            {idPhoto !== null && (
                                <Pressable onPress={() => setIdPhoto(null)} style={styles.photoDrop}>
                                    <Text style={styles.photoDropText}>Retake it</Text>
                                </Pressable>
                            )}
                        </>
                    )}
                    {blockedByStorage && (
                        <Text style={styles.photoNote}>
                            This delivery is marked ID Required and photo storage is unavailable, so it
                            cannot be recorded as handed over. Record it as a failed attempt instead.
                        </Text>
                    )}

                    {/* Proof of delivery. Drawn only when the server says it
                        has somewhere lawful to put it, and optional either
                        way: a door nobody can photograph is still a
                        delivery. */}
                    {podOn === true && (
                        <>
                            <Text style={styles.label}>Photo of the doorstep</Text>
                            <Pressable
                                style={styles.photo}
                                onPress={() => { void takePhoto(); }}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={photo === null ? 'Take a doorstep photo' : 'Retake the doorstep photo'}
                            >
                                {photo === null
                                    ? <Text style={styles.photoText}>Take a photo  ·  optional</Text>
                                    : <Image source={{ uri: photo.uri }} style={styles.photoShot} resizeMode="cover" />}
                            </Pressable>
                            {photo !== null && (
                                <Pressable onPress={() => setPhoto(null)} style={styles.photoDrop}>
                                    <Text style={styles.photoDropText}>Remove the photo</Text>
                                </Pressable>
                            )}
                        </>
                    )}
                    {photoNote !== null && <Text style={styles.photoNote}>{photoNote}</Text>}

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
    photo: {
        minHeight: 96,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: 'rgba(22,163,74,0.4)',
        backgroundColor: 'rgba(22,163,74,0.06)',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        marginBottom: 8,
    },
    photoText: { fontSize: 16, fontWeight: '600', color: theme.green },
    photoShot: { width: '100%', height: 170 },
    photoDrop: { minHeight: 44, justifyContent: 'center' },
    photoDropText: { fontSize: 15, fontWeight: '600', color: theme.danger },
    /* The three identifiers. Wide rows with the value printed under the
       label, because a courier reads these aloud to somebody standing in a
       doorway and a truncated address is worse than none. */
    check: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        borderWidth: 1, borderColor: theme.line, borderRadius: 10,
        paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8,
    },
    checkOn: { borderColor: theme.green, backgroundColor: theme.greenSoft },
    checkBox: {
        width: 22, height: 22, lineHeight: 22, textAlign: 'center',
        borderWidth: 1, borderColor: theme.line, borderRadius: 4,
        fontSize: 15, fontWeight: '700', color: theme.green,
    },
    checkBody: { flex: 1, minWidth: 0 },
    checkLabel: { fontSize: 12, color: theme.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
    checkValue: { fontSize: 15, color: theme.ink },
    warnLabel: { color: theme.danger, fontWeight: '700' },
    photoNote: { fontSize: 15, color: theme.muted, lineHeight: 21, marginBottom: 8 },
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

    /* How the pharmacy sent it, at the top of the screen. Sized to be read
       at arm's length in a van, not to be elegant. */
    flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
    flag: {
        fontSize: 13, fontWeight: '700', color: theme.ink,
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden',
    },
    instruction: { fontSize: 16, fontWeight: '600', color: theme.ink, lineHeight: 22, marginTop: 10 },

    /* The Medicare mismatch. Loud on purpose: it is the one thing on this
       screen that means "stop and think about whether to hand this over". */
    warnBox: {
        borderWidth: 1, borderColor: theme.danger, borderRadius: 12,
        padding: 12, marginTop: 12, backgroundColor: 'rgba(255,255,255,0.7)',
    },
    warnTitle: { fontSize: 16, fontWeight: '700', color: theme.danger },
    warnBody: { fontSize: 15, color: theme.ink, lineHeight: 20, marginTop: 4, marginBottom: 8 },
});
