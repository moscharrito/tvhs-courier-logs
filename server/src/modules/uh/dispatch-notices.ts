/* Telling dispatch what just happened on the ground.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES.
 *
 * Nine pharmacies hand over a spreadsheet every morning. Nothing told
 * anybody. A counter uploaded their list to the drop box, the drop box
 * recorded it, and dispatch found out by going and looking -- so a list that
 * landed at 11:40 and a list that landed at 13:55 looked identical until
 * somebody refreshed a page, and the entire day's work waits behind that.
 * That was the actual ask: "notify us when UH Pharmacy uploads their daily
 * list".
 *
 * The other two -- a courier arriving, a courier finishing -- were asked for
 * in the same breath and are a different kind of thing. The board has shown
 * both in a live feed since it was built, and they happen five hundred to
 * fifteen hundred times a day. They are here, they work, and they are off
 * until a person switches them on, with the switch saying what it costs.
 * See core/notify/prefs.ts for that arithmetic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT MAY BE IN THE BODY.
 *
 * A notification is read on a lock screen, which is the one place our
 * software is seen by whoever is HOLDING the phone rather than by whoever
 * owns it. So: a counter's name, a delivery's number, a courier's name, a
 * clock time. Never a patient, never an address, never a telephone number.
 *
 * AND NEVER THE UPLOADED FILENAME, which is the non-obvious one. The audit
 * trail records it, deliberately, because an operator reconciling a drop
 * needs to know which file. But the nine counters name their own files and
 * some of them name them after people -- a "Rodriguez list.xlsx" on a lock
 * screen is a patient name we published, and we cannot police somebody
 * else's filenames. The counter and the date identify the drop as well for
 * the person being told, who is about to open the drop box anyway.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTHING HERE THROWS INTO ITS CALLER. A list that was handed over was
 * handed over; a delivery that happened happened. Telling somebody is a
 * courtesy on top, and a courtesy must not be able to fail the operational
 * act it describes. Same rule, and the same reason, as
 * modules/uh/delivery-notices.ts and core/notify/outbox.ts.
 */

import type { Client } from '@libsql/client';
import { notifyAll, dispatchersForSite } from '../../core/notify/outbox';
import { optedInTo, wantingKind } from '../../core/notify/prefs';
import { namesFor, displayName } from './people';

/** A daily list a pharmacy has just handed over. */
export interface ListDropNotice {
    projectId: number;
    /** The drop's row id, so the bell can link at it. */
    dropId: number;
    siteId: number;
    /** The counter's name. A business name, not patient data. */
    siteName: string;
    /** The day the list is FOR, which is not always today: a counter sending
     *  tomorrow's list at four o'clock is a different thing to react to. */
    serviceDate: string;
    /** Who uploaded it, as the username on the account. May be a member of
     *  our own staff keying in a list that arrived by email. */
    uploadedBy: string;
}

/** The sentence a dispatcher reads. Exported so a test can assert the whole
 *  string rather than a substring -- "carries no patient data" is not a
 *  property you can check by looking for one. */
export function listDropBody(n: ListDropNotice): string {
    return `${n.siteName} handed over a daily list for ${n.serviceDate}.`
        + ' It is in the drop box and no deliveries exist yet.';
}

/**
 * Tell the dispatchers who cover this counter. Never throws.
 *
 * Returns how many rows were written, which a caller may mention and nothing
 * is expected to act on.
 */
export async function notifyDispatchOfListDrop(client: Client, n: ListDropNotice): Promise<number> {
    try {
        const covering = await dispatchersForSite(client, n.projectId, n.siteId);
        /* NOT THE PERSON WHO JUST DID IT. A lead keying in a list that came
           by email does not need to be told that a list came in: they are
           looking at it. Same reasoning as the board's feed leaving out
           `created` and `assigned` -- echoing somebody's own action back at
           them buries the ones they could not see. */
        const others = covering.filter((u) => u !== n.uploadedBy);
        const wants = await wantingKind(client, n.projectId, others, 'list.dropped');
        return await notifyAll(client, wants, {
            projectId: n.projectId,
            kind: 'list.dropped',
            body: listDropBody(n),
            /* A drop is not an order, and order_id is a foreign key to one.
               The bell links at the drop box by kind instead. */
            orderId: null,
        });
    } catch {
        return 0;
    }
}

