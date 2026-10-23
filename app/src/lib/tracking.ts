/* Background location, wired to the platform (ticket 7.4).
 *
 * The half that needs a phone. Every decision it makes is in trace.ts, which
 * is tested; this is the plumbing between expo-location and the server, and
 * it has never been run.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY REASON THE APP IS NATIVE.
 *
 * Everything else the courier app does, the PWA already did: install to the
 * home screen, work offline, use the camera, read a position when asked. What
 * a web app cannot do on iOS, and will not be able to, is report a position
 * while it is in the background. That single requirement is what made this a
 * React Native app rather than a saved bookmark, and it is worth remembering
 * when somebody asks why there are two front ends.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE TASK STOPS ITSELF. A background task outlives the app being swiped
 * away, so "we stop it when they tap off shift" is a promise this file cannot
 * keep alone: the tap may happen on another device, the shift may be ended by
 * dispatch, the process may be restarted by the operating system holding
 * stale state. So the server's refusal is the stop signal. `stopOn` in
 * trace.ts decides, and the worst case is one rejected batch rather than a
 * record of somebody's evening.
 *
 * NOTHING IS COLLECTED UNTIL A RETENTION PERIOD EXISTS. The server answers
 * 503 `tracking.retentionUndecided` until somebody sets
 * RETENTION_LOCATION_TRACE_DAYS, and that is a permanent stop here too. The
 * app does not queue fixes against a day when collecting them might become
 * allowed.
 */

import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { baseUrl } from './api';
import { request } from './http';
import { ApiError } from './http';
import { loadToken } from './session';
import { nextBatch, stopOn, thin, type Fix, type StopReason } from './trace';

export const TASK = 'izy-shift-location';

/* Which project the open shift belongs to. Set when tracking starts and read
 * by the task, which gets no arguments of its own. Module state survives for
 * as long as the task's JavaScript context does, and when it does not, the
 * first send is refused and the task stops, which is the safe direction. */
let trackingProject: string | null = null;
let lastStop: StopReason | null = null;

/** What the UI asks, to know what to say. */
export const stoppedBecause = (): StopReason | null => lastStop;

/** Fixes that could not be sent yet. Small: see thin() and MAX_BATCH. */
let queue: Fix[] = [];

function toFix(location: Location.LocationObject): Fix {
    return {
        at: new Date(location.timestamp).toISOString(),
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        ...(location.coords.accuracy !== null && location.coords.accuracy !== undefined
            ? { accuracyM: location.coords.accuracy }
            : {}),
    };
}

/** Send what is queued. Leaves it queued if the send fails for a reason that
 *  is not "stop". */
async function flush(): Promise<void> {
    if (trackingProject === null || queue.length === 0) return;
    const token = await loadToken();
    if (token === null) { await stopTracking('signedOut'); return; }

    const { batch, rest } = nextBatch(thin(queue));
    if (batch.length === 0) { queue = rest; return; }

    try {
        await request(fetch, baseUrl(), `/api/projects/${trackingProject}/uh/tracking`, {
            method: 'POST', token, json: { fixes: batch },
        });
        queue = rest;
    } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        const code = err instanceof ApiError ? err.code : undefined;
        const stop = stopOn(status, code);
        if (stop !== null) {
            /* Not a retry. See the header: this is the case where continuing
               would mean recording somebody who should not be recorded. */
            queue = [];
            await stopTracking(stop);
            return;
        }
        /* A bad minute. Keep them and try on the next fix, but do not let the
           queue grow without limit on a phone that is out of signal for
           hours: the oldest are the least useful and go first. */
        queue = [...batch, ...rest].slice(-1000);
    }
}

TaskManager.defineTask(TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody<{ locations?: Location.LocationObject[] }>) => {
    if (error) return;
    const locations = data?.locations ?? [];
    if (locations.length === 0) return;
    queue = [...queue, ...locations.map(toFix)];
    await flush();
});

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/* ANDROID DOES NOT ASK FOR "ALL THE TIME" (build 4).
 *
 * startTracking runs as a foreground service with a permanent notification,
 * started from the Go on shift tap. expo-location starts that with the
 * while-in-use permission alone (LocationModule.kt, startLocationUpdatesAsync:
 * "a user-initiated foreground service with notification ... does NOT
 * require the background location permission"), and it keeps reporting with
 * the screen locked. So ACCESS_BACKGROUND_LOCATION is blocked in app.json,
 * which removes Play's background location declaration entirely.
 *
 * With it gone from the manifest, get/requestBackgroundPermissionsAsync THROW
 * on Android. Calling them would make permissionState() answer 'undetermined'
 * forever and askPermission() answer 'denied' every time, so Android stops at
 * the foreground answer. iOS is unchanged: it still needs "Always". */
