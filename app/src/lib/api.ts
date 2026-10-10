/* The app's view of the server (ticket 7.1).
 *
 * Binds the pure request runner in http.ts to this phone's base URL and to
 * whatever token is in the Keychain. Every screen goes through here, so there
 * is one place that knows how to talk to dispatch and one place that decides
 * what happens when the credential stops working.
 */

import Constants from 'expo-constants';
import { defaultServer, serverForContract, type ServerConfig } from './servers';
import { request, type RequestOptions } from './http';

/** From `extra.apiBaseUrl`, which app.config.ts sets per build profile, so a
 *  build points at an environment rather than at a constant somebody has to
 *  remember to change.
 *
 *  IT THROWS RATHER THAN FALLING BACK, and that is the correction. This read
 *  `?? 'http://127.0.0.1:3100'`, which quietly undid the whole of ticket
 *  7.6: the build-time guard refuses to produce a release build pointing at
 *  the phone itself, and then the runtime pointed at the phone itself anyway
 *  the moment `extra` was missing for any reason. Two guards disagreeing,
 *  and the silent one winning.
 *
 *  A missing base URL is a build that was assembled wrongly, not a condition
 *  to paper over. Throwing here shows up on the first screen, in development,
 *  to the person who can fix it. */
/* The decision itself lives in lib/servers.ts, which imports nothing from
   expo so it can be tested. This file only reads the config and holds the
   choice. */
const extra = (): ServerConfig => (Constants.expoConfig?.extra ?? {}) as ServerConfig;

/** The default server: UH, and everything before a contract is chosen. */
export const defaultBaseUrl = (): string => defaultServer(extra());

/** Which server a contract lives on. */
export const baseUrlForContract = (code: string): string => serverForContract(extra(), code);

/* ─────────────────────────────────────────────────────────────────────────
 * THE ACTIVE SERVER, AND WHY IT IS A VARIABLE RATHER THAN A FUNCTION OF THE
 * PATH.
 *
 * It is tempting to read the project out of the request path and pick the
 * server from that. It does not work, because A SESSION TOKEN BELONGS TO THE
 * SERVER THAT ISSUED IT. Signing in is `/api/login/pin`, which carries no
 * project; so is `/api/session`, `/api/config` and `/api/logout`. Send a
 * token minted by production to the laptop and it is simply not a session.
 *
 * So the server is chosen once, when the driver picks a contract, and every
 * call in that session goes to it. Picking a contract is the only thing that
 * changes it, and signing out puts it back.
 * ───────────────────────────────────────────────────────────────────────── */
let active: string | null = null;

/** Point every later call at this contract's server. */
export function useContractServer(code: string): string {
    active = baseUrlForContract(code);
    return active;
}

/** Restore the server a saved session was issued by (lib/session.ts). */
export function useServer(url: string): void {
    active = url.trim() === '' ? null : url.trim();
}

/** Back to the default, for a signed-out app with no contract chosen. */
export function forgetServer(): void {
    active = null;
}

export function baseUrl(): string {
    return active ?? defaultBaseUrl();
}

export interface SessionUser {
    id: number;
    username: string;
    name: string;
    role: 'admin' | 'staff' | 'driver';
    route: string | null;
}

export interface Project {
    id: number;
    code: string;
    name: string;
    timezone: string;
    /* 'lead' is a site lead: stationary at one pharmacy, owning the handover
     *  to drivers there. App.tsx renders them a different shell. */
    role: 'admin' | 'lead' | 'courier' | 'pharmacy';
}

