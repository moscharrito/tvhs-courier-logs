/* A whole day of the contract, generated.
 *
 * 273 stops on a weekday across nine pharmacies, twelve couriers, every one of
 * them driven through the real lifecycle: released, assigned to a run,
 * collected at a counter, arrived at, delivered or failed, and the failures
 * carried back. It exists so that the board, the reports and the invoice have
 * something the size of the real thing to work against before the real thing
 * arrives, and so a demo is not three orders in a row.
 *
 * WHAT IS REAL AND WHAT IS ASSUMED. The daily total is UH's: Addendum 1 and
 * the bid table give about 273 stops per weekday and 227 per weekend day from
 * nine pharmacies. Everything below that is an assumption made here and
 * labelled as one: the split between pharmacies, the mix of service types, the
 * failure rate. The redacted sample list UH referenced was never supplied to
 * us (open item), and inventing a distribution is honest only while it is
 * clearly signed as invented. When the sample arrives, these constants are
 * what changes.
 *
 * NOTHING WRITES A STATUS DIRECTLY. Every state change goes through
 * recordOrderEvent, the same path the courier app uses, so a simulated day
 * cannot contain an order in a state the application could not have produced.
 * A simulator that wrote statuses straight into the table would happily
 * generate data that hides a lifecycle bug rather than exposing one.
 *
 * DETERMINISTIC. The same seed gives the same day, so two runs can be
 * compared, a load test can be repeated, and a bug found in a simulated wave
 * can be reproduced.
 */

import type { Client, InValue } from '@libsql/client';
import { resolveSettings, type ProjectSettings } from '../../core/projects/settings';
import { recordOrderEvent, type OrderStateRow } from './order-events';
import { dueForNewOrder } from './lifecycle';
import type { ServiceType } from './import-parse';

/** Everything simulated carries this, so a run can be undone. */
export const SIMULATION_PREFIX = 'SIM';

/** UH's own figures (Addendum 1, bid table). */
export const WEEKDAY_STOPS = 273;
export const WEEKEND_STOPS = 227;

/* ASSUMED. Discharge is the only pharmacy UH described as highest volume; the
 * rest of this split is invented so the board has a realistic shape, and will
 * be replaced by the sample list. Weights, not counts: they are normalised. */
const SITE_WEIGHTS: Record<string, number> = {
    discharge: 30, pavilion: 16, green: 12, southeast: 9, southwest: 9,
    tdi: 8, vida: 7, wheatley: 6, bc3: 3,
};

/* ASSUMED. Addendum 1 describes the daily list as the ordinary case, with STAT
 * and ad hoc as exceptions, but gives no ratio. */
const SERVICE_MIX: Array<{ type: ServiceType; weight: number }> = [
    { type: 'scheduled', weight: 80 },
    { type: 'stat', weight: 15 },
    { type: 'adhoc', weight: 5 },
];

/* ASSUMED, and deliberately not flattering. Addendum 1 holds us to an 85 per
 * cent completion rate, so a simulated day that always succeeded would make
 * every report look finished and test nothing. */
const FAILURE_RATE = 0.07;
/** Of the arrivals, how many land after the deadline. */
const LATE_RATE = 0.1;
/** A stop where nobody could sign and the medication allowed a doorstep drop. */
const DOORSTEP_RATE = 0.12;
/** Packages needing a signature, so the doorstep rule is exercised both ways. */
const SIGNATURE_RATE = 0.35;

/* ASSUMED, and it exists because without it the generated data never exercises
 * the after-hours surcharge at all: every simulated delivery happened in the
 * afternoon, so an $18 line on the invoice was only ever unit-tested. Addendum
 * 1 names after-hours service as its own billable category, so a realistic day
 * has some. Found by the reconciliation in ticket 3.5. */
const AFTER_HOURS_RATE = 0.06;

const DRY_RUN_REASONS = ['recipient_not_located', 'incorrect_address', 'no_access', 'incomplete_shipment', 'refused', 'other'] as const;

