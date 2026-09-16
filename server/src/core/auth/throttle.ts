/* Failed-attempt throttling for everything that checks a credential.
 *
 * Ticket 4.2. Before this there were two copies of the same counter, one in
 * server.js for the PIN picker and one in devices.ts for enrolled phones, and
 * the password endpoint had none at all: `POST /api/login` would answer an
 * unlimited number of guesses as fast as bcrypt could refuse them. This is one
 * implementation, used by all four.
 *
 * WHAT IT COUNTS. Failures only. A correct credential clears the counter, so
 * somebody who mistypes a password twice and then gets it right is not one
 * attempt closer to a lockout tomorrow.
 *
 * TWO KEYS, NOT ONE. A password endpoint is throttled by username and by
 * address. By username alone, an attacker sprays one guess at a thousand
 * accounts and is never counted. By address alone, an attacker with a
 * thousand addresses is never counted, and a pharmacy behind one NAT locks
 * itself out. Neither is enough on its own; both together are cheap.
 *
 * WHAT IT DOES NOT DO. The counters are in this process's memory. On one
 * Render instance that is the whole picture. On two, an attacker gets each
 * limit once per instance, which is a weakening but not a hole. Moving the
 * counters into the database is the fix, and it is worth doing when there is
 * a second instance and not before: a write per failed attempt against a
 * network database is a denial-of-service lever handed to the attacker.
 *
 * A lockout is not silent. Each one writes `auth.throttled` to the audit
 * trail, which is how a spray against many accounts becomes visible.
 */

export interface ThrottleOptions {
    /** Failures allowed inside the window before the caller is refused. */
    maxAttempts: number;
    windowMs: number;
    /** Most keys held at once. Beyond this the oldest are dropped: a key is
     *  attacker-chosen (any username at all), so it cannot grow forever. */
    maxKeys?: number;
}

export interface Throttle {
    /** True when this key has spent its attempts and the window is still open. */
    blocked(key: string): boolean;
    /** Seconds until the window closes, for Retry-After. */
    retryAfter(key: string): number;
    /** Record a failure. Returns true if that failure was the one that blocked it. */
    fail(key: string): boolean;
    /** A success. Forgets the failures. */
    reset(key: string): void;
    clear(): void;
    readonly size: number;
}

interface Record_ { count: number; until: number }

export function createThrottle({ maxAttempts, windowMs, maxKeys = 10_000 }: ThrottleOptions): Throttle {
    const records = new Map<string, Record_>();

    /* Map preserves insertion order, so the first entries are the oldest. This
     * runs only when the map is full, which on any normal day never happens. */
    function prune(now: number): void {
        for (const [key, rec] of records) {
            if (rec.until <= now) records.delete(key);
        }
        while (records.size >= maxKeys) {
            const oldest = records.keys().next();
            if (oldest.done) break;
            records.delete(oldest.value);
        }
    }

    return {
        blocked(key) {
            const rec = records.get(key);
            return !!rec && rec.count >= maxAttempts && rec.until > Date.now();
        },
        retryAfter(key) {
            const rec = records.get(key);
            if (!rec) return 0;
            return Math.max(0, Math.ceil((rec.until - Date.now()) / 1000));
        },
        fail(key) {
            const now = Date.now();
            if (records.size >= maxKeys) prune(now);
            const rec = records.get(key);
            if (!rec || rec.until <= now) {
                // A fresh window. Its end is fixed here, so a persistent
                // attacker cannot push it out one attempt at a time.
                records.set(key, { count: 1, until: now + windowMs });
                return 1 >= maxAttempts;
            }
            rec.count += 1;
            return rec.count === maxAttempts;
        },
        reset(key) { records.delete(key); },
        clear() { records.clear(); },
        get size() { return records.size; },
    };
}

/* ------------------------------------------------------------- the policy */

/* Numbers, in one place, with the reasoning attached.
 *
 * A password is long, so ten wrong ones in a quarter of an hour is somebody
 * guessing, not somebody with sticky keys. A PIN is four digits: five wrong
 * ones is the most that can be allowed and still leave ten thousand
 * possibilities out of reach, which is the only reason four digits is
 * acceptable on a screen showing PHI at all.
 *
 * The per-address limits are generous on purpose. Couriers share carrier NAT,
 * and locking out a pharmacy's whole office because one person forgot their
 * password would be an outage we caused. */
