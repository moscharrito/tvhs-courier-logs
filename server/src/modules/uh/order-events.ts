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
}

/** Insert one custody row. Never updates: the table forbids it. */
export async function insertCustodyEvent(client: Client, e: {
    projectId: number;
    orderId: number;
    type: CustodyEventType;
    at: Date;
    actor: string;
    fromStatus: string;
    toStatus: string;
    signedName?: string | undefined;
    signatureKey?: string | undefined;
    reason?: string | undefined;
    lat?: number | undefined;
    lng?: number | undefined;
    packageId?: number | undefined;
}): Promise<void> {
    await client.execute({
        sql: `INSERT INTO custody_events
                (project_id, order_id, package_id, type, at, actor, from_status, to_status,
                 signed_name, signature_key, reason, lat, lng)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            e.projectId, e.orderId, e.packageId ?? null, e.type, e.at.toISOString(), e.actor,
            e.fromStatus, e.toStatus, e.signedName ?? '', e.signatureKey ?? '', e.reason ?? '',
            e.lat ?? null, e.lng ?? null,
        ],
    });
}

/**
 * Apply an event to an order and write it down.
 *
 * Throws TransitionError when the transition table refuses; the caller turns
 * that into a 409. Everything it writes is derived from `applyEvent`, so the
 * stored status and the custody row can never disagree about what happened.
 */
export async function recordOrderEvent(client: Client, opts: RecordOptions): Promise<Applied> {
    const { projectId, order, actor, settings, event } = opts;
    const orderId = Number(order.id);

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
            sql: `UPDATE orders SET ${sets.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
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
        reason: event.reason, lat: event.lat, lng: event.lng,
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

    return applied;
}
