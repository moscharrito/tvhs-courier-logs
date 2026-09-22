/* One leg, on its own, big enough to type into.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A DIALOG WHEN THERE IS ALREADY A TABLE.
 *
 * The table is right for reading a day: a driver checks their week by
 * running an eye down the MILES column, and that is why it stayed a table
 * rather than becoming cards. It is wrong for typing into. Six of its seven
 * columns are off the side of a 390 point screen, so filling in one leg
 * means panning right, tapping a box the width of a thumb, watching the
 * keyboard cover the row, and panning back to check what was entered.
 *
 * Tapping a leg opens it here instead: all seven fields, full width, in the
 * order the table has them, with the leg named at the top so there is no
 * doubt which row is being edited. The table stays exactly as it was for
 * reading, and for the driver who would rather type in it directly.
 *
 * NOTHING IS WRITTEN UNTIL DONE IS PRESSED. The fields are held here and
 * handed back in one patch, so a driver who opens the wrong leg can close it
 * without having already changed the sheet behind the dialog. Cancel means
 * cancel.
 *
 * Extra legs get two more fields at the top, From and To, because the route
 * definition cannot name a trip that is not on the route. For a standard leg
 * those are fixed and shown as text.
 * ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from 'react';
import {
    KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { CardButton } from '../../ui/Glass';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../../theme';
import { totesOf, type Leg } from '../../lib/tvhs';

export function LegEditor({ leg, index, isExtra, open, onSave, onCancel, onRemove }: {
    leg: Leg | null;
    index: number;
    isExtra: boolean;
    open: boolean;
    onSave: (patch: Leg) => void;
    onCancel: () => void;
    /** Only offered for an extra leg. A standard leg belongs to the route. */
    onRemove?: () => void;
}) {
    const [draft, setDraft] = useState<Leg | null>(leg);

    /* Reload whenever a different leg is opened. Without this, opening leg 2
       after leg 1 would show leg 1's numbers, which is the kind of bug that
       ends with the wrong mileage against the wrong journey. */
    useEffect(() => { setDraft(leg); }, [leg, open]);

    if (draft === null) return null;
    const set = (patch: Partial<Leg>) => setDraft({ ...draft, ...patch });

    const title = isExtra
        ? `Extra leg ${index + 1}`
        : `Leg ${index + 1}: ${draft.legFrom} to ${draft.legTo}`;

    return (
        <Modal visible={open} transparent animationType="slide" onRequestClose={onCancel}>
            <KeyboardAvoidingView
                style={styles.fill}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <Pressable style={styles.scrim} onPress={onCancel} />
                <View style={styles.sheet}>
                    <View style={styles.grip} />
                    <Text style={styles.title}>{title}</Text>

                    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                        {isExtra && (
                            <>
                                <Field label="From">
                                    <TextInput
                                        style={styles.input}
                                        value={draft.legFrom}
                                        onChangeText={(v) => set({ legFrom: v })}
                                        maxLength={60}
                                        placeholder="Where it started"
                                        placeholderTextColor={theme.muted}
                                        accessibilityLabel="From"
                                    />
                                </Field>
                                <Field label="To">
                                    <TextInput
                                        style={styles.input}
                                        value={draft.legTo}
                                        onChangeText={(v) => set({ legTo: v })}
                                        maxLength={60}
                                        placeholder="Where it ended"
                                        placeholderTextColor={theme.muted}
                                        accessibilityLabel="To"
                                    />
                                </Field>
                            </>
                        )}

                        <View style={styles.pair}>
                            <Field label="Start time" flex>
                                <TextInput
                                    style={styles.input}
                                    value={draft.startTime}
                                    onChangeText={(v) => set({ startTime: v })}
                                    keyboardType="numbers-and-punctuation"
                                    placeholder="08:00"
                                    placeholderTextColor={theme.muted}
                                    accessibilityLabel="Start time"
                                />
                            </Field>
                            <Field label="End time" flex>
                                <TextInput
                                    style={styles.input}
                                    value={draft.endTime}
                                    onChangeText={(v) => set({ endTime: v })}
                                    keyboardType="numbers-and-punctuation"
                                    placeholder="09:20"
                                    placeholderTextColor={theme.muted}
                                    accessibilityLabel="End time"
                                />
                            </Field>
                        </View>

                        <View style={styles.pair}>
                            <Field label="Sterile" flex>
                                <TextInput
                                    style={styles.input}
                                    value={draft.sterile}
                                    onChangeText={(v) => set({ sterile: v })}
                                    keyboardType="decimal-pad"
                                    placeholder="0"
                                    placeholderTextColor={theme.muted}
                                    accessibilityLabel="Sterile totes"
                                />
                            </Field>
                            <Field label="Soiled" flex>
                                <TextInput
                                    style={styles.input}
                                    value={draft.soiled}
                                    onChangeText={(v) => set({ soiled: v })}
                                    keyboardType="decimal-pad"
                                    placeholder="0"
                                    placeholderTextColor={theme.muted}
                                    accessibilityLabel="Soiled totes"
                                />
                            </Field>
                        </View>

                        <View style={styles.pair}>
                            <Field label="Total totes" flex>
                                {/* Computed, exactly as the table and the web
                                    compute it. Never typed. */}
                                <View style={styles.computed}>
                                    <Text style={styles.computedText}>{totesOf(draft)}</Text>
                                </View>
                            </Field>
                            <Field label="Miles" flex>
                                <TextInput
                                    style={styles.input}
                                    value={draft.miles}
                                    onChangeText={(v) => set({ miles: v })}
                                    keyboardType="decimal-pad"
                                    placeholder="0"
                                    placeholderTextColor={theme.muted}
                                    accessibilityLabel="Miles"
                                />
                            </Field>
                        </View>

                        {onRemove !== undefined && (
                            <CardButton
                                title="Remove this extra leg"
                                tone="calmDanger"
                                compact
                                onPress={onRemove}
                            />
                        )}
                    </ScrollView>

                    <View style={styles.actions}>
                        <View style={styles.action}>
                            <CardButton title="Cancel" tone="quiet" compact onPress={onCancel} />
                        </View>
                        <View style={styles.action}>
                            <CardButton title="Done" tone="calm" compact onPress={() => onSave(draft)} />
                        </View>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

function Field({ label, children, flex = false }: {
    label: string; children: React.ReactNode; flex?: boolean;
}) {
    return (
        <View style={[styles.field, flex && styles.fieldFlex]}>
            <Text style={styles.fieldLabel}>{label}</Text>
            {children}
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1, justifyContent: 'flex-end' },
    scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(17,24,39,0.45)' },
    sheet: {
        backgroundColor: 'rgba(255,255,255,0.98)',
        borderTopLeftRadius: RADIUS.card,
        borderTopRightRadius: RADIUS.card,
        borderWidth: 1,
        borderColor: GLASS.border,
        paddingHorizontal: SPACE.lg,
        paddingTop: SPACE.sm,
        paddingBottom: SPACE.lg,
        maxHeight: '88%',
    },
    grip: {
        alignSelf: 'center', width: 44, height: 5, borderRadius: RADIUS.pill,
        backgroundColor: 'rgba(17,24,39,0.18)', marginBottom: SPACE.sm,
    },
    title: { fontSize: TYPE.heading, fontWeight: '800', color: theme.ink, marginBottom: SPACE.sm },
    body: { paddingBottom: SPACE.sm },

    pair: { flexDirection: 'row', gap: SPACE.sm },
    field: { marginBottom: SPACE.md },
    fieldFlex: { flex: 1 },
    fieldLabel: {
        fontSize: TYPE.meta, fontWeight: '700', color: theme.greenBright,
        letterSpacing: 0.6, marginBottom: 5, textTransform: 'uppercase',
    },
    input: {
        minHeight: TAP.standard,
        backgroundColor: 'rgba(255,255,255,0.95)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        paddingHorizontal: SPACE.md,
        fontSize: TYPE.body,
        color: theme.ink,
    },
    computed: {
        minHeight: TAP.standard,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: RADIUS.button,
        backgroundColor: 'rgba(22,163,74,0.1)',
        borderWidth: 1,
        borderColor: 'rgba(22,163,74,0.22)',
    },
    computedText: { fontSize: TYPE.body, fontWeight: '700', color: theme.green },

    actions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },
    action: { flex: 1 },
});
