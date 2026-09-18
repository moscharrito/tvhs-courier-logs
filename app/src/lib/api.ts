/* The app's view of the server (ticket 7.1).
 *
 * Binds the pure request runner in http.ts to this phone's base URL and to
 * whatever token is in the Keychain. Every screen goes through here, so there
 * is one place that knows how to talk to dispatch and one place that decides
 * what happens when the credential stops working.
 */

import Constants from 'expo-constants';
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
export function baseUrl(): string {
    const extra = (Constants.expoConfig?.extra ?? {}) as { apiBaseUrl?: string };
    const url = (extra.apiBaseUrl ?? '').trim();
    if (url === '') {
        throw new Error(
            'This build has no apiBaseUrl. app.config.ts sets it from EXPO_PUBLIC_API_URL, so either the '
            + 'config did not load or the variable is unset for this profile. It is not defaulted to '
            + 'localhost on purpose: see src/lib/apiUrl.cjs.',
        );
    }
    return url;
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
    role: 'admin' | 'courier' | 'pharmacy';
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

export const get = <T>(path: string, token: string | null, options: RequestOptions = {}): Promise<T> =>
    request<T>(fetch, baseUrl(), path, { ...options, token });

export const post = <T>(path: string, token: string | null, json?: unknown): Promise<T> =>
    request<T>(fetch, baseUrl(), path, { method: 'POST', token, ...(json !== undefined ? { json } : {}) });

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

/** One claimable delivery. No patient name and no street: see the server's
 *  modules/uh/requests.ts, which decides what a courier may browse. */
export interface Claimable {
    orderId: number;
    reference: string;
    serviceType: string;
    zone: number | null;
    zip: string;
    pickUpFrom: string | null;
    dueAt: string | null;
    packages: number;
    requested: boolean;
}

export interface AvailableWork {
    serviceDate: string;
    onShift: boolean;
    available: Claimable[];
}

export const availableWork = (token: string, code: string): Promise<AvailableWork> =>
    get<AvailableWork>(`/api/projects/${code}/uh/requests/available`, token);

export const askFor = (token: string, code: string, orderIds: number[]): Promise<{ requested: number[]; refused: unknown[] }> =>
    post(`/api/projects/${code}/uh/requests`, token, { orderIds });

export interface MyRequest {
    id: number;
    orderId: number;
    status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'superseded';
    requestedAt: string;
    decidedAt: string | null;
    decisionReason: string;
    zip: string;
    zone: number | null;
    serviceType: string;
    dueAt: string | null;
}

export const myRequests = (token: string, code: string): Promise<{ requests: MyRequest[] }> =>
    get<{ requests: MyRequest[] }>(`/api/projects/${code}/uh/requests/mine`, token);

export const withdrawRequest = (token: string, code: string, id: number): Promise<unknown> =>
    request(fetch, baseUrl(), `/api/projects/${code}/uh/requests/${id}`, { method: 'DELETE', token });

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