/* Invented people. Two lists crossed, so 273 names do not repeat much and none
 * of them is anybody: no patient data, real or redacted, belongs in a
 * generator that lives in a repository. */
const FIRST_NAMES = [
    'Ines', 'Marcus', 'Priya', 'Dolores', 'Arthur', 'Lucia', 'Teresa', 'Owen', 'Mateo', 'Nadia',
    'Curtis', 'Beatriz', 'Samuel', 'Yolanda', 'Hector', 'Joan', 'Felix', 'Rosa', 'Duncan', 'Amara',
];
const LAST_NAMES = [
    'Vargas', 'Ibarra', 'Raman', 'Fuentes', 'Nwosu', 'Herrera', 'Lam', 'Castillo', 'Okafor', 'Brennan',
    'Salazar', 'Whitfield', 'Duarte', 'Kowalski', 'Mendoza',
];
const STREETS = [
    'Rigsby Ave', 'Blanco Rd', 'Gembler Rd', 'Tom Slick', 'Pat Booker Rd', 'Bandera Rd',
    'John Smith Dr', 'Fredericksburg Rd', 'Nacogdoches Rd', 'Culebra Rd', 'Zarzamora St',
    'Commerce St', 'Military Dr', 'Callaghan Rd', 'Perrin Beitel Rd',
];
const DESCRIPTIONS = [
    'Oral solids', 'Refrigerated', 'Controlled substance', 'Infusion supplies',
    'Cold pack', 'Inhaler', 'Injectable', 'Wound care supplies',
];
const NOTES = [
    'Gate code did not work and the office was closed',
    'Nobody answered and the neighbour would not take it',
    'Apartment number missing from the list',
    'Recipient had already been discharged elsewhere',
];

/* ------------------------------------------------------------- randomness */

/** mulberry32: small, fast, and the same everywhere, which is the point. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;

function weighted<T>(rng: () => number, entries: Array<{ value: T; weight: number }>): T {
    const total = entries.reduce((n, e) => n + e.weight, 0);
    let roll = rng() * total;
    for (const e of entries) {
        roll -= e.weight;
        if (roll <= 0) return e.value;
    }
    return entries[entries.length - 1]!.value;
}

/* ---------------------------------------------------------------- options */

export interface SimulateOptions {
    projectId: number;
    serviceDate: string;
    timezone: string;
    settings: ProjectSettings;
    /** Default: 273 on a weekday, 227 at a weekend, per the bid table. */
    orders?: number;
    couriers?: number;
    seed?: number;
    /** Skip the courier events and leave a board full of work to dispatch. */
    stopAfter?: 'created' | 'assigned' | 'picked_up' | 'complete';
    /** Called with a one-line progress note. */
    onProgress?: (line: string) => void;
}

export interface SimulateResult {
    serviceDate: string;
    seed: number;
    orders: number;
    packages: number;
    runs: number;
    couriers: string[];
    events: number;
    byStatus: Record<string, number>;
    onTime: { met: number; missed: number; rate: number | null };
    dryRuns: number;
    returned: number;
    doorstepCandidates: number;
    elapsedMs: number;
}

const isWeekend = (serviceDate: string, timezone: string): boolean => {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' })
        .format(new Date(`${serviceDate}T12:00:00Z`));
    return day === 'Sat' || day === 'Sun';
};

/* -------------------------------------------------------------- the wave */

