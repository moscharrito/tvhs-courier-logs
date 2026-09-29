/* Roughly when a delivery will arrive.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS NOT A ROUTED ETA, AND IT CANNOT BE.
 *
 * The version a hospital pictures is the one their food delivery app shows:
 * a driver's position, the destination, live traffic, a time. We cannot build
 * that one, and the reason is not effort.
 *
 * Computing it means sending the destination to a routing service. The
 * destination is a patient's home address, which is PHI. Google Maps Platform
 * is not covered by Google's BAA and their terms exclude protected health
 * information, and core/geo/provider.ts refuses in code to send a patient
 * address anywhere for exactly this reason. Buying a different routing vendor
 * would mean another BAA and another subprocessor holding every patient
 * address we carry, to produce a number that is nice to look at.
 *
 * So this estimates from something we already know and that leaves nothing:
 * WHERE THE STOP SITS IN THE COURIER'S RUN, and how long a stop has actually
 * been taking lately. No address goes anywhere. Nothing new is collected.
 *
 * WHAT IT IS, PRECISELY: the courier has N stops to make before this one, and
 * a stop has recently been taking M minutes including the drive, so this is
 * about N x M minutes away. That is an honest statement about a queue, and it
 * is reported in those words rather than as a clock time, because a clock
 * time reads like a promise and this is not one.
 *
 * IT REFUSES RATHER THAN GUESSES, in three cases that matter:
 *
 *   No run          Nothing has been planned, so there is no queue to be in.
 *   Not collected   The medication is still on the counter. Anything said
 *                   about arrival before pickup is a guess about dispatch,
 *                   not about a journey.
 *   No history      Fewer than MIN_SAMPLES completed stops to learn from.
 *                   A median over two stops is a number with a false face.
 *
 * A pharmacist reading "we cannot estimate this yet" is better served than
 * one reading a confident figure derived from nothing.
 */

import type { Client } from '@libsql/client';

/** Below this many completed stops, the median is noise wearing a suit. */
export const MIN_SAMPLES = 8;

/** How far back to learn from. Long enough to have samples, short enough that
 *  a round driven in December is not describing one driven in June. */
export const LEARN_DAYS = 28;

/** Beyond this, the estimate is not useful and saying so is more honest than
 *  telling a hospital their medication is four hours away. */
export const MAX_USEFUL_MINUTES = 240;

export type EtaBasis =
    | 'no_run'
    | 'not_collected'
    | 'no_history'
    | 'too_far'
    | 'arrived'
    | 'estimated';

export interface Eta {
    /** Minutes from now, or null whenever this is anything but an estimate. */
    minutes: number | null;
    /** Stops the courier has before this one. Null when there is no run. */
    stopsAhead: number | null;
    basis: EtaBasis;
    /** One sentence for a person, saying what this is and is not. */
    note: string;
}

const NOTES: Record<EtaBasis, string> = {
    no_run: 'Not yet planned into a run, so there is nothing to estimate from.',
    not_collected: 'Not yet collected from the pharmacy.',
    no_history: 'Not enough completed stops recently to estimate from.',
    too_far: 'More than four hours of stops ahead of it; too far out to estimate usefully.',
    arrived: 'The courier is at the address.',
    estimated: '',
};

const refuse = (basis: EtaBasis, stopsAhead: number | null = null): Eta =>
    ({ minutes: null, stopsAhead, basis, note: NOTES[basis] });

/**
 * The median minutes between one completed stop and the next, over recent
 * runs in this project.
 *
 * Consecutive completions on the SAME run, so what is measured is a stop plus
 * the drive to it, which is the unit being counted. Gaps across a break or
 * between two runs would be measuring lunch.
 *
 * Returns null when there is not enough to learn from. Callers must treat
 * that as a refusal and not as zero.
 */
