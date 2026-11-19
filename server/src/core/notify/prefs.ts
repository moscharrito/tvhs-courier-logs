/* Who wants to hear about what.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A NOTIFICATION SYSTEM NEEDS THIS ON DAY ONE.
 *
 * Twelve kinds of notification were written to the database for weeks and no
 * screen in either app rendered one of them, so nobody had ever had the
 * experience of being told too much. The moment a bell existed, two of the
 * things it was asked to announce turned out to be the two highest-volume
 * facts in the system:
 *
 *   A courier arriving at a stop, and a courier finishing a delivery.
 *   University Health run between five hundred and fifteen hundred
 *   deliveries a day (see modules/uh/board.ts). There are four dispatch
 *   chairs. Announcing both, to all four, is up to twelve thousand rows a
 *   day, on a database billed by the row, ending in an unread count nobody
 *   can act on and a bell everybody learns to ignore.
 *
 * A notification somebody has learned to ignore is worse than no
 * notification, because the one that mattered is now inside it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE: FILTER BEFORE THE WRITE, NOT AFTER IT.
 *
 * The cheap way to build preferences is to write every row and hide the ones
 * a reader does not want. That costs the same twelve thousand rows, keeps
 * paying for them for the retention period, and quietly means that turning a
 * kind on shows you everything that happened while it was off.
 *
 * So the fan-out asks this module who wants a kind BEFORE it writes
 * anything, and a kind nobody wants writes nothing at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A MISSING ROW IS A DEFAULT, NOT AN "OFF".
 *
 * Nobody has a row until they change something, which is what lets a kind
 * added next month reach the people who signed up this month. The defaults
 * are below, each with the reason it is what it is, because a default is a
 * decision about somebody's attention and those are worth writing down.
 *
 * NEVER THROWS. Same rule as core/notify/outbox.ts: this sits in front of a
 * courtesy, and a courtesy must not be able to fail the operational act it
 * describes. A read that fails falls back to the defaults, which means a
 * database wobble makes somebody hear slightly more than they asked for
 * rather than nothing at all. That is the right way round -- the failure
 * mode of a notification system should be noise, never silence.
 */

import type { Client } from '@libsql/client';
import { NOTIFICATION_KINDS, type NotificationKind } from '../../db/schema/core';

/** Whether this kind reaches somebody who has never opened the settings. */
export const DEFAULT_ENABLED: Record<NotificationKind, boolean> = {
    /* Addressed to one person about their own request or their own work.
       Rare, specific, and the person is the only one who can act on it. */
    'request.approved': true,
    'request.denied': true,
    'request.superseded': true,
    'work.assigned': true,
    /* Dispatch kinds. Each one is an exception -- a thing that has gone
       wrong, or is about to -- and there are a handful a day at most. These
       are what the bell is for. */
    'work.unclaimed': true,
    'shift.missed': true,
    'dispatch.notStarted': true,
    'shift.carryingOvernight': true,
    'mail.failing': true,
    /* The pharmacy's own deliveries, to the pharmacy. One per delivery, but
       a counter sees only its own counter's work, and this is the thing they
       signed up for: it is the answer to "did it get there". */
    'delivery.completed': true,
    'delivery.failed': true,
    'thread.mention': true,
    /* Nine a morning, and the entire day's work waits behind them. The
       clearest win in the whole feature. */
    'list.dropped': true,
    /* ─────────── THE TWO THAT ARE OFF, AND WHY
     *
     * Five hundred to fifteen hundred a day, each. The board has shown both
     * in a live feed since it was built, fifteen-second poll, no rows
     * written, and the bell's Activity tab now shows the same feed from
     * anywhere in the app -- so somebody who wants to watch arrivals and
     * completions can, continuously, without a single notification row
     * existing.
     *
     * What the bell adds over that is an unread count and a thing to clear,
     * and neither is useful at that volume: nobody clears nine hundred rows,
     * and a count of nine hundred is the same information as no count.
     *
     * They are real kinds, they work, and they are one switch away for
     * anybody who wants them -- a lead away from a desk who wants a buzz per
     * delivery is entitled to one. The switch says what it costs. */
    'stop.arrived': false,
    'stop.delivered': false,
};

/** What a kind is called on the settings screen, and what it costs to want it.
 *
 *  Here rather than in the web app because the defaults and the reasons are
 *  here, and a label that disagrees with the behaviour is how somebody ends
 *  up switching on the wrong thing. The screen renders what the server says. */