/* ------------------------------------------------------- arrivals, endings */

/** The counter the delivery belongs to and who is carrying it. */
export interface StopWhere {
    siteId: number;
    siteName: string;
    /** The courier, by username, or null on an order nobody holds. */
    courierUsername: string | null;
}

export interface StopNotice {
    projectId: number;
    orderId: number;
    /** 'arrived' or 'delivered'. Anything else is not one of these and is
     *  ignored, the same way delivery-notices.ts ignores a non-outcome. */
    what: 'arrived' | 'delivered';
    /** Already rendered in the project's timezone by the caller, which is
     *  the only place that knows what it is. */
    at: string;
    /**
     * Which counter, and which courier -- FETCHED ONLY IF SOMEBODY IS GOING
     * TO BE TOLD.
     *
     * A function and not two fields, and that is the whole performance story
     * of this file. recordOrderEvent does not carry a site id or a courier
     * on the row it already has, so answering those is a query -- and this
     * runs on the request a courier is waiting on at a doorstep, up to
     * fifteen hundred times a day, when until somebody opens the settings
     * screen the answer is always "tell nobody". Passing the values would
     * mean paying for them every time to discover they were not needed.
     *
     * Called at most once.
     */
    where: () => Promise<StopWhere | null>;
}

export function stopBody(
    n: Pick<StopNotice, 'what' | 'orderId' | 'at'>,
    siteName: string,
    courier: string,
): string {
    /* "A driver" rather than a username. An order can be arrived at by
       somebody whose account has no name on it yet, and "bg.courier arrived"
       is worse than saying less: see lib/people.ts on why a username is an
       email address and never shown as a name. */
    const who = courier === '' ? 'A driver' : courier;
    return n.what === 'arrived'
        ? `${who} arrived at the stop for delivery ${n.orderId} (${siteName}) at ${n.at}.`
        : `${who} completed delivery ${n.orderId} (${siteName}) at ${n.at}.`;
}

/**
 * Tell whoever asked to hear about every arrival or every completion.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS RUNS INSIDE THE REQUEST A COURIER IS WAITING ON, at a doorstep, on
 * whatever signal there is, with Turso behind Cloudflare at the far end. So
 * the cheap question comes first and the expensive ones do not run at all
 * until the answer makes them necessary:
 *
 *   1. has anybody opted in to this kind?   one indexed read, usually []
 *   2. of those, who covers this counter?   only if (1) found somebody
 *   3. what is the courier called?          only if (2) found somebody
 *
 * Until somebody opens the settings screen, every delivery on this contract
 * costs exactly one read of a table with nothing in it, and that is the
 * state this ships in. Written this way round deliberately: the obvious
 * order -- find the dispatchers, then ask what they want -- costs two reads
 * and a parse of every membership to discover that the answer was nobody.
 */
export async function notifyDispatchOfStop(client: Client, n: StopNotice): Promise<number> {
    if (n.what !== 'arrived' && n.what !== 'delivered') return 0;
    try {
        const kind = n.what === 'arrived' ? 'stop.arrived' : 'stop.delivered';
        const subscribers = await optedInTo(client, n.projectId, kind);
        if (subscribers.length === 0) return 0;

        const where = await n.where();
        if (where === null) return 0;

        const covering = new Set(await dispatchersForSite(client, n.projectId, where.siteId));
        const recipients = subscribers.filter((u) => covering.has(u) && u !== where.courierUsername);
        if (recipients.length === 0) return 0;

        const names = where.courierUsername === null
            ? new Map()
            : await namesFor(client, [where.courierUsername]);
        const courier = displayName(where.courierUsername, names) ?? '';

        return await notifyAll(client, recipients, {
            projectId: n.projectId,
            kind,
            body: stopBody(n, where.siteName, courier),
            orderId: n.orderId,
        });
    } catch {
        /* A delivery that happened is not undone by a notice that was not
           written. */
        return 0;
    }
}
