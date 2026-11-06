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
 * True when there is nothing left to estimate: the courier is at the door, or
 * the delivery is closed.
 *
 * Its own predicate because it is asked twice for different reasons -- once
 * to decide, and once BEFORE any lookup so that a page of yesterday's
 * deliveries costs no queries at all. Two copies of this test is how a list
 * ends up estimating an arrival for something delivered last Tuesday.
 */
export function settled(input: EtaInput): boolean {
    return input.arrivedAt !== null
        || input.status === 'delivered'
        || input.status === 'failed'
        || input.status === 'cancelled';
}

/** Where a stop sits in its run. */
export interface Placement {
    /** Stops earlier in the same run that nobody has closed yet. */
    stopsAhead: number;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE DECISION, IN ONE PLACE.
 *
 * Every refusal described in the header is made here and nowhere else, so the
 * figure a pharmacist sees against a row on a list of forty deliveries and
 * the figure they see having opened that row are the same figure, reached the
 * same way. The callers differ only in how they fetch: one delivery at a
 * time, or five hundred in three queries.
 *
 * `placement` null means no run. `perStop` null means not enough history.
 * Both are refusals, and neither is zero.
 */
export function etaFrom(input: EtaInput, placement: Placement | null, perStop: number | null): Eta {
    /* Already there. Saying "about 6 minutes" while a courier stands at the
       door reads as broken. */
    if (settled(input)) return refuse('arrived');
    if (!placement) return refuse('no_run');
    /* Before pickup there is no journey to be part of, only a plan. */
    if (input.pickupAt === null) return refuse('not_collected');

    const { stopsAhead } = placement;
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

/** How many ids to put in one IN list. Well under any variable limit, and the
 *  list above this caps at 500 rows anyway. */
const IN_CHUNK = 400;

const chunked = <T>(xs: readonly T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
};

/**
 * The run and sequence each of these orders currently sits at.
 *
 * Ascending id with the last write winning, which is the newest row. The
 * single-delivery lookup said `ORDER BY rs.id DESC LIMIT 1` and this is the
 * same rule for many orders at once.
 *
 * In practice neither rule decides anything: `run_stops_order_unique`
 * (drizzle/0010) is a UNIQUE INDEX on (project_id, order_id), so an order is
 * in at most one run and there is never a second row to choose between. Kept
 * deliberate rather than tidied away, because if that index is ever relaxed
 * to let a delivery be replanned, this should pick the newer plan rather than
 * whichever row the engine happened to hand back first.
 */
async function placementsOf(
    client: Client, projectId: number, orderIds: readonly number[],
): Promise<Map<number, { runId: number; sequence: number }>> {
    const found = new Map<number, { runId: number; sequence: number }>();
    for (const batch of chunked(orderIds, IN_CHUNK)) {
        const rs = await client.execute({
            sql: `SELECT order_id, run_id, sequence FROM run_stops
                  WHERE project_id = ? AND order_id IN (${batch.map(() => '?').join(',')})
                  ORDER BY id`,
            args: [projectId, ...batch],
        });
        for (const row of rs.rows) {
            found.set(Number(row['order_id']), {
                runId: Number(row['run_id']), sequence: Number(row['sequence']),
            });
        }
    }
    return found;
}

/** The sequence numbers still open on each of these runs, so a stop's queue
 *  position is counted in memory rather than with a query per delivery. */
async function openSequences(
    client: Client, projectId: number, runIds: readonly number[],
): Promise<Map<number, number[]>> {
    const byRun = new Map<number, number[]>();
    for (const batch of chunked(runIds, IN_CHUNK)) {
        const rs = await client.execute({
            sql: `SELECT rs.run_id, rs.sequence FROM run_stops rs JOIN orders o ON o.id = rs.order_id
                  WHERE rs.project_id = ? AND rs.run_id IN (${batch.map(() => '?').join(',')})
                    AND o.status NOT IN ('delivered', 'failed', 'cancelled')`,
            args: [projectId, ...batch],
        });
        for (const row of rs.rows) {
            const run = Number(row['run_id']);
            const seqs = byRun.get(run) ?? [];
            seqs.push(Number(row['sequence']));
            byRun.set(run, seqs);
        }
    }
    return byRun;
}

/**
 * How far away a whole page of deliveries is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THREE QUERIES, NOT THREE PER ROW.
 *
 * The single-delivery version cost three round trips, which is nothing when a
 * pharmacist opens one delivery and 1,500 when the portal lists five hundred.
 * A tracking page that takes eleven seconds is a tracking page nobody leaves
 * open, and a pharmacy watching a dozen deliveries is the entire point of it.
 *
 * So: the median stop time once for the project, the run placements for every
 * order in one IN list, and the open stops on the runs those touch in
 * another. The queue position is then counted in memory. Deliveries that are
 * already finished cost nothing: `settled` answers them before any lookup.
 *
 * Returns an entry for EVERY id asked about -- a missing key would read as
 * "no estimate" to one caller and crash another.
 */
export async function etasFor(
    client: Client, projectId: number, inputs: readonly EtaInput[], now = new Date(),
): Promise<Map<number, Eta>> {
    const out = new Map<number, Eta>();
    const live: EtaInput[] = [];
    for (const input of inputs) {
        if (settled(input)) out.set(input.orderId, etaFrom(input, null, null));
        else live.push(input);
    }
    if (live.length === 0) return out;

    const placements = await placementsOf(client, projectId, live.map((i) => i.orderId));

    /* Only learn the median when something could actually use it. A page of
       deliveries still sitting on the counter should not pay for a 28-day
       scan of every completed stop to be told "not yet collected". */
    const estimable = live.filter((i) => i.pickupAt !== null && placements.has(i.orderId));
    const perStop = estimable.length > 0 ? await minutesPerStop(client, projectId, now) : null;
    const open = estimable.length > 0
        ? await openSequences(client, projectId, [...new Set(estimable.map((i) => placements.get(i.orderId)!.runId))])
        : new Map<number, number[]>();

    for (const input of live) {
        const mine = placements.get(input.orderId);
        if (!mine) { out.set(input.orderId, etaFrom(input, null, perStop)); continue; }
        const ahead = (open.get(mine.runId) ?? []).filter((seq) => seq < mine.sequence).length;
        out.set(input.orderId, etaFrom(input, { stopsAhead: ahead }, perStop));
    }
    return out;
}

/**
 * How far away one delivery is.
 *
 * Through the batch, so there is one lookup rule as well as one decision. For
 * a single order this is the same three queries it always was.
 */
export async function etaFor(client: Client, input: EtaInput, now = new Date()): Promise<Eta> {
    const got = await etasFor(client, input.projectId, [input], now);
    /* etasFor answers every id it is given, so the fallback is unreachable.
       It is here because a type cannot know that. */
    return got.get(input.orderId) ?? refuse('no_run');
}
