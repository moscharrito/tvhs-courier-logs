/* What each onboarding gate means to the person it is about (ticket 7.2).
 *
 * Pure, and therefore tested. The wording matters more than it looks. An
 * applicant reading "background_check: pending" learns nothing they can act
 * on, and the difference between "we are doing this, wait" and "we need
 * something from you" is the difference between a driver who waits and one
 * who gives up and drives for somebody else.
 *
 * The background check is deliberately marked as NOT theirs. Telling somebody
 * to go and chase a thing they have no way to chase is the fastest way to
 * lose a good applicant, and it is also untrue: we run it.
 */

export type CheckKind =
    | 'hipaa_training'
    | 'confidentiality'
    | 'background_check'
    | 'drivers_licence'
    | 'insurance';

export type CheckStatus = 'pending' | 'verified' | 'failed';

export interface CheckCopy {
    title: string;
    /** What it is for, in the applicant's terms. */
    what: string;
    /** Whether the applicant can do anything about it right now. */
    yours: boolean;
    /** Label for the reference box, when it is theirs to supply. */
    placeholder: string;
}

export const CHECK_COPY: Record<CheckKind, CheckCopy> = {
    hipaa_training: {
        title: 'HIPAA training',
        what: 'You will be taking medication to people at home, so the patient privacy training comes before you see a single address.',
        yours: true,
        placeholder: 'Certificate number',
    },
    confidentiality: {
        title: 'Confidentiality agreement',
        what: 'Signed once. University Health asks us for it by name.',
        yours: true,
        placeholder: 'Reference, if you have one',
    },
    background_check: {
        title: 'Background check',
        what: 'We run this one. There is nothing for you to send, and it takes a few days.',
        yours: false,
        placeholder: '',
    },
    drivers_licence: {
        title: 'Driving licence',
        what: 'Current, and it has to stay current: an expired one closes your access until it is renewed.',
        yours: true,
        placeholder: 'Licence number',
    },
    insurance: {
        title: 'Insurance',
        what: 'Cover on the vehicle you will be driving.',
        yours: true,
        placeholder: 'Policy number',
    },
};

/**
 * One line under the title.
 *
 * Says what happens next rather than restating the status, because "pending"
 * is a database word and the question being asked is "is somebody waiting on
 * me".
 */
export function checkState(kind: CheckKind, status: CheckStatus, submitted: boolean): string {
    if (status === 'verified') return 'Done.';
    if (status === 'failed') return 'This one did not pass. Dispatch will be in touch.';
    if (!CHECK_COPY[kind].yours) return 'With us. Nothing for you to do.';
    return submitted ? 'Sent. Waiting for dispatch to check it.' : 'Waiting for you.';
}

/** Everything the applicant could still act on. */
export function outstanding(
    checks: Array<{ kind: CheckKind; status: CheckStatus; submittedReference: string }>,
): CheckKind[] {
    return checks
        .filter((c) => c.status === 'pending' && CHECK_COPY[c.kind].yours && c.submittedReference === '')
        .map((c) => c.kind);
}

/** The headline on the status screen: one sentence, in their terms. */
export function overallState(
    status: string,
    ready: boolean,
    left: number,
): string {
    if (status === 'approved') return 'You are approved. Sign out and back in to pick up your first run.';
    if (status === 'rejected') return 'This application was not taken forward.';
    if (ready) return 'Everything is checked. Dispatch has the last word, and it is with them now.';
    if (left > 0) return `${left} ${left === 1 ? 'thing is' : 'things are'} waiting for you.`;
    return 'Everything you can send has been sent. The rest is with us.';
}