export const LIMITS = {
    password: { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
    passwordByAddress: { maxAttempts: 50, windowMs: 15 * 60 * 1000 },
    pin: { maxAttempts: 5, windowMs: 10 * 60 * 1000 },
    pinByAddress: { maxAttempts: 30, windowMs: 10 * 60 * 1000 },
    /* The public driver-application form (ticket 6.1). No credential to
       spray at, so this protects the table and whoever reads the queue in
       the morning. Generous, because a genuine applicant who mistypes their
       email and resubmits twice is not an attack. */
    applications: { maxAttempts: 12, windowMs: 60 * 60 * 1000 },
} as const;

/** Normalise an address into a throttle key. */
export function addressKey(ip: string | undefined): string {
    return `ip:${(ip ?? 'unknown').trim().toLowerCase().slice(0, 60)}`;
}

/** Normalise an account identifier (username, route, device) into a key. */
export function identityKey(kind: string, value: string | undefined): string {
    return `${kind}:${(value ?? '').trim().toLowerCase().slice(0, 120)}`;
}

/** The message a refused caller is given. It says what to do, and it says the
 *  same thing whether or not the account exists. */
export function tooManyAttempts(seconds: number, alternative: string): { error: string; code: string; retryAfterSeconds: number } {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return {
        error: `Too many attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'}${alternative ? `, or ${alternative}` : ''}.`,
        code: 'auth.throttled',
        retryAfterSeconds: seconds,
    };
}

/* ------------------------------------------------------- the two guards */

export interface CredentialGuard {
    /** Null when the caller may proceed; otherwise how long to wait. */
    check(ip: string | undefined, identity: string): { retryAfterSeconds: number } | null;
    /** Record a failure. True when this one tripped a limit, which is the
     *  moment worth writing to the audit trail. */
    fail(ip: string | undefined, identity: string): boolean;
    /** A correct credential. Clears the identity's counter, not the
     *  address's: one person signing in correctly must not wipe the evidence
     *  of a spray coming from the same address. */
    reset(ip: string | undefined, identity: string): void;
    clear(): void;
}

function guard(kind: string, byIdentity: Throttle, byAddress: Throttle): CredentialGuard {
    return {
        check(ip, identity) {
            const id = identityKey(kind, identity);
            const addr = addressKey(ip);
            if (byIdentity.blocked(id)) return { retryAfterSeconds: byIdentity.retryAfter(id) };
            if (byAddress.blocked(addr)) return { retryAfterSeconds: byAddress.retryAfter(addr) };
            return null;
        },
        fail(ip, identity) {
            const trippedIdentity = byIdentity.fail(identityKey(kind, identity));
            const trippedAddress = byAddress.fail(addressKey(ip));
            return trippedIdentity || trippedAddress;
        },
        reset(ip, identity) {
            byIdentity.reset(identityKey(kind, identity));
        },
        clear() { byIdentity.clear(); byAddress.clear(); },
    };
}

export interface AuthThrottles {
    /** Anything that checks a password: sign-in, PIN setup, device enrolment. */
    password: CredentialGuard;
    /** Anything that checks a PIN: the route picker and an enrolled phone. */
    pin: CredentialGuard;
    clear(): void;
}

/** One set for the process. Created at boot and shared by every entry point,
 *  so a guesser cannot get a fresh allowance by switching between them. */
export function createAuthThrottles(): AuthThrottles {
    const passwordByIdentity = createThrottle(LIMITS.password);
    const passwordByAddress = createThrottle(LIMITS.passwordByAddress);
    const pinByIdentity = createThrottle(LIMITS.pin);
    const pinByAddress = createThrottle(LIMITS.pinByAddress);
    const password = guard('user', passwordByIdentity, passwordByAddress);
    const pin = guard('pin', pinByIdentity, pinByAddress);
    return { password, pin, clear() { password.clear(); pin.clear(); } };
}
