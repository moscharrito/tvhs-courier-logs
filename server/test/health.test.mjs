import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { requestId } from '../src/core/http/request.ts';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

const requestLogs = () => srv.logs.filter((l) => l.msg === 'request');

describe('GET /health', () => {
    it('is public and reports the database, migrations, uptime and version', async () => {
        const res = await srv.agent().get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
        expect(res.body.migrations).toBeGreaterThanOrEqual(5);
        expect(typeof res.body.uptimeSeconds).toBe('number');
        expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(JSON.stringify(res.body)).not.toMatch(/secret|token|password|file:/i);
    });

    it('answers 503 degraded when the database is unreachable', async () => {
        const client = srv.core.client;
        const original = client.execute.bind(client);
        client.execute = async () => { throw new Error('connection lost'); };
        try {
            const res = await srv.agent().get('/health');
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({ status: 'degraded', db: 'error', migrations: null });
        } finally {
            client.execute = original;
        }
        expect((await srv.agent().get('/health')).status).toBe(200);
    });

    it('is not redirected or caught by the shell fallback', async () => {
        const res = await srv.agent().get('/health').redirects(0);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/json/);
    });
});

describe('request id', () => {
    it('generates a UUID and echoes it on the response', async () => {
        const res = await srv.agent().get('/api/config');
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('honours a sane client-supplied X-Request-Id and rejects a hostile one', async () => {
        const ok = await srv.agent().get('/api/config').set('X-Request-Id', 'trace-abc-123456');
        expect(ok.headers['x-request-id']).toBe('trace-abc-123456');
        const bad = await srv.agent().get('/api/config').set('X-Request-Id', '<script>alert(1)</script>');
        expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestId('short')).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestId('a'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('structured request log', () => {
    it('writes one JSON record per request with method, path, status, duration, actor and id, but never the query string', async () => {
        const admin = await srv.login('admin');
        const before = requestLogs().length;
        const res = await admin.get('/api/audit?username=secret.person&limit=1');
        const line = requestLogs().slice(before).find((l) => l.path === '/api/audit');
        expect(line).toBeTruthy();
        expect(line).toMatchObject({ level: 'info', msg: 'request', method: 'GET', path: '/api/audit', status: 200, user: 'admin', app: 'izy-ops', env: 'test' });
        expect(line.req).toBe(res.headers['x-request-id']);
        expect(typeof line.ms).toBe('number');
        expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(JSON.stringify(line)).not.toContain('secret.person');
    });

    it('logs the full path of a mounted module route, not the path inside the router', async () => {
        // Express rewrites req.url as it descends into a mounted router, so a
        // path read on finish would say "/" for every module endpoint.
        const admin = await srv.login('admin');
        const before = requestLogs().length;
        await admin.get('/api/projects/uh/uh/sites');
        const line = requestLogs().slice(before).find((l) => l.method === 'GET' && l.status === 200 && l.path.includes('/uh/sites'));
        expect(line, 'no log line carried the full mounted path').toBeTruthy();
        expect(line.path).toBe('/api/projects/uh/uh/sites');
    });

    it('logs 4xx as warn, 5xx as error, and /health at debug', async () => {
        await srv.agent().get('/api/session');           // 401
        await srv.agent().get('/api/_test/error');       // 500
        await srv.agent().get('/health');
        const lines = requestLogs();
        expect(lines.find((l) => l.path === '/api/session' && l.status === 401).level).toBe('warn');
        expect(lines.find((l) => l.path === '/api/_test/error').level).toBe('error');
        expect(lines.find((l) => l.path === '/health').level).toBe('debug');
    });
});
