/* Turning a server refusal into something a driver can act on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS EXISTS BECAUSE OF.
 *
 * A courier standing in a car park saw this, six times over:
 *
 *   6 things were refused: Cannot record "arrived" while the order is
 *   assigned: the order must be picked_up.
 *
 * Every word of that is true and none of it is usable. It names an internal
 * status (`picked_up`, underscore and all), it describes a state machine
 * rather than a situation, and it does not say the one thing that would
 * have helped: go and collect the packages from the pharmacy first.
 *
 * The server's wording is right for the server. `lifecycle.ts` refuses an
 * illegal transition and says which one, which is exactly what a log needs
 * and exactly what an API consumer needs. This is the other audience.
 *
 * THE SERVER'S SENTENCE IS NEVER THROWN AWAY. Where a refusal is recognised
 * it is replaced for the driver and kept underneath, because the one who
 * eventually rings dispatch needs to be able to read out what actually
 * happened. Where it is not recognised, the server's own words are shown
 * rather than a shrug: a sentence nobody wrote for a driver still beats
 * "something went wrong".
 * ───────────────────────────────────────────────────────────────────────── */

export interface Refusal {
    /** The sentence to put on screen. */
    text: string;
    /** What to do about it, when there is something. */
    action?: 'collect' | 'signIn' | 'callDispatch';
    /** The server's own words, kept for when somebody rings dispatch. */
    original: string;
}

/* Matched on the shape of the message rather than on a code, because
   `recordOrderEvent` refuses with a sentence and not a code, and adding one
   would be a server change for a client problem. Each pattern is anchored on
   words the transition table actually produces. */
const RULES: ReadonlyArray<{ test: RegExp; make: (m: RegExpMatchArray) => Omit<Refusal, 'original'> }> = [
    {
        /* The one that was on screen. */
        test: /Cannot record "arrived".*must be picked_up/i,
        make: () => ({
            text: 'Collect this from the pharmacy before you arrive at the stop. '
                + 'Today, then Collect from a pharmacy.',
            action: 'collect',
        }),
    },
    {
        test: /Cannot record "(delivered|attempted)".*must be (picked_up|arrived)/i,
        make: () => ({
            text: 'Tap Arrive at the stop before recording what happened there. '
                + 'If the packages are not in your van yet, collect them first.',
            action: 'collect',
        }),
    },
    {
        /* Somebody else got there first, or the stop moved. */
        test: /already (delivered|failed|cancelled|returned)/i,
        make: (m) => ({
            text: `This stop was already marked ${m[1]}. Nothing you did was lost, and there is nothing left to do here.`,
        }),
    },
    {
        test: /taken by somebody else|stop\.taken/i,
        make: () => ({
            text: 'Another courier was given this one while you were offline. Nothing you recorded was lost.',
        }),
    },
    {
        test: /not on shift|tracking\.notOnShift/i,
        make: () => ({
            text: 'You were not on shift when this was recorded. Go on shift, then try again.',
        }),
    },
    {
        test: /session|unauthori[sz]ed|401/i,
        make: () => ({
            text: 'You were signed out while this was waiting to send. Sign in again and it will go.',
            action: 'signIn',
        }),
    },
];

/** One refusal, in words a driver can act on. */
export function explain(why: string): Refusal {
    const message = (why ?? '').trim();
    for (const rule of RULES) {
        const m = message.match(rule.test);
        if (m) return { ...rule.make(m), original: message };
    }
    /* Not recognised. The server's own sentence, which is at least true and
       specific, rather than a generic apology. */
    return {
        text: message === '' ? 'Dispatch refused this and did not say why. Ring them before carrying on.' : message,
        action: 'callDispatch',
        original: message,
    };
}

/**
 * The headline over a pile of refusals.
 *
 * Six identical refusals are one problem, not six, and "6 things were
 * refused" invited a courier to think six deliveries had been lost. They had
 * not: the same six stops were all waiting on the same missing collection.
 */
export function summarise(rejections: ReadonlyArray<{ why: string }>): { headline: string; refusal: Refusal } | null {
    if (rejections.length === 0) return null;
    const explained = rejections.map((r) => explain(r.why));
    const first = explained[0]!;
    const allSame = explained.every((e) => e.text === first.text);

    if (allSame) {
        return {
            headline: rejections.length === 1
                ? 'One thing could not be recorded'
                : `${rejections.length} things could not be recorded, all for the same reason`,
            refusal: first,
        };
    }
    /* Mixed reasons: show the most recent, and say how many others there
       are rather than stacking six alerts on a phone screen. */
    const last = explained[explained.length - 1]!;
    const others = rejections.length - 1;
    return {
        headline: `${rejections.length} things could not be recorded, for different reasons`,
        refusal: {
            ...last,
            text: `${last.text} (and ${others} other ${others === 1 ? 'problem' : 'problems'})`,
        },
    };
}
