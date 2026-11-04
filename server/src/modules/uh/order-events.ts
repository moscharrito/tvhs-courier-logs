/* Recording what happened to an order.
 *
 * One function writes every custody row and every status change in the
 * system: the orders endpoint, the runs endpoint that assigns work, the
 * import that creates orders, and the courier app to come. Ticket 1.6
 * established that a status only ever moves through the transition table;
 * this is the single place that actually performs the move, so that rule
 * cannot be quietly bypassed by a second caller writing its own UPDATE.
 *
 * It deliberately does no authorisation. Which roles may record which event
 * is a question about the request, and belongs in the router; whether the
 * order may move at all is a question about the order, and belongs here.
 */

import type { Client, InValue } from '@libsql/client';
import { notifyPharmacyOfOutcome } from './delivery-notices';
import { queueStageNotice } from './patient-sms';
import { EVENT_STAGES, type Stage } from '../../core/notify/sms-template';
import type { ProjectSettings } from '../../core/projects/settings';
import {
    applyEvent, type Applied, type CustodyEventType, type EventInput, type OrderStatus,
} from './lifecycle';
import type { ServiceType } from './import-parse';

/** The columns of `orders` this needs. A row read with SELECT * satisfies it. */
export interface OrderStateRow {
    id: number | bigint;
    status: string;
    service_type: string;
    received_at: string;
    pickup_at: string | null;
    arrived_at: string | null;
    due_at: string | null;
}

export interface RecordOptions {
    projectId: number;
    order: OrderStateRow;
    actor: string;
    settings: ProjectSettings;
    event: EventInput;
    /** The project's timezone, for the time in a notification a pharmacist
     *  reads. Optional so existing callers and tests keep working; without it
     *  the notice is written in UTC rather than not written at all. */
    timezone?: string;
}

/** Insert one custody row. Never updates: the table forbids it. */
export interface CustodyEventInput {
    projectId: number;
    orderId: number;
    type: CustodyEventType;
    at: Date;
    actor: string;
    fromStatus: string;
    toStatus: string;
    signedName?: string | undefined;
    signatureKey?: string | undefined;
    /* The second party on a controlled-substance handover (ticket 7.13).
     * signedName above is whoever RECEIVED custody; this is whoever gave it
     * up, which is the courier at both ends. Empty on every other handover,
     * and empty on every row written before the column existed. */
    countersignedName?: string | undefined;
    countersignatureKey?: string | undefined;
    reason?: string | undefined;
    lat?: number | undefined;
    lng?: number | undefined;
    packageId?: number | undefined;
    fileId?: number | undefined;
    /** What a courier tried before giving up, for a dry run that will be
     *  billed. Addendum 2 clause 5. Empty where the app did not ask. */
    contactEfforts?: readonly string[] | undefined;
    /** Minutes at the door. -1 for not recorded, which is not the same fact
     *  as zero. */
    waitedMinutes?: number | undefined;
}

/**
 * The statement, without running it.
 *
 * Split out so the bulk import can put three hundred of these in one batch
 * (ticket 4.9) while every other caller still writes one at a time. The
 * column list exists once: two copies of it would disagree the first time a
 * column is added, and the one that disagreed would be the bulk path, where
 * nobody is watching.
 */
