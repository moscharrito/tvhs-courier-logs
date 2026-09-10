/* Typed application configuration.
 *
 * One object, built once from the environment, validated up front. Startup
 * fails with a message that names every missing or invalid variable rather
 * than surfacing as an obscure error later.
 *
 * server.js (legacy TVHS) still reads process.env directly; loadConfig() runs
 * before it is required, so a bad environment never reaches the legacy code.
 * Later tickets replace those reads with this object. */

import path from 'node:path';
import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

export interface Config {
    nodeEnv: NodeEnv;
    isProduction: boolean;
    port: number;
    timezone: string;
    sessionSecret: string;
    db: {
        /** libsql:// (Turso) or file: URL */
        url: string;
        authToken: string | undefined;
        kind: 'turso' | 'file';
    };
    files: {
        enabled: boolean;
        s3: {
            bucket: string;
            region: string;
            accessKeyId: string;
            secretAccessKey: string;
            kmsKeyId: string | undefined;
        } | undefined;
    };
    /** Server-side session lifetimes, in minutes. Staff = admin, ops manager,
     *  dispatcher, client viewer. Courier = drivers on the road all day. */
    sessions: {
        staffIdleMinutes: number;
        staffAbsoluteMinutes: number;
        courierIdleMinutes: number;
        courierAbsoluteMinutes: number;
    };
    /** Built frontend shell (web/dist). Served at / when present. */
    webDist: string;
    log: {
        level: 'debug' | 'info' | 'warn' | 'error';
        /** json in production and test, pretty in development unless overridden */
        format: 'json' | 'pretty';
    };
    /** Bootstrap accounts reconciled on boot by the legacy syncUsers(). */
    legacyUsers: {
        admin: { user: string | undefined; pass: string | undefined };
        driver1: { user: string | undefined; pass: string | undefined };
        driver2: { user: string | undefined; pass: string | undefined };
    };
}

export class ConfigError extends Error {
    constructor(public readonly problems: string[]) {
        super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
        this.name = 'ConfigError';
    }
}

const SERVER_DIR = path.resolve(__dirname, '..');

const optionalString = z.string().trim().min(1).optional();
const boolish = z
    .string()
    .trim()
    .optional()
    .transform((v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_TIMEZONE: z.string().trim().min(1).default('America/Chicago'),
    SESSION_SECRET: optionalString,
    TURSO_DATABASE_URL: optionalString,
    TURSO_AUTH_TOKEN: optionalString,
    DB_FILE: z.string().trim().min(1).default('courier_logs.db'),
    WEB_DIST: z.string().trim().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
    FILES_ENABLED: boolish,
    S3_BUCKET: optionalString,
    S3_REGION: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_KMS_KEY_ID: optionalString,
    SESSION_STAFF_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
    SESSION_STAFF_ABSOLUTE_MINUTES: z.coerce.number().int().min(1).default(12 * 60),
    SESSION_COURIER_IDLE_MINUTES: z.coerce.number().int().min(1).default(12 * 60),
    SESSION_COURIER_ABSOLUTE_MINUTES: z.coerce.number().int().min(1).default(30 * 24 * 60),
    ADMIN_USER: optionalString,
    ADMIN_PASS: optionalString,
    DRIVER1_USER: optionalString,
    DRIVER1_PASS: optionalString,
    DRIVER2_USER: optionalString,
    DRIVER2_PASS: optionalString,
});