export interface Stop {
    sequence: number;
    orderId: number;
    externalRef: string;
    serviceType: string;
    recipientName: string;
    address: string;
    city: string;
    zip: string;
    /** The third identifier. Empty where the pharmacy's list carried none,
     *  which is a different fact from "not checked" and is shown as such. */
    recipientPhone: string;
    /** The form is stamped ID Required: this delivery cannot be recorded
     *  without a photograph of the recipient's identification. */
    idRequired: boolean;
    /* How the pharmacy handed it over (drizzle/0051). Optional because a
       phone runs a build older or newer than the server it talks to, and a
       missing field here must read as "nothing special about this one"
       rather than stranding a courier. */
    /** Already in words: "Alma Reyes must sign. Nobody else." Phrased on the
     *  server so this screen and the proof of delivery cannot disagree. */
    signingInstruction?: string;
    /** Short chips for the run list: Fridge, Controlled, ID, Patient only. */
    handlingFlags?: string[];
    signatureRequired?: boolean;
    signatureRule?: 'anyone' | 'adult' | 'patient_only';
    authorisedSigners?: string;
    refrigerated?: boolean;
    controlled?: boolean;
    zone: number | null;
    status: string;
    dueAt: string | null;
}

export interface MyRun {
    serviceDate: string;
    timezone: string;
    courierUsername: string;
    runs: Array<{ id: number; label: string; status: string; stops: Stop[] }>;
    dispatch: { phone: string; name: string };
}

/** Sign in and come back with the token to keep. */
export async function signIn(username: string, password: string): Promise<SessionUser & { token: string }> {
    return request<SessionUser & { token: string }>(fetch, baseUrl(), '/api/login', {
        method: 'POST',
        json: { username, password },
        /* The header that asks for a token instead of a cookie. Without it
           the server sets a cookie and returns no token, which is right for
           the web shell and useless here. */
        asApp: true,
    });
}

/** The roster on the side of the vans. Unauthenticated, like the web
 *  sign-in page: it carries no PIN and no password hash. */
export interface DriverPick {
    /** TVHS’s two vans. Null for a courier on a project without routes. */
    route: string | null;
    username: string;
    name: string;
    /** Whether a PIN is already set. Meaningless without a route. */
    hasPin: boolean;
}

/**
 * TVHS sign-in: a van and a PIN.
 *
 * The legacy path, and the one two drivers have used for months. It is
 * accepted from any device, which server.js says in its own comment, so the
 * PIN is the only thing between a stranger and the account.
 */
export async function signInWithPin(route: string, pin: string): Promise<SessionUser & { token: string }> {
    return request<SessionUser & { token: string }>(fetch, baseUrl(), '/api/login/pin', {
        method: 'POST',
        json: { route, pin },
        /* Same as the password path: a token rather than a cookie. */
        asApp: true,
    });
}

/**
 * Set a new route PIN with the account password, and sign in with it.
 *
 * The web has always offered this behind "Forgot PIN? Use password"; the app
 * had no equivalent, so a driver who forgot the PIN on the cab phone had to
 * find a laptop. TVHS runs on two phones and two drivers, which makes that a
 * stuck shift rather than an inconvenience.
 *
 * Same endpoint and same arguments as the web's startPinReset path, so the
 * two cannot drift apart.
 */
export async function setPinWithPassword(
    route: string, password: string, pin: string,
): Promise<SessionUser & { token: string }> {
    return request<SessionUser & { token: string }>(fetch, baseUrl(), '/api/login/pin/setup', {
        method: 'POST',
        json: { route, password, pin },
        asApp: true,
    });
}

export const get = <T>(path: string, token: string | null, options: RequestOptions = {}): Promise<T> =>
    request<T>(fetch, baseUrl(), path, { ...options, token });

export const post = <T>(path: string, token: string | null, json?: unknown): Promise<T> =>
    request<T>(fetch, baseUrl(), path, { method: 'POST', token, ...(json !== undefined ? { json } : {}) });

export const del = <T>(path: string, token: string | null, json?: unknown): Promise<T> =>
    request<T>(fetch, baseUrl(), path, { method: 'DELETE', token, ...(json !== undefined ? { json } : {}) });

export const signOut = (token: string | null): Promise<unknown> => post('/api/logout', token);

/* ------------------------------------------------- applying to drive (7.2) */

export interface ApplyInput {
    projectCode: string;
    name: string;
    email: string;
    phone: string;
    password: string;
}

/** Public. Creates an account that can sign in and see nothing but its own
 *  application, plus the application itself. See server ticket 6.1. */
export async function applyToDrive(input: ApplyInput): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>(fetch, baseUrl(), '/api/driver-applications', {
        method: 'POST',
        json: input,
    });
}