export interface KindInfo {
    kind: NotificationKind;
    label: string;
    /** One line, plain, in the second person. */
    about: string;
    /** Roughly how often, so a choice is an informed one. */
    volume: 'rare' | 'daily' | 'constant';
    /** False for a kind this role could never be sent, so the screen does not
     *  offer somebody a switch that can do nothing. */
    enabledByDefault: boolean;
}

/* Which roles can ever receive each kind. A pharmacist offered a switch for
 * "a courier never came on shift" would reasonably conclude they were going
 * to be told about it, and they are not: see the fan-out at each call site. */
const AUDIENCE: Record<NotificationKind, readonly string[]> = {
    'request.approved': ['courier'],
    'request.denied': ['courier'],
    'request.superseded': ['courier'],
    'work.assigned': ['courier'],
    'work.unclaimed': ['admin', 'lead'],
    'shift.missed': ['admin', 'lead'],
    'dispatch.notStarted': ['admin', 'lead'],
    'shift.carryingOvernight': ['admin', 'lead'],
    'mail.failing': ['admin', 'lead'],
    'delivery.completed': ['pharmacy'],
    'delivery.failed': ['pharmacy'],
    'thread.mention': ['admin', 'lead', 'courier', 'pharmacy'],
    'list.dropped': ['admin', 'lead'],
    'stop.arrived': ['admin', 'lead'],
    'stop.delivered': ['admin', 'lead'],
};

const CATALOGUE: Record<NotificationKind, { label: string; about: string; volume: KindInfo['volume'] }> = {
    'request.approved': { label: 'A request you made was approved', about: 'You asked for a delivery and dispatch gave it to you.', volume: 'rare' },
    'request.denied': { label: 'A request you made was declined', about: 'You asked for a delivery and somebody else has it.', volume: 'rare' },
    'request.superseded': { label: 'A request you made no longer applies', about: 'The delivery you asked for was assigned or cancelled before anybody answered you.', volume: 'rare' },
    'work.assigned': { label: 'Work was assigned to you', about: 'A delivery was put on your run.', volume: 'daily' },
    'work.unclaimed': { label: 'A STAT nobody has claimed', about: 'An urgent delivery has been sitting in the pool.', volume: 'rare' },
    'shift.missed': { label: 'A driver with work has not come on shift', about: 'Somebody has a run today and had not checked in by the check-in time.', volume: 'rare' },
    'dispatch.notStarted': { label: 'A day that has not started', about: 'No lists arrived, or they arrived and nobody built a run from them.', volume: 'rare' },
    'shift.carryingOvernight': { label: 'A shift left open with packages in the van', about: 'Somebody went home still carrying medication.', volume: 'rare' },
    'mail.failing': { label: 'Email has stopped', about: 'Nothing we send is being accepted. Written here because it cannot be emailed.', volume: 'rare' },
    'delivery.completed': { label: 'A delivery of yours was completed', about: 'One of your counter’s deliveries got there.', volume: 'daily' },
    'delivery.failed': { label: 'A delivery of yours could not be completed', about: 'One of your counter’s deliveries was attempted and came back.', volume: 'daily' },
    'thread.mention': { label: 'Somebody tagged you', about: 'Your name came up on a delivery’s thread.', volume: 'rare' },
    'list.dropped': { label: 'A pharmacy handed over a daily list', about: 'A counter uploaded their spreadsheet to the drop box and it is waiting to be imported.', volume: 'daily' },
    'stop.arrived': { label: 'A driver arrived at a stop', about: 'Every arrival, as it happens. Between 500 and 1,500 a day — the board’s Activity feed shows the same thing without filling the bell.', volume: 'constant' },
    'stop.delivered': { label: 'A driver completed a delivery', about: 'Every completed delivery, as it happens. Between 500 and 1,500 a day — the board’s Activity feed shows the same thing without filling the bell.', volume: 'constant' },
};

/** The switches to offer somebody with this role, in the order they read. */
export function catalogueFor(role: string): KindInfo[] {
    return NOTIFICATION_KINDS
        .filter((kind) => AUDIENCE[kind].includes(role))
        .map((kind) => ({
            kind,
            label: CATALOGUE[kind].label,
            about: CATALOGUE[kind].about,
            volume: CATALOGUE[kind].volume,
            enabledByDefault: DEFAULT_ENABLED[kind],
        }));
}