function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the config from an environment map. Pure: no side effects, no caching.
 * Throws ConfigError listing every problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    // Treat empty strings as unset so `KEY=` in .env or a blank Render field
    // behaves like a missing variable.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && v.trim() !== '') cleaned[k] = v;
    }

    const parsed = EnvSchema.safeParse(cleaned);
    const problems: string[] = [];
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            problems.push(`${issue.path.join('.') || 'env'}: ${issue.message}`);
        }
        throw new ConfigError(problems);
    }
    const e = parsed.data;
    const isProduction = e.NODE_ENV === 'production';

    if (!e.SESSION_SECRET) {
        problems.push('SESSION_SECRET is required (a long random string; sessions are invalidated if it changes)');
    } else if (isProduction && e.SESSION_SECRET.length < 32) {
        problems.push('SESSION_SECRET must be at least 32 characters in production');
    }

    if (!isValidTimezone(e.APP_TIMEZONE)) {
        problems.push(`APP_TIMEZONE "${e.APP_TIMEZONE}" is not a valid IANA timezone`);
    }

    let dbKind: Config['db']['kind'] = 'file';
    let dbUrl: string;
    if (e.TURSO_DATABASE_URL) {
        dbKind = 'turso';
        dbUrl = e.TURSO_DATABASE_URL;
        if (!/^(libsql|https?|wss?):\/\//.test(dbUrl)) {
            problems.push('TURSO_DATABASE_URL must start with libsql://, https://, or wss://');
        }
        if (!e.TURSO_AUTH_TOKEN) {
            problems.push('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set');
        }
    } else {
        if (isProduction) {
            problems.push('TURSO_DATABASE_URL is required in production (a local file would be lost on redeploy)');
        }
        // Mirrors the legacy server: DB_FILE is joined onto the server dir.
        dbUrl = `file:${path.join(SERVER_DIR, e.DB_FILE)}`;
    }

    let s3: Config['files']['s3'] = undefined;
    if (e.FILES_ENABLED) {
        const missing = (['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter((k) => !e[k]);
        if (missing.length) {
            problems.push(`FILES_ENABLED is on but missing: ${missing.join(', ')}`);
        } else {
            s3 = {
                bucket: e.S3_BUCKET as string,
                region: e.S3_REGION as string,
                accessKeyId: e.S3_ACCESS_KEY_ID as string,
                secretAccessKey: e.S3_SECRET_ACCESS_KEY as string,
                kmsKeyId: e.S3_KMS_KEY_ID,
            };
        }
    }

    if (problems.length) throw new ConfigError(problems);

    return {
        nodeEnv: e.NODE_ENV,
        isProduction,
        port: e.PORT,
        timezone: e.APP_TIMEZONE,
        sessionSecret: e.SESSION_SECRET as string,
        db: { url: dbUrl, authToken: e.TURSO_AUTH_TOKEN, kind: dbKind },
        files: { enabled: e.FILES_ENABLED, s3 },
        webDist: e.WEB_DIST ? path.resolve(SERVER_DIR, e.WEB_DIST) : path.resolve(SERVER_DIR, '..', 'web', 'dist'),
        log: {
            level: e.LOG_LEVEL,
            format: e.LOG_FORMAT ?? (e.NODE_ENV === 'development' ? 'pretty' : 'json'),
        },
        sessions: {
            staffIdleMinutes: e.SESSION_STAFF_IDLE_MINUTES,
            staffAbsoluteMinutes: e.SESSION_STAFF_ABSOLUTE_MINUTES,
            courierIdleMinutes: e.SESSION_COURIER_IDLE_MINUTES,
            courierAbsoluteMinutes: e.SESSION_COURIER_ABSOLUTE_MINUTES,
        },
        legacyUsers: {
            admin: { user: e.ADMIN_USER, pass: e.ADMIN_PASS },
            driver1: { user: e.DRIVER1_USER, pass: e.DRIVER1_PASS },
            driver2: { user: e.DRIVER2_USER, pass: e.DRIVER2_PASS },
        },
    };
}

/** Secret-free view for boot logs. */
export function describeConfig(c: Config): Record<string, string | number | boolean> {
    return {
        env: c.nodeEnv,
        port: c.port,
        timezone: c.timezone,
        database: c.db.kind === 'turso' ? 'Turso (remote)' : c.db.url,
        files: c.files.enabled ? `S3 ${c.files.s3?.bucket ?? ''} (${c.files.s3?.region ?? ''})` : 'disabled',
        log: `${c.log.level} ${c.log.format}`,
    };
}

let cached: Config | undefined;

/** Process-wide config, built on first use. */
export function getConfig(): Config {
    if (!cached) cached = loadConfig();
    return cached;
}