export async function simulateWave(client: Client, options: SimulateOptions): Promise<SimulateResult> {
    const startedAt = Date.now();
    const {
        projectId, serviceDate, timezone, settings,
        seed = 20260912, couriers: courierCount = 12, stopAfter = 'complete',
        onProgress = () => { },
    } = options;
    const orderCount = options.orders ?? (isWeekend(serviceDate, timezone) ? WEEKEND_STOPS : WEEKDAY_STOPS);
    const rng = seededRandom(seed);

    const siteRows = await client.execute({
        sql: `SELECT id, code, name FROM sites WHERE project_id = ? AND status = 'active' ORDER BY code`,
        args: [projectId],
    });
    if (siteRows.rows.length === 0) throw new Error('That project has no sites to simulate from');
    const sites = siteRows.rows.map((r) => ({ id: Number(r['id']), code: String(r['code']), name: String(r['name']) }));
    const siteChoices = sites.map((s) => ({ value: s, weight: SITE_WEIGHTS[s.code] ?? 5 }));

    const zipRows = await client.execute({
        sql: `SELECT DISTINCT zip, zone FROM zone_zips WHERE project_id = ? ORDER BY zip`,
        args: [projectId],
    });
    const zips = zipRows.rows.map((r) => ({ zip: String(r['zip']), zone: Number(r['zone']) }));
    /* A few addresses outside the zone table, because out-of-area billing is a
     * real line on the invoice and a day without one never tests it. */
    const outOfArea = ['78006', '78015', '78163', '78266'];

    /* ------------------------------------------------------------ orders */

    // The day's list lands between noon and 2pm (Addendum 1).
    const listAt = new Date(`${serviceDate}T12:00:00`);
    const localOffsetMs = listAt.getTime() - Date.parse(`${serviceDate}T12:00:00Z`);
    const atLocal = (hour: number, minute: number) =>
        new Date(Date.parse(`${serviceDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`) + localOffsetMs);

    const orderIds: number[] = [];
    const orderMeta = new Map<number, { siteId: number; serviceType: ServiceType; signatureRequired: boolean; packageId: number; receivedAt: Date; afterHours: boolean }>();
    let packages = 0;

    for (let i = 0; i < orderCount; i += 1) {
        const site = weighted(rng, siteChoices);
        const serviceType = weighted(rng, SERVICE_MIX.map((m) => ({ value: m.type, weight: m.weight })));
        const address = rng() < 0.04 ? { zip: pick(rng, outOfArea), zone: null } : pick(rng, zips);
        const signatureRequired = rng() < SIGNATURE_RATE;
        /* Requests trickle in across the release window rather than all at
           once, except for the evening ones: an after-hours request arrives
           after the working day and is delivered after it too. */
        const afterHours = rng() < AFTER_HOURS_RATE;
        const receivedAt = afterHours
            ? new Date(atLocal(20, 15).getTime() + Math.floor(rng() * 120) * 60000)
            : new Date(atLocal(12, 0).getTime() + Math.floor(rng() * 120) * 60000);
        const due = dueForNewOrder(serviceType, receivedAt, settings);
        const quantity = 1 + Math.floor(rng() * 3);

        const inserted = await client.execute({
            sql: `INSERT INTO orders (project_id, site_id, service_date, external_ref, service_type,
                                      recipient_name, address_line, city, state, zip, zone, delivery_notes,
                                      signature_required, received_at, due_at, status, dedupe_key, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'San Antonio', 'TX', ?, ?, '', ?, ?, ?, 'ready', ?, ?) RETURNING id`,
            args: [
                projectId, site.id, serviceDate,
                `${SIMULATION_PREFIX}-${seed}-${String(i + 1).padStart(4, '0')}`,
                serviceType,
                `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
                `${100 + Math.floor(rng() * 8900)} ${pick(rng, STREETS)}`,
                address.zip, address.zone,
                signatureRequired ? 1 : 0,
                receivedAt.toISOString(),
                due.dueAt ? due.dueAt.toISOString() : null,
                `${SIMULATION_PREFIX}-${seed}-${i}`,
                receivedAt.toISOString(),
            ] as InValue[],
        });
        const orderId = Number(inserted.rows[0]!['id']);
        const pkg = await client.execute({
            sql: `INSERT INTO packages (project_id, order_id, description, quantity, signature_required, outcome)
                  VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`,
            args: [projectId, orderId, pick(rng, DESCRIPTIONS), quantity, signatureRequired ? 1 : 0],
        });
        packages += quantity;
        orderIds.push(orderId);
        orderMeta.set(orderId, { siteId: site.id, serviceType, signatureRequired, packageId: Number(pkg.rows[0]!['id']), receivedAt, afterHours });
    }
    onProgress(`${orderCount} orders created across ${sites.length} pharmacies`);

    const result: SimulateResult = {
        serviceDate, seed, orders: orderCount, packages, runs: 0, couriers: [],
        events: 0, byStatus: {}, onTime: { met: 0, missed: 0, rate: null },
        dryRuns: 0, returned: 0, doorstepCandidates: 0, elapsedMs: 0,
    };

    if (stopAfter === 'created') return finish(client, projectId, serviceDate, result, startedAt);

    /* ------------------------------------------------------------- runs */

    const courierNames = await ensureCouriers(client, projectId, courierCount);
    result.couriers = courierNames;
    /* Give each of them a session, ending when their day does.
     *
     * Presence on the board comes from the sessions table and position comes
     * from events, and without this the board shows a courier who "never
     * signed in" alongside a position they sent five minutes ago. That
     * contradiction is an artifact of generated data, and a demo that shows it
     * invites a question about the board rather than about the work. */
    await giveSessions(client, courierNames, atLocal(12, 0), atLocal(20, 0));

    /* Each courier gets a dense loop from one pharmacy where possible: the
     * dispatch strategy's whole argument is that batching by origin is what
     * makes the drive time work. Orders are dealt out site by site. */
    /* The evening work goes to one courier on its own run. Mixing it into a
     * daytime loop would mean a package collected at one o'clock and delivered
     * at nine, which is not a shift anybody works. */
    const eveningIds = orderIds.filter((id) => orderMeta.get(id)!.afterHours);
    const daytimeIds = orderIds.filter((id) => !orderMeta.get(id)!.afterHours);

    const bySite = new Map<number, number[]>();
    for (const id of daytimeIds) {
        const siteId = orderMeta.get(id)!.siteId;
        if (!bySite.has(siteId)) bySite.set(siteId, []);
        bySite.get(siteId)!.push(id);
    }

    const runIdByCourier = new Map<string, number>();
    for (const [index, courier] of courierNames.entries()) {
        const run = await client.execute({
            sql: `INSERT INTO runs (project_id, courier_username, service_date, label, status, created_at)
                  VALUES (?, ?, ?, ?, 'planned', ?) RETURNING id`,
            args: [projectId, courier, serviceDate, `Wave ${index + 1}`, atLocal(12, 30).toISOString()],
        });
        runIdByCourier.set(courier, Number(run.rows[0]!['id']));
    }
    result.runs = runIdByCourier.size;

    const stopsByCourier = new Map<string, number[]>(courierNames.map((c) => [c, []]));
    const eveningCourier = courierNames[courierNames.length - 1]!;
    let cursor = 0;
    for (const list of bySite.values()) {
        for (const orderId of list) {
            const courier = courierNames[cursor % courierNames.length]!;
            stopsByCourier.get(courier)!.push(orderId);
            cursor += 1;
        }
        // Move to the next courier between pharmacies so one courier's loop
        // stays mostly at one counter.
        cursor += 1;
    }
    for (const id of eveningIds) stopsByCourier.get(eveningCourier)!.push(id);

    const fresh = async (id: number): Promise<OrderStateRow & { status: string }> => {
        const rs = await client.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
        return Object.fromEntries(Object.entries(rs.rows[0]!)) as unknown as OrderStateRow & { status: string };
    };
    const record = async (id: number, actor: string, event: Parameters<typeof recordOrderEvent>[1]['event']) => {
        await recordOrderEvent(client, { projectId, order: await fresh(id), actor, settings, event });
        result.events += 1;
    };

    for (const [courier, ids] of stopsByCourier) {
        const runId = runIdByCourier.get(courier)!;
        for (const [sequence, orderId] of ids.entries()) {
            await client.execute({
                sql: 'INSERT INTO run_stops (project_id, run_id, order_id, sequence) VALUES (?, ?, ?, ?)',
                args: [projectId, runId, orderId, sequence + 1],
            });
            await record(orderId, 'dispatch', { type: 'assigned', at: atLocal(12, 40), courierUsername: courier });
        }
    }
    onProgress(`${result.runs} runs assigned across ${courierNames.length} couriers`);
    if (stopAfter === 'assigned') return finish(client, projectId, serviceDate, result, startedAt);

    /* ------------------------------------------------------- the courier day */

    /* When a courier collects. The evening courier collects in the evening,
     * after the requests that make up their run have come in. */
    const pickupAt = (orderId: number) => (orderMeta.get(orderId)!.afterHours ? atLocal(21, 0) : atLocal(13, 10));

    for (const [courier, ids] of stopsByCourier) {
        if (ids.length === 0) continue;
        const daytime = ids.filter((id) => !orderMeta.get(id)!.afterHours);
        const evening = ids.filter((id) => orderMeta.get(id)!.afterHours);
        // One signature per counter per batch, as the pickup flow requires.
        for (const batch of [daytime, evening]) {
            if (batch.length === 0) continue;
            const at = pickupAt(batch[0]!);
            const signature = await captureSignature(client, projectId, 'pickup', 'Pharmacy Tech', courier, at);
            for (const orderId of batch) {
                await record(orderId, courier, {
                    type: 'picked_up', at, signedName: 'Pharmacy Tech',
                    signatureKey: signature, lat: 29.5085, lng: -98.5768,
                });
            }
        }
    }
    onProgress('collected at the counters');
    if (stopAfter === 'picked_up') return finish(client, projectId, serviceDate, result, startedAt);

    for (const [courier, ids] of stopsByCourier) {
        for (const [index, orderId] of ids.entries()) {
            const meta = orderMeta.get(orderId)!;
            const order = await fresh(orderId);
            const dueAt = order.due_at ? new Date(order.due_at) : null;

            /* Arrive before the deadline most of the time, after it sometimes:
             * a simulated day where nothing is ever late makes every report
             * look finished and tests none of the overdue paths. */
            const late = rng() < LATE_RATE;
            const base = dueAt ? dueAt.getTime() : (meta.afterHours ? atLocal(22, 0) : atLocal(15, 0)).getTime();
            const arrivedAt = new Date(base + (late ? 1 : -1) * (5 + Math.floor(rng() * 40)) * 60000);
            await record(orderId, courier, {
                type: 'arrived', at: arrivedAt,
                lat: 29.35 + rng() * 0.25, lng: -98.7 + rng() * 0.35,
            });
            if (late) result.onTime.missed += 1; else result.onTime.met += 1;

            const outcomeAt = new Date(arrivedAt.getTime() + (2 + Math.floor(rng() * 8)) * 60000);
            if (rng() < FAILURE_RATE) {
                const reason = pick(rng, DRY_RUN_REASONS);
                await client.execute({
                    sql: 'UPDATE packages SET failure_reason_code = ?, failure_note = ? WHERE id = ?',
                    args: [reason, reason === 'other' ? pick(rng, NOTES) : '', meta.packageId],
                });
                await record(orderId, courier, {
                    type: 'attempted', at: outcomeAt, reason,
                    packageIds: [meta.packageId],
                    lat: 29.35 + rng() * 0.25, lng: -98.7 + rng() * 0.35,
                });
                result.dryRuns += 1;
                continue;
            }

            /* A doorstep drop is only legal when the medication does not need
             * a signature (Scope 1.2.3). Counted rather than recorded: it
             * needs a stored photo, which needs the S3 environment from
             * ticket 0.10, and a doorstep delivery without one would be a
             * proof of delivery with nothing behind it. */
            if (!meta.signatureRequired && rng() < DOORSTEP_RATE) result.doorstepCandidates += 1;

            const signature = await captureSignature(
                client, projectId, 'delivery', String(order.status ? '' : '') || 'Recipient', courier, outcomeAt,
            );
            await record(orderId, courier, {
                type: 'delivered', at: outcomeAt, signedName: 'Recipient',
                signatureKey: signature, lat: 29.35 + rng() * 0.25, lng: -98.7 + rng() * 0.35,
            });
            if (index === ids.length - 1) onProgress(`${courier} finished`);
        }
    }

    /* Failures go back to a pharmacy, because a package nobody took back is
     * still in a van and the platform has to be able to say so. */
    const failed = await client.execute({
        /* Only what this simulation created. A day may also hold demo data or
           a real order somebody failed by hand, and a generator that tidies up
           records it did not make is a generator nobody can trust to be run
           against a database with anything else in it. */
        sql: `SELECT id, assigned_to_username, site_id FROM orders
              WHERE project_id = ? AND service_date = ? AND status = 'failed' AND returned_at IS NULL
                AND external_ref LIKE ?`,
        args: [projectId, serviceDate, `${SIMULATION_PREFIX}-%`],
    });
    const dischargeId = sites.find((s) => s.code === 'discharge')?.id ?? sites[0]!.id;
    for (const row of failed.rows) {
        const courier = String(row['assigned_to_username']);
        const signature = await captureSignature(client, projectId, 'return', 'Night Pharmacist', courier, atLocal(19, 30));
        await record(Number(row['id']), courier, {
            type: 'returned', at: atLocal(19, 30), signedName: 'Night Pharmacist',
            signatureKey: signature, returnedToSiteId: dischargeId,
            lat: 29.5085, lng: -98.5768,
        });
        result.returned += 1;
    }
    onProgress(`${result.returned} undelivered packages taken back`);

    return finish(client, projectId, serviceDate, result, startedAt);
}

async function finish(
    client: Client, projectId: number, serviceDate: string, result: SimulateResult, startedAt: number,
): Promise<SimulateResult> {
    const rs = await client.execute({
        sql: 'SELECT status, COUNT(*) AS n FROM orders WHERE project_id = ? AND service_date = ? GROUP BY status',
        args: [projectId, serviceDate],
    });
    for (const row of rs.rows) result.byStatus[String(row['status'])] = Number(row['n']);
    const measured = result.onTime.met + result.onTime.missed;
    result.onTime.rate = measured === 0 ? null : Math.round((result.onTime.met / measured) * 1000) / 10;
    result.elapsedMs = Date.now() - startedAt;
    return result;
}

async function captureSignature(
    client: Client, projectId: number, kind: string, signedName: string, capturedBy: string, at: Date,
): Promise<string> {
    const strokes = JSON.stringify([[
        { x: 0.08, y: 0.6, t: 0 }, { x: 0.3, y: 0.25, t: 45 }, { x: 0.55, y: 0.7, t: 95 }, { x: 0.82, y: 0.3, t: 150 },
    ]]);
    const rs = await client.execute({
        sql: `INSERT INTO signatures (project_id, kind, signed_name, strokes, captured_by, captured_at, lat, lng)
              VALUES (?, ?, ?, ?, ?, ?, 29.4241, -98.4936) RETURNING id`,
        args: [projectId, kind, signedName, strokes, capturedBy, at.toISOString()],
    });
    return `local:signature:${Number(rs.rows[0]!['id'])}`;
}

/** A plausible sign-in for each simulated courier, so board presence and
 *  position agree with each other. Sessions are keyed by sha256(token) like
 *  real ones; these hold a token nobody has, so none of them can be used. */
async function giveSessions(client: Client, usernames: string[], from: Date, until: Date): Promise<void> {
    const { createHash, randomBytes } = await import('node:crypto');
    for (const username of usernames) {
        const user = await client.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
        if (!user.rows[0]) continue;
        const userId = Number(user.rows[0]['id']);
        await client.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] });
        await client.execute({
            sql: `INSERT INTO sessions (id, user_id, device, ip, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
                  VALUES (?, ?, 'Simulated phone', '', ?, ?, ?, ?)`,
            args: [
                createHash('sha256').update(randomBytes(32)).digest('hex'),
                userId,
                from.toISOString(),
                until.toISOString(),
                new Date(until.getTime() + 12 * 3600_000).toISOString(),
                new Date(until.getTime() + 30 * 24 * 3600_000).toISOString(),
            ],
        });
    }
}

/** Test couriers, created once and reused. Named so nobody mistakes one for a
 *  real employee in a user list. */
async function ensureCouriers(client: Client, projectId: number, count: number): Promise<string[]> {
    const bcrypt = await import('bcryptjs');
    const names: string[] = [];
    for (let i = 1; i <= count; i += 1) {
        const username = `sim.courier${String(i).padStart(2, '0')}`;
        names.push(username);
        const existing = await client.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
        let userId: number;
        if (existing.rows[0]) {
            userId = Number(existing.rows[0]['id']);
        } else {
            const created = await client.execute({
                sql: `INSERT INTO users (username, password, name, role, status) VALUES (?, ?, ?, 'driver', 'active') RETURNING id`,
                args: [username, bcrypt.default.hashSync(`sim-pass-${i}`, 8), `Sim Courier ${i}`],
            });
            userId = Number(created.rows[0]!['id']);
        }
        const member = await client.execute({
            sql: 'SELECT id FROM memberships WHERE user_id = ? AND project_id = ?',
            args: [userId, projectId],
        });
        if (!member.rows[0]) {
            await client.execute({
                sql: `INSERT INTO memberships (user_id, project_id, role, settings, created_at) VALUES (?, ?, 'courier', '{}', ?)`,
                args: [userId, projectId, new Date().toISOString()],
            });
        }
    }
    return names;
}

/**
 * Remove everything a simulation created for a day.
 *
 * Simulated rows are the only ones whose external reference starts with the
 * prefix, so this cannot reach a real order.
 *
 * It has to drop the append-only trigger on custody_events to delete their
 * events, which is why it demands `confirmLocalDatabase`. A caller must have
 * established that this is a developer's file database: a process killed
 * between the drop and the recreate leaves an evidence table unprotected, and
 * that is not a risk worth taking against anything real. The trigger is put
 * back in a finally block and its presence is checked afterwards, loudly.
 */
export async function clearSimulation(
    client: Client, projectId: number, serviceDate: string, options: { confirmLocalDatabase: boolean },
): Promise<number> {
    if (!options.confirmLocalDatabase) {
        throw new Error('clearSimulation needs confirmLocalDatabase: it drops the custody_events trigger while it works');
    }
    const rs = await client.execute({
        sql: `SELECT id FROM orders WHERE project_id = ? AND service_date = ? AND external_ref LIKE ?`,
        args: [projectId, serviceDate, `${SIMULATION_PREFIX}-%`],
    });
    const ids = rs.rows.map((r) => Number(r['id']));
    if (ids.length === 0) return 0;
    const list = ids.map(() => '?').join(',');
    /* custody_events is append-only by trigger, so deleting simulated orders
     * means dropping their events too, which the trigger forbids. The trigger
     * is dropped and recreated around the delete, deliberately and visibly,
     * rather than being quietly relaxed for everybody. */
    await client.execute('DROP TRIGGER IF EXISTS custody_events_no_delete');
    try {
        await client.execute({ sql: `DELETE FROM custody_events WHERE order_id IN (${list})`, args: ids });
        await client.execute({ sql: `DELETE FROM run_stops WHERE order_id IN (${list})`, args: ids });
        await client.execute({ sql: `DELETE FROM packages WHERE order_id IN (${list})`, args: ids });
        await client.execute({ sql: `DELETE FROM orders WHERE id IN (${list})`, args: ids });
        await client.execute({
            sql: `DELETE FROM runs WHERE project_id = ? AND service_date = ? AND id NOT IN (SELECT run_id FROM run_stops)`,
            args: [projectId, serviceDate],
        });
    } finally {
        await client.execute(`CREATE TRIGGER IF NOT EXISTS custody_events_no_delete
            BEFORE DELETE ON custody_events
            BEGIN SELECT RAISE(ABORT, 'custody_events is append-only'); END`);
    }
    /* Check rather than assume. If this ever fails, the append-only guarantee
       is gone and somebody has to know immediately. */
    const trigger = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custody_events_no_delete'",
    );
    if (trigger.rows.length === 0) {
        throw new Error('custody_events is no longer append-only: the delete trigger was not restored');
    }
    return ids.length;
}
