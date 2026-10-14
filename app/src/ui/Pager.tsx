/* Pages of eight, on a phone.
 *
 * Ticket 7.14. The same hook and the same control the web app has had since
 * 5.15, with the same size, so "eight" means eight on a dispatcher's screen
 * and on a courier's phone and nobody has to ask which.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ARGUMENT AGAINST THIS, RECORDED BECAUSE IT WAS MINE AND IT LOST.
 *
 * A phone scrolls. A thumb is a better pager than two buttons, and a driver
 * working one-handed at a counter does not want to tap Next. That is why the
 * app was left alone in 5.15 and in 7.8.
 *
 * The owner asked twice. Consistency across the two surfaces is a real thing
 * to want -- a lead who uses the web board in the morning and the phone in
 * the afternoon should not meet two different ideas of a long list -- and
 * the screens that carry real length (ninety days of history, a month of
 * TVHS log rows) genuinely were walls of text.
 *
 * WHAT MAKES IT SAFE is the rule the dispatch board was paged under: the
 * TOTAL IS ALWAYS ON SCREEN. "Showing 1 to 8 of 23" is not decoration; it is
 * the thing that stops a page of eight reading as a list of eight. A courier
 * who believes they have nine stops when they have twenty-three has been
 * misled by the software, and that is worse than scrolling.
 *
 * AND THE RUN SCREEN KEEPS ITS COUNT. Run.tsx leads with the next stop and
 * says how many are done out of how many; paging the list underneath does
 * not touch either, so the number a driver plans their afternoon from is
 * never the number that got paged.
 *
 * THE PAGE IS DERIVED, NOT STORED, for the same reason as the web: these
 * lists move. A run refreshes, a stop is delivered and leaves the list, a
 * window changes from 7 days to 90. Clamped every render, so a list
 * shrinking under a thumb lands on the last real page rather than on an
 * empty one that reads as "everything is gone".
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RADIUS, SPACE, TAP, TYPE, theme } from '../theme';
import { pageOf, PAGE_SIZE, type Page } from '../lib/paging';

export { PAGE_SIZE };

export interface Paged<T> extends Page<T> {
    setPage: (n: number) => void;
}

/** The arithmetic is pageOf, in lib/paging.ts, where it is tested. This adds
 *  the one piece of state: which page the reader last asked for. */
export function usePaged<T>(items: T[], size: number = PAGE_SIZE): Paged<T> {
    const [wanted, setPage] = useState(0);
    return { ...pageOf(items, wanted, size), setPage };
}

/**
 * Previous, the count, Next.
 *
 * THE COUNT IS ALWAYS THERE; THE BUTTONS ARE NOT. Two permanently disabled
 * buttons under a three-row list are clutter, and on a phone they are also a
 * tap target where the next thing a thumb wants is not. But hiding the whole
 * control meant a courier with a short run never saw one at all, which reads
 * as a missing feature rather than as the control working.
 *
 * Nothing when there is nothing: a list with no rows already says so in its
 * own words, and "0 of 0" underneath is a second, worse version of it.
 */
export function Pager<T>({ of, noun }: { of: Paged<T>; noun: string }) {
    const { page, pages, total, from, to, setPage } = of;
    if (total === 0) return null;

    if (pages <= 1) {
        /* "All 5 stops" rather than "1 to 5 of 5", which nobody says. */
        return <Text style={[styles.count, styles.alone]}>All {total} {noun}</Text>;
    }

    return (
        <View style={styles.wrap}>
            <Pressable
                onPress={() => setPage(page - 1)}
                disabled={page === 0}
                style={[styles.button, page === 0 && styles.off]}
                accessibilityRole="button"
                accessibilityLabel={`Previous page of ${noun}`}
                accessibilityState={{ disabled: page === 0 }}
            >
                <Text style={[styles.label, page === 0 && styles.labelOff]}>Previous</Text>
            </Pressable>

            {/* The whole point. Without the total, a page of eight is
                indistinguishable from a list of eight. */}
            <Text style={styles.count} accessibilityLiveRegion="polite">
                {from} to {to} of {total}
            </Text>

            <Pressable
                onPress={() => setPage(page + 1)}
                disabled={page >= pages - 1}
                style={[styles.button, page >= pages - 1 && styles.off]}
                accessibilityRole="button"
                accessibilityLabel={`Next page of ${noun}`}
                accessibilityState={{ disabled: page >= pages - 1 }}
            >
                <Text style={[styles.label, page >= pages - 1 && styles.labelOff]}>Next</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACE.sm,
        marginTop: SPACE.md,
    },
    /* TAP.minimum, like everything else a thumb has to hit. A pager is used
       with one hand, often in a vehicle, and a 13px target is how a courier
       loses their place. */
    button: {
        minHeight: TAP.minimum,
        minWidth: 96,
        paddingHorizontal: SPACE.md,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: RADIUS.button,
        borderWidth: 1,
        borderColor: theme.line,
    },
    off: { opacity: 0.4 },
    label: { fontSize: TYPE.meta, fontWeight: '700', color: theme.ink },
    labelOff: { color: theme.muted },
    count: { fontSize: TYPE.meta, color: theme.muted, flexShrink: 1, textAlign: 'center' },
    /* On its own line rather than between two buttons, so it sits where the
       list ends instead of centred in empty space. */
    alone: { textAlign: 'left', marginTop: SPACE.md },
});