const needsBackground = Platform.OS !== 'android';

/** What the phone has already agreed to, without asking again. */
export async function permissionState(): Promise<PermissionState> {
    try {
        const foreground = await Location.getForegroundPermissionsAsync();
        if (!foreground.granted) return foreground.canAskAgain ? 'undetermined' : 'denied';
        if (!needsBackground) return 'granted';
        const background = await Location.getBackgroundPermissionsAsync();
        if (background.granted) return 'granted';
        return background.canAskAgain ? 'undetermined' : 'denied';
    } catch {
        return 'undetermined';
    }
}

/**
 * Ask, in the order the platforms require.
 *
 * Foreground first and background second, separately, because that is what
 * both stores expect and because asking for "always" out of nowhere is the
 * request people refuse. It is called when a courier goes on shift, which is
 * the moment it makes sense to them.
 */
export async function askPermission(): Promise<PermissionState> {
    try {
        const foreground = await Location.requestForegroundPermissionsAsync();
        if (!foreground.granted) return 'denied';
        if (!needsBackground) return 'granted';
        const background = await Location.requestBackgroundPermissionsAsync();
        return background.granted ? 'granted' : 'denied';
    } catch {
        return 'denied';
    }
}

/** Begin, for one project's open shift. Safe to call twice. */
export async function startTracking(projectCode: string): Promise<PermissionState> {
    const permission = await permissionState();
    if (permission !== 'granted') return permission;

    trackingProject = projectCode;
    lastStop = null;
    try {
        const already = await Location.hasStartedLocationUpdatesAsync(TASK);
        if (already) return 'granted';

        await Location.startLocationUpdatesAsync(TASK, {
            accuracy: Location.Accuracy.Balanced,
            /* Roughly a fix a minute while moving. trace.ts thins further;
               these are the floor, chosen for a battery that has to last a
               shift rather than for a tracklog. */
            timeInterval: 60_000,
            distanceInterval: 50,
            pausesUpdatesAutomatically: true,
            /* Android requires a visible, permanent notification for this, and
               that is a feature rather than a hoop: a courier should not have
               to open the app to find out they are being followed. */
            foregroundService: {
                notificationTitle: 'On shift',
                notificationBody: 'Dispatch can see where you are until you finish your shift.',
                notificationColor: '#14532d',
            },
        });

        /* ─────────────────────────────────────────────────────────────────
         * ASKING WHETHER IT ACTUALLY STARTED, BECAUSE IT DID NOT ONCE.
         *
         * startLocationUpdatesAsync resolving is not the same as updates
         * running. On build 4 it resolved, and no foreground service was
         * running, no notification was posted, and no provider had a
         * request registered -- while the shift bar told the courier
         * dispatch could see them.
         *
         * So the promise is not taken as proof. hasStartedLocationUpdatesAsync
         * asks the platform, and a no is recorded as 'didNotStart' rather
         * than returned as a permission answer, which is what buried it the
         * first time: 'denied' reads as "the courier said no". ────────── */
        if (!(await Location.hasStartedLocationUpdatesAsync(TASK))) {
            lastStop = 'didNotStart';
            console.warn('[tracking] startLocationUpdatesAsync resolved but the task is not running');
            return 'denied';
        }
        lastStop = null;
        return 'granted';
    } catch (err) {
        /* NOT A BARE CATCH ANY MORE. This swallowed whatever
           startLocationUpdatesAsync threw and returned 'denied', so a
           failure to start was indistinguishable from a courier declining
           the prompt -- and there was nothing in logcat either way. The
           message is the only thread anybody gets to pull on. */
        lastStop = 'didNotStart';
        console.warn('[tracking] startLocationUpdatesAsync threw:', err instanceof Error ? err.message : String(err));
        return 'denied';
    }
}

/** Stop, and remember why, so the screen can say. */
export async function stopTracking(reason: StopReason = 'notOnShift'): Promise<void> {
    lastStop = reason;
    trackingProject = null;
    queue = [];
    try {
        if (await Location.hasStartedLocationUpdatesAsync(TASK)) {
            await Location.stopLocationUpdatesAsync(TASK);
        }
    } catch {
        /* Nothing useful to do. The task will stop itself on its next send,
           because the server refuses anything outside an open shift. */
    }
}

/** Whether the platform currently has the task running. */
export async function isTracking(): Promise<boolean> {
    try {
        return await Location.hasStartedLocationUpdatesAsync(TASK);
    } catch {
        return false;
    }
}
