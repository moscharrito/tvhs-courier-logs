/* Going on shift, and the order it has to happen in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Tickets 7.3 and 7.4 were both recorded as "Done, typechecked and never
 * run". They were also never WIRED: nothing imported lib/tracking.ts, nothing
 * called startShift, and `trackingState` was referenced only by its own test.
 * So the app declared five location permissions in its manifest, requested
 * none of them, sent no coordinates, and showed a driver no banner -- while
 * the submission doc told Apple that the prompt appears when a driver goes on
 * shift and that the tracking state is on screen whenever the app is open.
 *
 * Both halves of the feature existed and were tested. The missing piece was
 * the one that cannot be unit-tested on this machine, which is exactly the
 * piece that goes untested and therefore unbuilt: a screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ORDER IS THE WHOLE RISK.
 *
 * Both sequences below are wrong in a way that still appears to work if the
 * steps are swapped, which is why they are here as data rather than as the
 * order somebody happened to type into a component:
 *
 *   ON:  the server refuses a fix with no open shift
 *        (modules/uh/tracking.ts -> `tracking.notOnShift`), and trace.ts
 *        treats that refusal as a PERMANENT stop rather than a bad minute.
 *        Starting the tracker before the shift therefore does not just drop
 *        one batch -- it shuts tracking down for the rest of the day, and the
 *        banner says "Location stopped" to a driver who did nothing wrong.
 *
 *   OFF: the mirror. Ending the shift first leaves a background task still
 *        posting into a closed shift, which earns the same permanent stop,
 *        and the task outlives the app being swiped away. Stop the tracker,
 *        then close the shift.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REFUSING LOCATION MUST NOT STOP SOMEBODY WORKING.
 *
 * `permissionStep` returns 'skip' for a denied permission and the shift still
 * opens. A driver who said no to the prompt, or whose phone was handed to
 * them with it already denied, still has deliveries to make and a patient
 * waiting; `trackingState` already has words for that case ("Dispatch cannot
 * see where you are, so they will ring you instead"). An app that refuses to
 * let somebody work until they are trackable is not a thing we are building.
 */

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** One thing the shell has to do, named rather than inlined so the order can
 *  be asserted without a phone. */
export type Step =
    | 'startShift'
    | 'disclose'
    | 'askPermission'
    | 'startTracking'
    | 'stopTracking'
    | 'endShift';

/**
 * What to do about location when a driver goes on shift.
 *
 * 'ask' only when the phone has not been asked. Asking again after a refusal
 * is how an app earns a permanently denied permission on iOS, where the
 * second prompt never appears and the answer is remembered.
 */
export function permissionStep(current: PermissionState): 'ask' | 'start' | 'skip' {
    if (current === 'granted') return 'start';
    if (current === 'undetermined') return 'ask';
    return 'skip';
}

/**
 * The steps for going on shift, in order.
 *
 * 'disclose' IS A POLICY REQUIREMENT, NOT A COURTESY. Google requires a
 * prominent in-app disclosure BEFORE the runtime prompt, saying that location
 * is collected in the background and why. A button reading "Go on shift" and
 * a banner reading "Off shift" are not that, so the prompt cannot be the
 * first thing a driver sees. It appears once, on the only run where the
 * permission is undetermined, and declining it opens the shift untracked.
 *
 * `permission` is what the phone says BEFORE being asked. When it is
 * undetermined the prompt is shown and tracking is attempted afterwards:
 * startTracking re-reads the real permission and returns 'denied' without
 * starting anything if the driver said no, so this list does not have to
 * predict the answer.
 */
export function goOnShift(permission: PermissionState): Step[] {
    const step = permissionStep(permission);
    if (step === 'start') return ['startShift', 'startTracking'];
    if (step === 'ask') return ['startShift', 'disclose', 'askPermission', 'startTracking'];
    /* On shift, untracked, and told so. */
    return ['startShift'];
}

/** The steps for going off shift, in order. */
export function goOffShift(): Step[] {
    return ['stopTracking', 'endShift'];
}

/** The label on the one button, so the screen and the tests agree on it. */
export function shiftButton(onShift: boolean, busy: boolean): string {
    if (busy) return onShift ? 'Going off shift…' : 'Going on shift…';
    return onShift ? 'Go off shift' : 'Go on shift';
}
