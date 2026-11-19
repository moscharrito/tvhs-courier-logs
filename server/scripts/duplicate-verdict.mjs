/* Deciding whether a delivered order is a duplicate, and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FUNCTION AND NOT PART OF THE SCRIPT.
 *
 * It decides whether a delivery gets deleted. That destroys a custody chain
 * and a proof-of-delivery photograph, and there is no undo. It is the most
 * dangerous twenty lines in this repository and it was, until now, only
 * reachable by booting a server, seeding it, and reading the output -- a
 * loop I got wrong four times running while the logic underneath it was
 * right. The fixtures were wrong; the tool was blamed.
 *
 * So the decision is here, pure, taking plain objects and returning a
 * verdict, with a test beside it that can describe a shape in six lines.
 * The script around it does the HTTP and the deleting and no deciding.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE, AND THE ONE IT REPLACED.
 *
 * The first version asked "is this a reattempt child". That is true of
 * almost every reattempt on the contract, nearly all of which are correct:
 * one failed trip, one successful second trip, one child. It would have
 * deleted real deliveries -- on exactly the deliveries that were hardest to
 * make -- and it would have looked like it was working.
 *
 * The rule is: DOES THE PARENT HAVE MORE THAN ONE DELIVERED CHILD. A package
 * can be handed over once. Two children both marked delivered is one package
 * recorded twice, whatever produced them, and the EARLIER one keeps the
 * proof: it was recorded first, and on all five production cases it is the
 * one the driver actually filled in.
 *
 * Every verdict below is reached from what the orders say about themselves.
 * None of them is reachable by naming an id on a command line.
 */

/** A reattempt says whose it is, in its own created event. */
export const REATTEMPT_OF = /Reattempt of delivery (\d+)/i;

/** And the parent names each child it spawned, in its own notes. */
export const REATTEMPTED_AS = /Reattempted as delivery (\d+)/gi;

/** The `created` event's own words. '' when there is none. */
export function cameFrom(order) {
    const made = (order?.custody ?? []).find((e) => e.type === 'created');
    return made ? String(made.reason ?? '') : '';
}

/** Every delivery an order says it spawned, oldest first. */
export function childrenOf(order) {
    const ids = new Set();
    for (const e of order?.custody ?? []) {
        const text = String(e.reason ?? '');
        REATTEMPTED_AS.lastIndex = 0;
        let m = REATTEMPTED_AS.exec(text);
        while (m) { ids.add(Number(m[1])); m = REATTEMPTED_AS.exec(text); }
    }
    return [...ids].sort((a, b) => a - b);
}

/** Whose second attempt this is, or null if it is not one. */
export function parentIdOf(order) {
    const m = REATTEMPT_OF.exec(cameFrom(order));
    return m ? Number(m[1]) : null;
}

export const REMOVABLE = 'DUPLICATE SECOND ATTEMPT';

/**
 * @param order    the delivered order in question, with its `custody`
 * @param parent   the order it names as its parent, with its `custody`, or null
 * @param siblings [{ id, status }] for every child the PARENT names,
 *                 including `order` itself
 * @returns {{ verdict: string, why: string, removable: boolean }}
 */
export function verdictFor(order, parent, siblings) {
    if (!order) return { verdict: 'UNREADABLE', why: 'no order', removable: false };

    if (order.status !== 'delivered') {
        return {
            verdict: 'NOT DELIVERED',
            why: `it is ${order.status}; this removes a delivery that never happened, not a record of one that failed`,
            removable: false,
        };
    }

    const origin = cameFrom(order);
    const parentId = parentIdOf(order);
    if (parentId === null) {
        /* Not a reattempt at all, so one of the 5 or 9 November double
           imports. Both of those rows are real imports of real work; the
           question is which LIST should not have been imported, and that is
           answered a list at a time rather than an order at a time. */
        return {
            verdict: 'NOT A REDELIVERY',
            why: origin === ''
                ? `no created event to read; daily list ${order.dailyListId ?? '(none)'}`
                : `${origin} (daily list ${order.dailyListId ?? 'none'})`,
            removable: false,
        };
    }

    if (!parent) {
        return { verdict: 'UNREADABLE PARENT', why: `#${parentId} could not be read`, removable: false };
    }

    const named = childrenOf(parent);
    if (!named.includes(Number(order.id))) {
        /* The child claims the parent and the parent does not claim it back.
           Unexpected, so nothing is destroyed on the strength of it. */
        return {
            verdict: 'UNCONFIRMED',
            why: `#${parentId} does not name it among its reattempts (${named.join(', ') || 'none'})`,
            removable: false,
        };
    }

    const delivered = (siblings ?? []).filter((k) => k.status === 'delivered').map((k) => Number(k.id)).sort((a, b) => a - b);
    if (delivered.length < 2) {
        return {
            verdict: 'THE ONLY DELIVERY',
            why: `#${parentId} failed and was delivered once, on this attempt. A round that took two trips, not a duplicate.`,
            removable: false,
        };
    }

    const keep = delivered[0];
    if (Number(order.id) === keep) {
        return {
            verdict: 'THE ONE THAT KEEPS THE PROOF',
            why: `#${parentId} has ${delivered.length} delivered attempts (${delivered.join(', ')}); this is the earliest and stays`,
            removable: false,
        };
    }

    return {
        verdict: REMOVABLE,
        why: `#${parentId} has ${delivered.length} delivered attempts (${delivered.join(', ')}); #${keep} is the earliest and keeps the proof`,
        removable: true,
    };
}