/** Every override one person has, as kind → enabled. Never throws. */
export async function overridesFor(client: Client, projectId: number, username: string): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    try {
        const rs = await client.execute({
            sql: 'SELECT kind, enabled FROM notification_prefs WHERE project_id = ? AND username = ?',
            args: [projectId, username],
        });
        for (const row of rs.rows) out.set(String(row['kind']), Number(row['enabled']) !== 0);
    } catch {
        /* See the header: the fallback is the defaults, which errs towards
           noise rather than silence. */
    }
    return out;
}

/** Whether one person wants one kind. Never throws. */
export async function wants(client: Client, projectId: number, username: string, kind: NotificationKind): Promise<boolean> {
    const overrides = await overridesFor(client, projectId, username);
    return overrides.get(kind) ?? DEFAULT_ENABLED[kind];
}

/**
 * Narrow a fan-out list to the people who want this kind. Never throws.
 *
 * ONE QUERY FOR THE WHOLE LIST, not one per person: this is called on the
 * path of a courier tapping "delivered" on a phone, and four round trips to
 * Turso behind Cloudflare to decide whether to write a courtesy is four round
 * trips on the wrong side of the thing the courier is waiting for.
 */
export async function wantingKind(
    client: Client,
    projectId: number,
    usernames: readonly string[],
    kind: NotificationKind,
): Promise<string[]> {
    if (usernames.length === 0) return [];
    const fallback = DEFAULT_ENABLED[kind];
    try {
        const rs = await client.execute({
            sql: `SELECT username, enabled FROM notification_prefs
                   WHERE project_id = ? AND kind = ?
                     AND username IN (${usernames.map(() => '?').join(',')})`,
            args: [projectId, kind, ...usernames],
        });
        const said = new Map<string, boolean>();
        for (const row of rs.rows) said.set(String(row['username']), Number(row['enabled']) !== 0);
        return usernames.filter((u) => said.get(u) ?? fallback);
    } catch {
        /* Noise, not silence. */
        return fallback ? [...usernames] : [];
    }
}

/**
 * Everybody who has explicitly ASKED for a kind that is off by default.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE QUERY ON THE COURIER'S HOT PATH.
 *
 * `stop.arrived` and `stop.delivered` are written from inside
 * recordOrderEvent -- the request a courier is waiting on at a doorstep,
 * often on one bar of signal, with Turso behind Cloudflare at the far end.
 * Everything in that request is on the courier's clock.
 *
 * Working out who to tell the long way round costs two reads before
 * discovering that the answer is nobody, which is the answer on every
 * delivery until somebody opens the settings screen. So the order is
 * inverted: ask the cheap question first, and when nobody has opted in,
 * stop. One indexed read against a table with tens of rows in it
 * (notification_prefs_kind_idx exists for exactly this), and no scope
 * lookup, no name lookup and no writes.
 *
 * ONLY SOUND FOR A KIND THAT IS OFF BY DEFAULT, and it asserts that rather
 * than trusting the caller: for a default-ON kind the people who want it are
 * the ones with no row at all, and this would return almost nobody.
 */
export async function optedInTo(client: Client, projectId: number, kind: NotificationKind): Promise<string[]> {
    if (DEFAULT_ENABLED[kind]) {
        throw new Error(`optedInTo is for kinds that are off by default; ${kind} is on. Use wantingKind.`);
    }
    try {
        const rs = await client.execute({
            sql: `SELECT username FROM notification_prefs
                   WHERE project_id = ? AND kind = ? AND enabled = 1 ORDER BY username`,
            args: [projectId, kind],
        });
        return rs.rows.map((r) => String(r['username']));
    } catch {
        /* The one place the header's "noise, not silence" rule points the
           other way. There is nothing to fall back to: the default is off,
           so [] IS the default, and inventing recipients from a failed read
           would notify people who never asked. */
        return [];
    }
}

/** Record somebody's choice. Returns false if it could not be written. */
export async function setPref(
    client: Client,
    projectId: number,
    username: string,
    kind: NotificationKind,
    enabled: boolean,
): Promise<boolean> {
    try {
        await client.execute({
            sql: `INSERT INTO notification_prefs (project_id, username, kind, enabled, updated_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(project_id, username, kind)
                    DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
            args: [projectId, username, kind, enabled ? 1 : 0, new Date().toISOString()],
        });
        return true;
    } catch {
        return false;
    }
}
