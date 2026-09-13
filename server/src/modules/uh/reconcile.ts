/* Checking the invoice against the price table, by hand.
 *
 * This file deliberately shares NOTHING with pricing.ts. It re-derives what a
 * delivery should cost from the rate card and the contract wording, using
 * plain arithmetic written out the way a person with a calculator and the bid
 * table would do it. Then the two are compared.
 *
 * A reconciliation that called priceFor would prove only that priceFor equals
 * itself. The point of this exercise is to have two independent readings of
 * the same contract and find out where they differ, before University Health
 * finds out for us.
 *
 * WHAT THIS CAN AND CANNOT PROVE. It proves the invoice pipeline computes what
 * the rate card below says. It cannot prove the rate card matches the signed
 * bid table, because the signed document is not in this repository: those
 * numbers were transcribed in ticket 1.2 and transcribed again here from the
 * migration. A person has to compare the printed rate card against the signed
 * bid table once, and the reconciliation report prints it for exactly that.
 */

/** Transcribed from migration 0007, which was built from the bid table. */
export const RATE_CARD = {
    effectiveFrom: '2026-05-18',
    label: 'Izy BAFO (RFP-226-03-068-SVC)',
    zone1: 12.50,
    zone2: 14.50,
    zone3: 22.00,
    zone4: 36.00,
    zone5: 52.00,
    statSurcharge: 22.00,
    afterHoursSurcharge: 18.00,
    dryRunFee: 9.00,
    outOfAreaPerMile: 1.95,
} as const;

/* Addendum 1: after-hours is "between 8:00 p.m. and 7:00 a.m." Written as
 * plain hour numbers here rather than shared with the settings, so that a
 * change to the setting cannot silently change both sides of this check. */
const AFTER_HOURS_FROM_HOUR = 20;
const AFTER_HOURS_UNTIL_HOUR = 7;

export interface CheckInput {
    zone: number | null;
    serviceType: string;
    dryRun: boolean;
    items: number;
    outOfAreaMiles: number | null;
    /** The instant the service was performed, as the invoice measured it. */
    performedAt: string;
    timezone: string;
}

export interface CheckResult {
    expectedCents: number;
    /** The arithmetic, in words, for a person checking with a calculator. */
    working: string[];
    /** Questions this line raises about the contract, not about the code. */
    questions: string[];
}

/** The hour of the day at a place, without importing anybody's helper. */
export function hourAt(iso: string, timezone: string): number {
    const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: '2-digit', hour12: false,
    }).format(new Date(iso));
    // Intl gives "24" for midnight in some engines.
    return Number(formatted) % 24;
}

export function isAfterHoursByContract(iso: string, timezone: string): boolean {
    const hour = hourAt(iso, timezone);
    return hour >= AFTER_HOURS_FROM_HOUR || hour < AFTER_HOURS_UNTIL_HOUR;
}

const zoneRate = (zone: number): number => {
    switch (zone) {
        case 1: return RATE_CARD.zone1;
        case 2: return RATE_CARD.zone2;
        case 3: return RATE_CARD.zone3;
        case 4: return RATE_CARD.zone4;
        case 5: return RATE_CARD.zone5;
        default: throw new Error(`Zone ${zone} is not on the rate card`);
    }
};

/**
 * What the bid table says this delivery costs.
 *
 * Read the way a person would: start with the zone rate, add the surcharges
 * the contract names, and for an attempted delivery charge the flat dry-run
 * fee per item instead of the delivery charge.
 */