export type CheckKind =
    | 'hipaa_training'
    | 'confidentiality'
    | 'background_check'
    | 'drivers_licence'
    | 'insurance';

export interface MyApplication {
    project: { code: string; name: string };
    status: 'submitted' | 'in_review' | 'approved' | 'rejected' | 'withdrawn';
    submittedAt: string | null;
    decisionReason: string;
    clearance: { ready: boolean; missing: CheckKind[]; expired: CheckKind[]; failed: CheckKind[]; why: string };
    checks: Array<{
        kind: CheckKind;
        status: 'pending' | 'verified' | 'failed';
        submittedReference: string;
        submittedAt: string | null;
    }>;
}

export const myApplication = (token: string): Promise<MyApplication> =>
    get<MyApplication>('/api/me/application', token);

/** Supply a reference for one gate. Verifies nothing: see server ticket 7.2. */
export const submitCheck = (token: string, kind: CheckKind, reference: string, note = ''): Promise<unknown> =>
    request(fetch, baseUrl(), `/api/me/application/checks/${kind}`, {
        method: 'PUT', token, json: { reference, note },
    });

/* ------------------------------------------------- shifts and work (7.3) */

export interface ShiftState {
    shift: { id: number; startedAt: string; open: boolean } | null;
    carrying: Array<{ id: number; reference: string; status: string }>;
}

export const myShift = (token: string, code: string): Promise<ShiftState> =>
    get<ShiftState>(`/api/projects/${code}/uh/shifts/mine`, token);

export const startShift = (token: string, code: string): Promise<unknown> =>
    post(`/api/projects/${code}/uh/shifts/start`, token, {});

export const endShift = (token: string, code: string): Promise<unknown> =>
    post(`/api/projects/${code}/uh/shifts/end`, token, {});

/* ASKING FOR WORK IS GONE, AND THE SERVER ENDPOINTS ARE NOT.
 *
 * Dispatch assigns every delivery from the forecast and a site lead moves one
 * at the counter; a courier choosing their own stops is not in the operating
 * model University Health were shown. So the app no longer browses or claims,
 * and Board, Requests and lib/work.ts went with it.
 *
 * The /uh/requests endpoints stay on the server. They are still reachable by
 * a courier and are still covered by the access matrix, because deleting a
 * working API to remove a screen is two changes dressed as one, and the
 * decision about the API belongs with whoever decides whether any contract
 * ever wants self-assignment again.
 */


export interface Notification {
    id: number;
    kind: string;
    body: string;
    orderId: number | null;
    createdAt: string;
    readAt: string | null;
}

export const myNotifications = (token: string, code: string): Promise<{ unread: number; notifications: Notification[] }> =>
    get<{ unread: number; notifications: Notification[] }>(`/api/projects/${code}/uh/notifications`, token);

export const markRead = (token: string, code: string): Promise<unknown> =>
    post(`/api/projects/${code}/uh/notifications/read`, token, {});

/* ----------------------------------------------- delivery history (9.1) */

export interface HistoryStop {
    orderId: number;
    serviceType: string;
    status: string;
    recipientName: string;
    address: string;
    siteName: string | null;
    deliveredAt: string | null;
    /** Measured at arrival, not handover. Null when there was no deadline. */
    onTime: boolean | null;
    failureReason: string | null;
}

export interface HistoryDay {
    date: string;
    delivered: number;
    failed: number;
    onTime: number;
    stops: HistoryStop[];
}

export interface DeliveryHistory {
    from: string;
    to: string;
    timezone: string;
    courierUsername: string;
    days: HistoryDay[];
    totals: {
        delivered: number;
        failed: number;
        daysWorked: number;
        onTimeRate: number | null;
    };
}

/** This courier's own finished work. There is no username parameter, and
 *  that is the point: the server takes it from the session. */
export const deliveryHistory = (
    token: string, code: string, from: string, to: string,
): Promise<DeliveryHistory> =>
    get<DeliveryHistory>(`/api/projects/${code}/uh/runs/history?from=${from}&to=${to}`, token);
