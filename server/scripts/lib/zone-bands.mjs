/* Turning University Health's ZIP-defined zones into mile bands.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT TWENTY LINES INSIDE THE SCRIPT.
 *
 * The number this produces is going into a negotiation with a hospital. It
 * will be questioned, and the answer "a script printed it" is not one. So
 * the arithmetic is separable, readable, and has a test file arguing with it
 * -- including the cases where it should REFUSE to produce an answer.
 *
 * The problem: the BAFO prices five zones and defines them as five lists of
 * ZIPs. It states no mile ranges anywhere; the only mileage in the whole
 * document is the out-of-area rate. Management want the invoice banded by
 * distance like the couriers' pay, so somebody has to say what mile range
 * each zone means, and the least arbitrary source for that is UH's own
 * assignment measured against the distances we already hold.
 */

/** A value at a quantile of an ASCENDING-sorted array. Null when empty. */
export function quantile(sorted, q) {
    if (sorted.length === 0) return null;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Four thresholds separating five zones, derived from observed assignments.
 *
 * ONE BOUNDARY AT A TIME, DELIBERATELY. Each threshold is chosen to best
 * separate "UH call this zone <= k" from "UH call this zone > k" across the
 * real deliveries. Fitting all four jointly would score better on this
 * sample and explain itself far less, and a boundary that cannot be
 * explained in one sentence is no use in a negotiation.
 *
 * Monotonicity is enforced afterwards rather than assumed. Where two zones
 * genuinely overlap in distance -- which UH's do, zone 2 being the south
 * side rather than a ring further out -- the independent fits can come back
 * out of order, and bands that cross are not bands.
 *
 * @param {Array<{zone: number, miles: number}>} observations
 * @param {{maxMiles?: number, step?: number}} [opts]
 * @returns {{bounds: number[], agreement: number, counted: number}}
 */
export function deriveBands(observations, opts = {}) {
    const maxMiles = opts.maxMiles ?? 80;
    const step = opts.step ?? 0.5;
    const usable = observations.filter(
        (o) => Number.isFinite(o.miles) && o.miles > 0
            && Number.isInteger(o.zone) && o.zone >= 1 && o.zone <= 5,
    );
    if (usable.length === 0) return { bounds: [], agreement: 0, counted: 0 };

    const bounds = [];
    for (const k of [1, 2, 3, 4]) {
        let best = null;
        for (let t = step; t <= maxMiles; t += step) {
            let right = 0;
            for (const o of usable) {
                if ((o.zone <= k) === (o.miles <= t)) right += 1;
            }
            /* Strictly greater, so the SMALLEST threshold wins a tie. A tie
               means the stops between the two candidates are all on one
               side anyway; preferring the lower one keeps the bands tight
               rather than quietly widening zone 1 across empty distance. */
            if (best === null || right > best.right) best = { t: Number(t.toFixed(2)), right };
        }
        bounds.push(best.t);
    }
    for (let i = 1; i < bounds.length; i += 1) {
        if (bounds[i] < bounds[i - 1]) bounds[i] = bounds[i - 1];
    }

    let agreement = 0;
    for (const o of usable) if (zoneForMiles(o.miles, bounds) === o.zone) agreement += 1;
    return { bounds, agreement, counted: usable.length };
}

/**
 * The zone a distance falls in, given four ascending boundaries.
 *
 * Boundaries are INCLUSIVE upper edges: with bounds [10, 25, 50, 75], ten
 * miles is zone 1 and ten-point-one is zone 2. That matches how the
 * couriers' own bands are written in the offer letter -- "0-10", "11-25" --
 * and an off-by-one here is a rate band on an invoice.
 */
export function zoneForMiles(miles, bounds) {
    if (!Number.isFinite(miles) || miles <= 0) return null;
    for (let i = 0; i < bounds.length; i += 1) if (miles <= bounds[i]) return i + 1;
    return bounds.length + 1;
}

/**
 * Do these zones overlap in distance enough that no banding can reproduce
 * them? Compared on middle halves rather than extremes, because one stop at
 * the wrong end of a ZIP should not condemn a whole zone.
 *
 * This is the finding, not a diagnostic: if it is true, any mile band
 * disagrees with the contract table on a lot of stops and the disagreement
 * is a property of UH's zones rather than of our arithmetic.
 */
export function zonesOverlap(observations) {
    const byZone = new Map();
    for (const o of observations) {
        if (!Number.isFinite(o.miles) || o.miles <= 0) continue;
        if (!Number.isInteger(o.zone)) continue;
        if (!byZone.has(o.zone)) byZone.set(o.zone, []);
        byZone.get(o.zone).push(o.miles);
    }
    const spans = [...byZone.entries()]
        .map(([zone, miles]) => {
            const s = miles.slice().sort((a, b) => a - b);
            return { zone, lo: quantile(s, 0.25), hi: quantile(s, 0.75) };
        })
        .sort((a, b) => a.zone - b.zone);
    const pairs = [];
    for (let i = 0; i < spans.length; i += 1) {
        for (let j = i + 1; j < spans.length; j += 1) {
            if (spans[i].hi > spans[j].lo) pairs.push([spans[i].zone, spans[j].zone]);
        }
    }
    return { overlapping: pairs.length > 0, pairs, spans };
}