export async function minutesPerStop(client: Client, projectId: number, now: Date): Promise<number | null> {
    const since = new Date(now.getTime() - LEARN_DAYS * 86400000).toISOString();
    const rs = await client.execute({
        sql: `SELECT rs.run_id, o.delivered_at
              FROM run_stops rs JOIN orders o ON o.id = rs.order_id
              WHERE rs.project_id = ? AND o.delivered_at IS NOT NULL AND o.delivered_at >= ?
              ORDER BY rs.run_id, o.delivered_at`,
        args: [projectId, since],
    });

    const gaps: number[] = [];
    let lastRun: number | null = null;
    let lastAt = 0;
    for (const row of rs.rows) {
        const runId = Number(row['run_id']);
        const at = Date.parse(String(row['delivered_at']));
        if (!Number.isFinite(at)) continue;
        if (runId === lastRun && lastAt > 0) {
            const mins = Math.round((at - lastAt) / 60000);
            /* A gap of zero is two stops recorded together, which is a data
               entry pattern and not a journey. A gap over two hours is a
               break, a shift change or a correction. Neither describes how
               long a stop takes. */
            if (mins > 0 && mins <= 120) gaps.push(mins);
        }
        lastRun = runId;
        lastAt = at;
    }

    if (gaps.length < MIN_SAMPLES) return null;
    gaps.sort((a, b) => a - b);
    /* Nearest rank, like the turnaround report: an invented value between two
       real ones is not more accurate, only harder to explain. */
    return gaps[Math.ceil(0.5 * gaps.length) - 1] ?? null;
}

export interface EtaInput {
    projectId: number;
    orderId: number;
    status: string;
    /** Set once the courier is at the door. */
    arrivedAt: string | null;
    /** Set when the medication left the counter. */
    pickupAt: string | null;
}

/**
 * How far away one delivery is.
 *
 * Reads the run this order sits in, counts the stops before it that are not
 * finished, and multiplies by what a stop has been taking.
 */
export async function etaFor(client: Client, input: EtaInput, now = new Date()): Promise<Eta> {
    /* Already there. Nothing to estimate and saying "about 6 minutes" while a
       courier stands at the door reads as broken. */
    if (input.arrivedAt !== null) return refuse('arrived');
    if (input.status === 'delivered' || input.status === 'failed' || input.status === 'cancelled') {
        return refuse('arrived');
    }

    const stop = await client.execute({
        sql: `SELECT rs.run_id, rs.sequence FROM run_stops rs
              WHERE rs.project_id = ? AND rs.order_id = ?
              ORDER BY rs.id DESC LIMIT 1`,
        args: [input.projectId, input.orderId],
    });
    const mine = stop.rows[0];
    if (!mine) return refuse('no_run');

    /* Before pickup there is no journey to be part of, only a plan. */
    if (input.pickupAt === null) return refuse('not_collected');

    /* Stops earlier in the run that nobody has closed yet, this one included
       in the queue but not in the count of what is ahead. */
    const ahead = await client.execute({
        sql: `SELECT COUNT(*) AS n FROM run_stops rs JOIN orders o ON o.id = rs.order_id
              WHERE rs.project_id = ? AND rs.run_id = ? AND rs.sequence < ?
                AND o.status NOT IN ('delivered', 'failed', 'cancelled')`,
        args: [input.projectId, Number(mine['run_id']), Number(mine['sequence'])],
    });
    const stopsAhead = Number(ahead.rows[0]?.['n'] ?? 0);

    const perStop = await minutesPerStop(client, input.projectId, now);
    if (perStop === null) return refuse('no_history', stopsAhead);

    /* Plus one for this stop's own drive: a courier with nothing ahead of
       them is still travelling to the door. */
    const minutes = (stopsAhead + 1) * perStop;
    if (minutes > MAX_USEFUL_MINUTES) return refuse('too_far', stopsAhead);

    return {
        minutes,
        stopsAhead,
        basis: 'estimated',
        /* Said in terms of the queue, not as a clock time. A clock time reads
           like a promise, and this is an average multiplied by a position. */
        note: stopsAhead === 0
            ? `On the way now; a stop has been taking about ${perStop} minutes.`
            : `${stopsAhead} ${stopsAhead === 1 ? 'stop' : 'stops'} ahead of it, at about ${perStop} minutes a stop.`,
    };
}
