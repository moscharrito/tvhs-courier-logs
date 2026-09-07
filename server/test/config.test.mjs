import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig, describeConfig, ConfigError } from '../src/config.ts';

const SERVER_DIR = path.resolve(import.meta.dirname, '..');

const base = { SESSION_SECRET: 'a-test-secret-that-is-long-enough-1234' };

function problemsOf(env) {
    try {
        loadConfig(env);
    } catch (err) {
        if (err instanceof ConfigError) return err.problems;
        throw err;
    }
    return [];
}

describe('loadConfig defaults', () => {
    it('builds a development config with sensible defaults from a minimal env', () => {
        const c = loadConfig(base);
        expect(c.nodeEnv).toBe('development');
        expect(c.isProduction).toBe(false);
        expect(c.port).toBe(3000);
        expect(c.timezone).toBe('America/Chicago');
        expect(c.sessionSecret).toBe(base.SESSION_SECRET);
        expect(c.db.kind).toBe('file');
        expect(c.db.url).toBe(`file:${path.join(SERVER_DIR, 'courier_logs.db')}`);
        expect(c.db.authToken).toBeUndefined();
        expect(c.files).toEqual({ enabled: false, s3: undefined });
        expect(c.legacyUsers.admin).toEqual({ user: undefined, pass: undefined });
    });

    it('resolves DB_FILE relative to the server dir, like the legacy server', () => {
        const c = loadConfig({ ...base, DB_FILE: 'test/.tmp/x/test.db' });
        expect(c.db.url).toBe(`file:${path.join(SERVER_DIR, 'test/.tmp/x/test.db')}`);
    });

    it('treats empty strings as unset', () => {
        const c = loadConfig({ ...base, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '   ', PORT: '' });
        expect(c.db.kind).toBe('file');
        expect(c.port).toBe(3000);
    });

    it('coerces PORT and parses truthy FILES_ENABLED spellings', () => {
        expect(loadConfig({ ...base, PORT: '8080' }).port).toBe(8080);
        for (const v of ['1', 'true', 'YES', 'on']) {
            expect(problemsOf({ ...base, FILES_ENABLED: v })).toEqual([
                'FILES_ENABLED is on but missing: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
            ]);
        }
        expect(loadConfig({ ...base, FILES_ENABLED: 'false' }).files.enabled).toBe(false);
    });

    it('passes the bootstrap account variables through', () => {
        const c = loadConfig({ ...base, ADMIN_USER: 'Admin', ADMIN_PASS: 'p', DRIVER2_USER: 'd2' });
        expect(c.legacyUsers.admin).toEqual({ user: 'Admin', pass: 'p' });
        expect(c.legacyUsers.driver2).toEqual({ user: 'd2', pass: undefined });
    });
});

describe('loadConfig validation', () => {
    it('requires SESSION_SECRET', () => {
        expect(problemsOf({})).toEqual([
            'SESSION_SECRET is required (a long random string; sessions are invalidated if it changes)',
        ]);
    });

    it('requires a long SESSION_SECRET in production', () => {
        const p = problemsOf({ NODE_ENV: 'production', SESSION_SECRET: 'short', TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 't' });
        expect(p).toEqual(['SESSION_SECRET must be at least 32 characters in production']);
    });

    it('requires TURSO_DATABASE_URL in production', () => {
        const p = problemsOf({ NODE_ENV: 'production', SESSION_SECRET: base.SESSION_SECRET });
        expect(p).toEqual(['TURSO_DATABASE_URL is required in production (a local file would be lost on redeploy)']);
    });

    it('requires TURSO_AUTH_TOKEN and a proper scheme when a Turso URL is set', () => {
        expect(problemsOf({ ...base, TURSO_DATABASE_URL: 'libsql://x.turso.io' })).toEqual([
            'TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set',
        ]);
        expect(problemsOf({ ...base, TURSO_DATABASE_URL: 'x.turso.io', TURSO_AUTH_TOKEN: 't' })).toEqual([
            'TURSO_DATABASE_URL must start with libsql://, https://, or wss://',
        ]);
        const c = loadConfig({ ...base, TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 't' });
        expect(c.db).toEqual({ kind: 'turso', url: 'libsql://x.turso.io', authToken: 't' });
    });

    it('rejects an invalid timezone, port and NODE_ENV', () => {
        expect(problemsOf({ ...base, APP_TIMEZONE: 'Mars/Olympus' })).toEqual([
            'APP_TIMEZONE "Mars/Olympus" is not a valid IANA timezone',
        ]);
        expect(problemsOf({ ...base, PORT: 'abc' })[0]).toMatch(/^PORT: /);
        expect(problemsOf({ ...base, PORT: '70000' })[0]).toMatch(/^PORT: /);
        expect(problemsOf({ ...base, NODE_ENV: 'staging' })[0]).toMatch(/^NODE_ENV: /);
    });

    it('reports every problem at once, not just the first', () => {
        const p = problemsOf({ NODE_ENV: 'production', APP_TIMEZONE: 'Nowhere', FILES_ENABLED: 'true', S3_BUCKET: 'b' });
        expect(p).toHaveLength(4);
        expect(p.join('\n')).toMatch(/SESSION_SECRET/);
        expect(p.join('\n')).toMatch(/APP_TIMEZONE/);
        expect(p.join('\n')).toMatch(/TURSO_DATABASE_URL/);
        expect(p.join('\n')).toMatch(/missing: S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    });

    it('the error message lists each problem on its own line', () => {
        expect(() => loadConfig({})).toThrow(/^Invalid configuration:\n  - SESSION_SECRET/);
    });

    it('builds the S3 block when files are enabled and complete', () => {
        const c = loadConfig({
            ...base, FILES_ENABLED: 'true', S3_BUCKET: 'izy-pod', S3_REGION: 'us-east-2',
            S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 'shh', S3_KMS_KEY_ID: 'kms-1',
        });
        expect(c.files).toEqual({
            enabled: true,
            s3: { bucket: 'izy-pod', region: 'us-east-2', accessKeyId: 'AKIA', secretAccessKey: 'shh', kmsKeyId: 'kms-1' },
        });
    });
});

describe('describeConfig', () => {
    it('never includes secrets', () => {
        const c = loadConfig({
            ...base, TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 'tok-secret',
            FILES_ENABLED: 'true', S3_BUCKET: 'izy-pod', S3_REGION: 'us-east-2', S3_ACCESS_KEY_ID: 'AKIA-secret', S3_SECRET_ACCESS_KEY: 'shh-secret',
            ADMIN_PASS: 'admin-secret',
        });
        const text = JSON.stringify(describeConfig(c));
        expect(text).not.toMatch(/secret/);
        expect(text).not.toMatch(/tok-/);
        expect(text).toMatch(/Turso \(remote\)/);
        expect(text).toMatch(/S3 izy-pod \(us-east-2\)/);
    });
});
