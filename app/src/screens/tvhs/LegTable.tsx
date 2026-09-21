/* The seven-column table, on a phone.
 *
 * ROUTE LEG | START TIME | END TIME | STERILE | SOILED | TOTAL TOTES | MILES
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT FITS, since seven columns do not fit across 390 points.
 *
 * It scrolls sideways, and the ROUTE LEG column does not move. That is the
 * whole trick: a driver panning right to reach MILES can still see which
 * leg they are on, which is the thing that makes a wide table usable rather
 * than a guessing game. Both halves share one row height so they cannot
 * drift apart.
 *
 * The rejected alternative was shrinking the columns to fit, which is how
 * the boxes became too small to read or hit in the first place. Every input
 * here is still TAP.minimum tall and 17pt, the same as everywhere else in
 * the app: the table is panned, not compressed.
 *
 * The header and the Daily Totals row live inside the same horizontal
 * scroll as the data, so all three stay aligned by construction rather than
 * by three numbers that have to be kept equal by hand.
 * ───────────────────────────────────────────────────────────────────────── */

import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { GLASS, RADIUS, SPACE, TAP, TYPE, theme } from '../../theme';
import { totesOf, type Leg } from '../../lib/tvhs';

/* One height for every row in both halves. If these drift, the frozen
   column slides out of step with the data and the table lies. */
const HEADER_H = 38;
const ROW_H = 72;

/* Wide enough for a thumb and for "TOTAL TOTES" to sit on one line. */
const COL = {
    leg: 132,
    time: 104,
    count: 88,
    totes: 104,
    miles: 92,
} as const;

export function LegTable({ legs, onChange, editable = true }: {
    legs: Leg[];
    onChange: (index: number, patch: Partial<Leg>) => void;
    editable?: boolean;
}) {
    const sterile = legs.reduce((n, l) => n + (Number(l.sterile.trim()) || 0), 0);
    const soiled = legs.reduce((n, l) => n + (Number(l.soiled.trim()) || 0), 0);
    const miles = legs.reduce((n, l) => n + (Number(l.miles.trim()) || 0), 0);

    return (
        <View style={styles.table}>
            {/* The column that stays put. */}
            <View style={styles.frozen}>
                <View style={[styles.headCell, { height: HEADER_H, width: COL.leg }]}>
                    <Text style={styles.headText}>ROUTE LEG</Text>
                </View>
                {legs.map((leg, i) => (
                    <View key={i} style={[styles.legCell, { height: ROW_H, width: COL.leg }]}>
                        <Text style={styles.legNumber}>{i + 1}</Text>
                        <Text style={styles.legPlaces} numberOfLines={2}>
                            {leg.legFrom || '?'} ▶ {leg.legTo || '?'}
                        </Text>
                    </View>
                ))}
                <View style={[styles.totalCell, { height: ROW_H, width: COL.leg }]}>
                    <Text style={styles.totalLabel}>Daily Totals</Text>
                </View>
            </View>

            {/* Everything else, panned together. */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                /* Snapping would fight a driver trying to see two columns at
                   once, which is the usual reason to pan at all. */
                contentContainerStyle={styles.scrolled}
            >
                <View>
                    <View style={[styles.headRow, { height: HEADER_H }]}>
                        <Head width={COL.time} label="START TIME" />
                        <Head width={COL.time} label="END TIME" />
                        <Head width={COL.count} label="STERILE" />
                        <Head width={COL.count} label="SOILED" />
                        <Head width={COL.totes} label="TOTAL TOTES" />
                        <Head width={COL.miles} label="MILES" />
                    </View>

                    {legs.map((leg, i) => (
                        <View key={i} style={[styles.dataRow, { height: ROW_H }]}>
                            <Cell width={COL.time}>
                                <Input
                                    value={leg.startTime}
                                    onChange={(v) => onChange(i, { startTime: v })}
                                    placeholder="08:00"
                                    editable={editable}
                                    label={`Start time, leg ${i + 1}`}
                                />
                            </Cell>
                            <Cell width={COL.time}>
                                <Input
                                    value={leg.endTime}
                                    onChange={(v) => onChange(i, { endTime: v })}
                                    placeholder="09:20"
                                    editable={editable}
                                    label={`End time, leg ${i + 1}`}
                                />
                            </Cell>
                            <Cell width={COL.count}>
                                <Input
                                    value={leg.sterile}
                                    onChange={(v) => onChange(i, { sterile: v })}
                                    numeric
                                    editable={editable}
                                    label={`Sterile, leg ${i + 1}`}
                                />
                            </Cell>
                            <Cell width={COL.count}>
                                <Input
                                    value={leg.soiled}
                                    onChange={(v) => onChange(i, { soiled: v })}
                                    numeric
                                    editable={editable}
                                    label={`Soiled, leg ${i + 1}`}
                                />
                            </Cell>
                            <Cell width={COL.totes}>
                                {/* Computed, like the web. Never typed. */}
                                <View style={styles.computed}>
                                    <Text style={styles.computedText}>{totesOf(leg)}</Text>
                                </View>
                            </Cell>
                            <Cell width={COL.miles}>
                                <Input
                                    value={leg.miles}
                                    onChange={(v) => onChange(i, { miles: v })}
                                    numeric
                                    editable={editable}
                                    label={`Miles, leg ${i + 1}`}
                                />
                            </Cell>
                        </View>
                    ))}

                    <View style={[styles.totalsRow, { height: ROW_H }]}>
                        <Cell width={COL.time}><Text style={styles.totalBlank}>—</Text></Cell>
                        <Cell width={COL.time}><Text style={styles.totalBlank}>—</Text></Cell>
                        <Cell width={COL.count}><Text style={styles.totalValue}>{sterile}</Text></Cell>
                        <Cell width={COL.count}><Text style={styles.totalValue}>{soiled}</Text></Cell>
                        <Cell width={COL.totes}><Text style={styles.totalValue}>{sterile + soiled}</Text></Cell>
                        <Cell width={COL.miles}>
                            <Text style={styles.totalValue}>{Math.round(miles * 10) / 10}</Text>
                        </Cell>
                    </View>
                </View>
            </ScrollView>
        </View>
    );
}

function Head({ width, label }: { width: number; label: string }) {
    return (
        <View style={[styles.headCell, { width }]}>
            <Text style={styles.headText} numberOfLines={1}>{label}</Text>
        </View>
    );
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
    return <View style={[styles.cell, { width }]}>{children}</View>;
}

function Input({ value, onChange, placeholder, numeric = false, editable, label }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    numeric?: boolean;
    editable: boolean;
    label: string;
}) {
    return (
        <TextInput
            style={styles.input}
            value={value}
            onChangeText={onChange}
            editable={editable}
            keyboardType={numeric ? 'decimal-pad' : 'numbers-and-punctuation'}
            placeholder={placeholder ?? ''}
            placeholderTextColor={theme.muted}
            accessibilityLabel={label}
            textAlign="center"
        />
    );
}

