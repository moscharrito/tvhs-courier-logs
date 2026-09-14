/* Thin JSON client over fetch. Same-origin cookies carry the session. */

export class ApiError extends Error {
    constructor(public readonly status: number, message: string, public readonly details: string[] = []) {
        super(message);
        this.name = 'ApiError';
    }
}

export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init;
    const res = await fetch(url, {
        credentials: 'same-origin',
        ...rest,
        headers: { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
        body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
        const b = (body ?? {}) as { error?: string; details?: string[] };
        throw new ApiError(res.status, b.error || `Request failed (${res.status})`, b.details ?? []);
    }
    return body as T;
}

export interface SessionUser {
    id: number;
    username: string;
    name: string;
    role: 'admin' | 'staff' | 'driver';
    route: string | null;
    /** Where this account stands on a second factor (ticket 4.3).
     *  `enforced` means the API will refuse everything else until it exists. */
    mfa?: { required: boolean; confirmed: boolean; enforced: boolean };
}

export interface MfaStatus {
    required: boolean;
    enforced: boolean;
    enrolled: boolean;
    confirmed: boolean;
    recoveryCodesRemaining: number;
}

export interface ProjectMembership {
    id: number;
    code: string;
    name: string;
    timezone: string;
    role: 'admin' | 'ops_manager' | 'dispatcher' | 'courier' | 'client_viewer';
}

export interface DriverPick {
    route: string;
    name: string;
    hasPin: boolean;
}

export interface UserSummary {
    id: number;
    username: string;
    name: string;
    email: string | null;
    role: 'admin' | 'staff' | 'driver';
    status: 'active' | 'disabled';
    hasPin: boolean;
    created_at: string | null;
    memberships: Array<{ project_id: number; code: string; project_name: string; role: ProjectMembership['role']; settings: Record<string, unknown> }>;
}

/** An enrolled phone (ticket 2.3), as distinct from a live session. */
export interface EnrolledDevice {
    id: string;
    label: string;
    userAgent: string;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
    current: boolean;
}

/** What GET /api/login/device says about the phone the app is open on. */
export type DeviceIdentity =
    | { enrolled: false }
    | { enrolled: true; name: string; username: string; hasPin: boolean; label: string };

/** A disagreement between the system and reality (ticket 5.2). */
export interface Discrepancy {
    id: number;
    serviceDate: string;
    kind: string;
    severity: 'critical' | 'major' | 'minor';
    orderId: number | null;
    reference: string | null;
    expected: string;
    actual: string;
    reportedBy: string;
    reportedAt: string;
    status: 'open' | 'resolved' | 'accepted';
    resolution: string;
    resolvedBy: string;
    resolvedAt: string | null;
}

export interface DiscrepancySummary {
    days: Array<{ serviceDate: string; open: number; resolved: number; accepted: number; critical: number; major: number; minor: number }>;
    totals: { open: number; resolved: number; accepted: number };
    goLive: { openCritical: number; openTotal: number; ready: boolean; why: string };
}

export interface SessionSummary {
    id: string;
    device: string;
    ip: string;
    created_at: string;
    last_seen_at: string;
    idle_expires_at: string;
    absolute_expires_at: string;
    current: boolean;
}

export interface AuditEvent {
    id: number;
    at: string;
    project_id: number | null;
    user_id: number | null;
    username: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    ip: string;
    detail: Record<string, unknown>;
}

export const fmtWhen = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