export function expectedForLine(input: CheckInput): CheckResult {
    const working: string[] = [];
    const questions: string[] = [];
    const cents = (dollars: number) => Math.round(dollars * 100);

    let total = 0;

    if (input.dryRun) {
        const items = Math.max(1, input.items);
        const fee = cents(RATE_CARD.dryRunFee) * items;
        total += fee;
        working.push(`dry run: $${RATE_CARD.dryRunFee.toFixed(2)} x ${items} item${items === 1 ? '' : 's'} = $${(fee / 100).toFixed(2)}`);
        working.push('dry run replaces the delivery charge, so no zone rate and no mileage');
        /* Addendum 1 calls the dry run "a predetermined flat fee ... to cover
         * the attempted service for each item" and says nothing about whether
         * the STAT or after-hours surcharges still apply to an attempt. The
         * platform keeps them; that is a reading, not a rule. */
        if (input.serviceType === 'stat') {
            questions.push('A STAT delivery that failed is charged the dry-run fee AND the STAT surcharge. Addendum 1 does not say whether a surcharge survives an attempt.');
        }
    } else if (input.zone === null) {
        const miles = input.outOfAreaMiles ?? 0;
        const amount = Math.round(cents(RATE_CARD.outOfAreaPerMile) * miles);
        total += amount;
        working.push(`out of area: ${miles} miles x $${RATE_CARD.outOfAreaPerMile.toFixed(2)} = $${(amount / 100).toFixed(2)}`);
    } else {
        const rate = zoneRate(input.zone);
        total += cents(rate);
        working.push(`zone ${input.zone}: $${rate.toFixed(2)}`);
    }

    if (input.serviceType === 'stat') {
        total += cents(RATE_CARD.statSurcharge);
        working.push(`STAT surcharge: $${RATE_CARD.statSurcharge.toFixed(2)}`);
    }
    if (isAfterHoursByContract(input.performedAt, input.timezone)) {
        total += cents(RATE_CARD.afterHoursSurcharge);
        working.push(`after hours (performed at ${hourAt(input.performedAt, input.timezone)}:00 local): $${RATE_CARD.afterHoursSurcharge.toFixed(2)}`);
    }

    working.push(`total: $${(total / 100).toFixed(2)}`);
    return { expectedCents: total, working, questions };
}

export interface Difference {
    orderId: number;
    reference: string;
    invoiceCents: number;
    expectedCents: number;
    differenceCents: number;
    working: string[];
}

export interface Reconciliation {
    lines: number;
    invoiceTotalCents: number;
    expectedTotalCents: number;
    differenceCents: number;
    differences: Difference[];
    questions: string[];
    /** A few lines with their arithmetic, for a person to check by hand. */
    samples: Difference[];
}

export interface ReconcilableLine {
    orderId: number;
    reference: string;
    zone: number | null;
    serviceType: string;
    dryRun: boolean;
    items: number;
    outOfAreaMiles: number | null;
    amountCents: number;
    /** When the invoice priced it: delivered, else picked up, else requested. */
    performedAt: string;
}

export function reconcile(lines: ReconcilableLine[], timezone: string, sampleSize = 8): Reconciliation {
    const differences: Difference[] = [];
    const samples: Difference[] = [];
    const questions = new Set<string>();
    let invoiceTotalCents = 0;
    let expectedTotalCents = 0;

    for (const [index, line] of lines.entries()) {
        const check = expectedForLine({
            zone: line.zone,
            serviceType: line.serviceType,
            dryRun: line.dryRun,
            items: line.items,
            outOfAreaMiles: line.outOfAreaMiles,
            performedAt: line.performedAt,
            timezone,
        });
        for (const q of check.questions) questions.add(q);

        invoiceTotalCents += line.amountCents;
        expectedTotalCents += check.expectedCents;

        const entry: Difference = {
            orderId: line.orderId,
            reference: line.reference,
            invoiceCents: line.amountCents,
            expectedCents: check.expectedCents,
            differenceCents: line.amountCents - check.expectedCents,
            working: check.working,
        };
        if (entry.differenceCents !== 0) differences.push(entry);
        /* Spread the samples through the month rather than taking the first
         * few: the first few are all one day and all one pharmacy. */
        if (index % Math.max(1, Math.floor(lines.length / sampleSize)) === 0 && samples.length < sampleSize) {
            samples.push(entry);
        }
    }

    return {
        lines: lines.length,
        invoiceTotalCents,
        expectedTotalCents,
        differenceCents: invoiceTotalCents - expectedTotalCents,
        differences,
        questions: [...questions],
        samples,
    };
}