const styles = StyleSheet.create({
    table: {
        flexDirection: 'row',
        backgroundColor: GLASS.fill,
        borderRadius: RADIUS.card,
        borderWidth: 1,
        borderColor: GLASS.border,
        overflow: 'hidden',
        ...GLASS.shadow,
    },
    /* A hairline and a shadow-ish edge, so the frozen column reads as being
       in front of what slides under it. */
    frozen: {
        borderRightWidth: 1,
        borderRightColor: 'rgba(17,24,39,0.12)',
        backgroundColor: 'rgba(255,255,255,0.5)',
    },
    scrolled: { paddingRight: SPACE.sm },

    headRow: { flexDirection: 'row' },
    headCell: {
        justifyContent: 'center',
        paddingHorizontal: SPACE.xs,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(17,24,39,0.1)',
        backgroundColor: 'rgba(22,163,74,0.08)',
    },
    headText: { fontSize: 12, fontWeight: '800', color: theme.green, letterSpacing: 0.4, textAlign: 'center' },

    legCell: {
        justifyContent: 'center',
        paddingHorizontal: SPACE.sm,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(17,24,39,0.07)',
    },
    legNumber: { fontSize: TYPE.meta, fontWeight: '800', color: theme.greenBright },
    legPlaces: { fontSize: 13, color: theme.ink, lineHeight: 17, marginTop: 1 },

    dataRow: { flexDirection: 'row' },
    cell: {
        justifyContent: 'center',
        paddingHorizontal: SPACE.xs,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(17,24,39,0.07)',
    },
    input: {
        backgroundColor: 'rgba(255,255,255,0.92)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        /* The same floor as everywhere else. The table is panned, not
           compressed: that was the whole point of not shrinking columns. */
        minHeight: TAP.minimum,
        paddingHorizontal: SPACE.xs,
        fontSize: TYPE.body,
        color: theme.ink,
    },
    computed: {
        minHeight: TAP.minimum,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: RADIUS.button,
        backgroundColor: 'rgba(22,163,74,0.1)',
        borderWidth: 1,
        borderColor: 'rgba(22,163,74,0.22)',
    },
    computedText: { fontSize: TYPE.body, fontWeight: '700', color: theme.green },

    totalCell: { justifyContent: 'center', paddingHorizontal: SPACE.sm, backgroundColor: 'rgba(22,163,74,0.06)' },
    totalLabel: { fontSize: TYPE.meta, fontWeight: '800', color: theme.ink },
    totalsRow: { flexDirection: 'row', backgroundColor: 'rgba(22,163,74,0.06)' },
    totalValue: { fontSize: TYPE.body, fontWeight: '800', color: theme.green, textAlign: 'center' },
    totalBlank: { fontSize: TYPE.body, color: theme.muted, textAlign: 'center' },
});