export function custodyEventStatement(e: CustodyEventInput): { sql: string; args: InValue[] } {
    return {
        sql: `INSERT INTO custody_events
                (project_id, order_id, package_id, type, at, actor, from_status, to_status,
                 signed_name, signature_key, countersigned_name, countersignature_key,
                 reason, lat, lng, file_id, contact_efforts, waited_minutes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            e.projectId, e.orderId, e.packageId ?? null, e.type, e.at.toISOString(), e.actor,
            e.fromStatus, e.toStatus, e.signedName ?? '', e.signatureKey ?? '',
            e.countersignedName ?? '', e.countersignatureKey ?? '', e.reason ?? '',
            e.lat ?? null, e.lng ?? null, e.fileId ?? null,
            (e.contactEfforts ?? []).join(','), e.waitedMinutes ?? -1,
        ],
    };
}

export async function insertCustodyEvent(client: Client, e: CustodyEventInput): Promise<void> {
    await client.execute(custodyEventStatement(e));
}

/**
 * Apply an event to an order and write it down.
 *
 * Throws TransitionError when the transition table refuses; the caller turns
 * that into a 409. Everything it writes is derived from `applyEvent`, so the
 * stored status and the custody row can never disagree about what happened.
 */
/**
 * The reason on an automatic pickup, and the way to recognise one.
 *
 * Read back out of custody_events months later, "picked_up" with no name
 * against it is a question. This is the answer, in the row itself.
 */
/* "this contract does not collect a signature at the counter" said the
 * right thing in the wrong voice: it described a clause rather than the
 * handover, and read as though something had been skipped. The fact it
 * carries is unchanged -- the package was received, and no signature was
 * taken for it -- said plainly.
 *
 * ONLY NEW EVENTS GET THIS. The string is written into custody_events.reason
 * at pickup time, and that table is append-only by trigger, so every pickup
 * recorded before this change keeps the old sentence. That is correct: the
 * record says what was written when it happened. Anybody reading a custody
 * chain across the change will see both, which is why both say the same
 * thing in the same order. */
export const CUSTODY_ON_ASSIGNMENT = 'Recorded automatically: package received at the pharmacy, no signature taken at the counter.';

/**
 * Who handed the packages over, on an automatic pickup.
 *
 * A ROLE, NOT A PERSON, and the distinction is the whole of why this is
 * allowed to be here. The pharmacy did hand the delivery over -- that part
 * is true and is what the custody chain is asserting. What this contract
 * stopped capturing on 3 November is WHICH member of staff, so naming one
 * would be the only invented line in a document University Health reads as
 * evidence. "Site staff" says exactly as much as we know.
 *
 * It reads through to the proof of delivery, where the custody table prints
 * it as "from site staff" rather than "signed ...": no signature was taken
 * and the document must not imply one.
 */
export const CUSTODY_FROM = 'Site staff';

/* The courier actions that can only happen to something already in the van.
   Each is `from: ['picked_up']` in the transition table. */
const NEEDS_CUSTODY = new Set(['arrived', 'delivered', 'attempted']);

export async function recordOrderEvent(client: Client, opts: RecordOptions): Promise<Applied> {
    const { projectId, order, actor, settings, event } = opts;
    const orderId = Number(order.id);

    /* ─────────────── CUSTODY IS RECORDED WHEN IT IS NEEDED, NOT BY A DRIVER
     *
     * Drivers stopped recording collections on 3 November: they open a stop,
     * hand over, photograph the signed form. Nothing else.
     *
     * The state machine would not allow that -- `delivered` is reachable
     * only `from: ['picked_up']` -- so an order nobody picked up could never
     * be delivered. Rather than let `delivered` start from `assigned`,
     * which shortens the custody chain in every document and report that
     * reads it, the chain is kept whole and the server writes the missing
     * link the moment a courier does something that presupposes it.
     *
     * AT THIS MOMENT, NOT AT ASSIGNMENT, and the difference is not stylistic.
     * Writing it when dispatch assigns moved every order straight to
     * picked_up, which took two things away: `unassigned` is
     * `from: ['assigned']`, so dispatch could no longer undo a
     * mis-assignment -- the thing they now do by hand all day -- and
     * carrying() counts picked_up, so every assigned delivery would have
     * blocked its driver from going off shift. The suite caught both.
     *
     * HERE RATHER THAN AT THE CALL SITES, because the stop screen, the
     * offline queue and the generic event endpoint all reach this, and a
     * copy in each is three places for one to be forgotten.
     *
     * It cannot recurse: the event it records is `picked_up`, which is not
     * in NEEDS_CUSTODY.
     *
     * NOT A SIGNATURE. picked_up_by says "Site staff" -- a role, which is
     * true, rather than a person, which would be invented -- and the reason
     * says it was recorded automatically. The proof of delivery prints it as
     * "from site staff" and never as "signed", because nobody signed. */
    if (NEEDS_CUSTODY.has(event.type) && String(order.status) === 'assigned') {
        await recordOrderEvent(client, {
            ...opts,
            event: { type: 'picked_up', at: event.at, signedName: CUSTODY_FROM, reason: CUSTODY_ON_ASSIGNMENT },
        });
        /* Re-read: the status this event is about to be applied against has
           just moved, and applyEvent refuses a transition from the old one. */
        const fresh = await client.execute({
            sql: 'SELECT * FROM orders WHERE project_id = ? AND id = ?',
            args: [projectId, orderId],
        });
        if (fresh.rows[0]) {
            return recordOrderEvent(client, {
                ...opts,
                order: Object.fromEntries(Object.entries(fresh.rows[0])) as unknown as OrderStateRow,
            });
        }
    }

    const applied = applyEvent(
        {
            status: order.status as OrderStatus,
            serviceType: order.service_type as ServiceType,
            receivedAt: new Date(order.received_at),
            pickupAt: order.pickup_at ? new Date(order.pickup_at) : null,
            arrivedAt: order.arrived_at ? new Date(order.arrived_at) : null,
            dueAt: order.due_at ? new Date(order.due_at) : null,
        },
        event,
        settings,
    );

    const sets = Object.keys(applied.set);
    if (sets.length > 0) {
        await client.execute({
            /* updated_at is NOT set here. A trigger owns it (migration
               0047), because three other writers to this table used to
               forget and the board now depends on the column being right.
               Setting it by hand would also defeat the trigger's guard and
               put CURRENT_TIMESTAMP's unsortable format back in the row. */
            sql: `UPDATE orders SET ${sets.map((c) => `${c} = ?`).join(', ')}
                  WHERE project_id = ? AND id = ?`,
            args: [...sets.map((c) => applied.set[c] as InValue), projectId, orderId],
        });
    }

    const packageIds = event.packageIds ?? [];

    if (applied.packageOutcome) {
        if (packageIds.length > 0) {
            await client.execute({
                sql: `UPDATE packages SET outcome = ? WHERE project_id = ? AND order_id = ? AND id IN (${packageIds.map(() => '?').join(',')})`,
                args: [applied.packageOutcome, projectId, orderId, ...packageIds],
            });
        } else {
            await client.execute({
                sql: 'UPDATE packages SET outcome = ? WHERE project_id = ? AND order_id = ?',
                args: [applied.packageOutcome, projectId, orderId],
            });
        }
    }

    const common = {
        projectId, orderId, type: event.type, at: event.at, actor,
        fromStatus: order.status, toStatus: applied.toStatus,
        signedName: event.signedName, signatureKey: event.signatureKey,
        countersignedName: event.countersignedName, countersignatureKey: event.countersignatureKey,
        reason: event.reason, lat: event.lat, lng: event.lng, fileId: event.fileId,
        contactEfforts: event.contactEfforts, waitedMinutes: event.waitedMinutes,
    };

    if (packageIds.length > 0) {
        // One row per package, so a part-delivered order's record says which
        // packages the signature actually covered.
        for (const packageId of packageIds) {
            await insertCustodyEvent(client, { ...common, packageId });
        }
    } else {
        await insertCustodyEvent(client, common);
    }

    /* Tell the pharmacy, after the custody record exists and never before it.
     *
     * Here rather than in the four routes that can close a delivery, because
     * a fifth route added later would silently not notify anybody and nobody
     * would notice until a hospital asked why they stopped getting emails.
     *
     * Only on a real transition: a courier tapping "delivered" twice is one
     * delivery, and statusChanged is already false the second time. */
    if (applied.statusChanged && (applied.toStatus === 'delivered' || applied.toStatus === 'failed')) {
        await notifyOutcome(client, {
            projectId,
            orderId,
            status: applied.toStatus,
            at: event.at,
            timezone: opts.timezone ?? 'UTC',
        });
    }

    /* And tell the patient, if this is a stage they have been switched on for.
     *
     * Same place and the same reasoning as the pharmacy notice above: every
     * status change in the system passes through here, so a stage cannot be
     * added later and quietly notify nobody.
     *
     * NOT gated on statusChanged. `arrived` does not move the status and is
     * still the moment somebody wants to be told; the unique index on
     * (order_id, kind) is what stops a courier tapping twice sending twice,
     * which is a guarantee rather than a hope about the caller. */
    if ((EVENT_STAGES as readonly string[]).includes(event.type)) {
        await queueStageNotice(client, {
            projectId,
            orderId,
            stage: event.type as Stage,
            settings,
            timezone: opts.timezone ?? 'UTC',
            now: event.at,
        });
    }

    return applied;
}

/** Look up the pharmacy's name and hand off. Never throws: see
 *  modules/uh/delivery-notices.ts. */
async function notifyOutcome(
    client: Client,
    n: { projectId: number; orderId: number; status: string; at: Date; timezone: string },
): Promise<void> {
    try {
        /* The site is read back rather than taken off the row: OrderStateRow
           carries only what the transition rules need, and widening it so one
           notification can find a pharmacy would put a column on every caller
           for the benefit of this one. */
        const rs = await client.execute({
            sql: `SELECT s.id AS site_id, s.name AS site_name FROM orders o
                  JOIN sites s ON s.id = o.site_id
                  WHERE o.project_id = ? AND o.id = ?`,
            args: [n.projectId, n.orderId],
        });
        const row = rs.rows[0];
        if (!row) return;
        const at = new Intl.DateTimeFormat('en-US', {
            timeZone: n.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        }).format(n.at);
        await notifyPharmacyOfOutcome(client, {
            projectId: n.projectId, orderId: n.orderId, siteId: Number(row['site_id']),
            siteName: String(row['site_name']), status: n.status, at,
        });
    } catch {
        /* A delivery that happened is not undone by a notice that was not
           written. */
    }
}
