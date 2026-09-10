import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './helpers/server.mjs';
import { statusOf, exposedMessage, createErrorHandler } from '../src/core/http/errors.ts';
import { Logger } from '../src/core/http/logger.ts';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

const errorLogs = () => srv.logs.filter((l) => l.msg === 'request error');

describe('central error handler (integration, test environment)', () => {
    it('answers JSON with a generic message and the request id for an unexpected error, and logs the stack', async () => {
        const res = await srv.agent().get('/api/_test/error').set('X-Request-Id', 'err-trace-0001');
        expect(res.status).toBe(500);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body.error).toBe('Internal server error');
        expect(res.body.requestId).toBe('err-trace-0001');
        expect(res.text).not.toMatch(/at .*legacy\.ts/); // no stack in the body
        // Outside production the message is included as detail for convenience.
        expect(res.body.detail).toBe('synthetic failure with secret detail');

        const line = errorLogs().find((l) => l.req === 'err-trace-0001');
        expect(line).toMatchObject({ level: 'error', status: 500, path: '/api/_test/error', errName: 'Error', errMessage: 'synthetic failure with secret detail' });
        expect(line.stack).toMatch(/synthetic failure/);
    });

    it('shows the message of an error marked expose with a 4xx status', async () => {
        const res = await srv.agent().get('/api/_test/exposed');
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ error: 'You may see this' });
        expect(res.body).not.toHaveProperty('detail');
    });

    it('turns malformed JSON into a 400 with a safe message', async () => {
        const res = await srv.agent().post('/api/login').set('Content-Type', 'application/json').send('{"username": "x", ');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Malformed JSON body');
        expect(res.body.requestId).toBeTruthy();
    });

    it('answers unknown API paths with JSON 404 instead of the shell or an HTML page', async () => {
        const res = await srv.agent().get('/api/nothing/here');
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toMatchObject({ error: 'Not found' });
        expect(res.body.requestId).toBeTruthy();
        expect((await srv.agent().post('/api/nothing').send({})).status).toBe(404);
    });
});

describe('error handler (unit, production behaviour)', () => {
    function run(err, { isProduction }) {
        const lines = [];
        const logger = new Logger({ level: 'debug', format: 'json' });
        logger.setSink((r) => lines.push(r));
        const handler = createErrorHandler({ logger, isProduction });
        const req = { id: 'req-1', method: 'GET', path: '/api/x', log: logger };
        let status = 0; let body = null;
        const res = {
            headersSent: false,
            status(s) { status = s; return this; },
            json(b) { body = b; },
            end() {},
        };
        handler(err, req, res, () => {});
        return { status, body, lines };
    }

    it('never sends the message, detail, or stack of a 500 in production', () => {
        const err = new Error('database password is hunter2');
        const { status, body, lines } = run(err, { isProduction: true });
        expect(status).toBe(500);
        expect(body).toEqual({ error: 'Internal server error', requestId: 'req-1' });
        expect(JSON.stringify(body)).not.toContain('hunter2');
        // but the log has everything
        expect(lines[0]).toMatchObject({ level: 'error', msg: 'request error', status: 500, errMessage: 'database password is hunter2' });
        expect(lines[0].stack).toContain('hunter2');
    });

    it('still shows exposable 4xx messages in production', () => {
        const err = Object.assign(new Error('Email already used'), { status: 409, expose: true });
        const { status, body, lines } = run(err, { isProduction: true });
        expect(status).toBe(409);
        expect(body).toEqual({ error: 'Email already used', requestId: 'req-1' });
        expect(lines[0].level).toBe('warn');
    });

    it('classifies statuses and messages', () => {
        expect(statusOf(new Error('x'))).toBe(500);
        expect(statusOf({ status: 404 })).toBe(404);
        expect(statusOf({ statusCode: 418 })).toBe(418);
        expect(statusOf({ status: 999 })).toBe(500);
        expect(statusOf({ status: 200 })).toBe(500);
        expect(exposedMessage(new Error('internal'), 500)).toBeNull();
        expect(exposedMessage(Object.assign(new Error('bad json'), { type: 'entity.parse.failed' }), 400)).toBe('Malformed JSON body');
        expect(exposedMessage(Object.assign(new Error('big'), { type: 'entity.too.large' }), 413)).toBe('Request body too large');
        expect(exposedMessage(Object.assign(new Error('nope'), { status: 400 }), 400)).toBe('nope');
    });

    it('does not double-send when headers already went out', () => {
        const lines = [];
        const logger = new Logger({ level: 'debug', format: 'json' });
        logger.setSink((r) => lines.push(r));
        const handler = createErrorHandler({ logger, isProduction: true });
        let ended = false; let jsonCalled = false;
        handler(new Error('late'), { id: 'r', method: 'GET', path: '/api/x', log: logger }, { headersSent: true, end() { ended = true; }, status() { return this; }, json() { jsonCalled = true; } }, () => {});
        expect(ended).toBe(true);
        expect(jsonCalled).toBe(false);
    });
});

describe('logger', () => {
    it('filters by level, formats json and pretty, and children inherit fields and sink', () => {
        const lines = [];
        const json = new Logger({ level: 'info', format: 'json', now: () => new Date('2026-09-10T12:00:00Z') }, { app: 'test' });
        json.setSink((r, line) => lines.push(line));
        json.debug('hidden');
        json.child({ req: 'abc' }).info('hello', { n: 1 });
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual({ level: 'info', time: '2026-09-10T12:00:00.000Z', msg: 'hello', app: 'test', req: 'abc', n: 1 });

        const prettyLines = [];
        const pretty = new Logger({ level: 'debug', format: 'pretty', now: () => new Date('2026-09-10T12:00:00Z') });
        pretty.setSink((r, line) => prettyLines.push(line));
        pretty.warn('careful', { path: '/x', ms: 12.5 });
        expect(prettyLines[0]).toBe('12:00:00 WARN  careful  path=/x ms=12.5');
    });
});
