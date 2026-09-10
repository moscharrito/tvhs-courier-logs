import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempDb, removeDir } from './helpers/server.mjs';

// A fake built shell so the test does not depend on `npm run build -w web`.
let distDir;
let srv;
beforeAll(async () => {
    const t = tempDb('dist-');
    distDir = t.dir;
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Izy Ops</title><div id="root"></div>');
    fs.writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log("shell")');
    process.env.WEB_DIST = distDir;
    srv = await startServer();
});
afterAll(async () => {
    await srv.stop();
    delete process.env.WEB_DIST;
    await removeDir(distDir);
});

describe('frontend shell at /', () => {
    it('serves index.html at / and for any client-side route, never cached', async () => {
        for (const p of ['/', '/users', '/projects/tvhs/tvhs', '/audit?username=x']) {
            const res = await srv.agent().get(p);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/html/);
            expect(res.text).toContain('<div id="root">');
            expect(res.headers['cache-control']).toBe('no-cache');
        }
    });

    it('serves built assets as files', async () => {
        const res = await srv.agent().get('/assets/app-abc123.js');
        expect(res.status).toBe(200);
        expect(res.text).toContain('shell');
    });

    it('does not swallow API 404s or non-GET requests', async () => {
        expect((await srv.agent().get('/api/does-not-exist')).status).toBe(404);
        expect((await srv.agent().post('/users').send({})).status).toBe(404);
    });
});

describe('legacy TVHS app at /legacy', () => {
    it('serves the original index.html, script and stylesheet', async () => {
        const index = await srv.agent().get('/legacy/index.html');
        expect(index.status).toBe(200);
        expect(index.text).toContain('id="loginScreen"');
        expect(index.text).toContain('src="app.js"');
        expect((await srv.agent().get('/legacy/app.js')).status).toBe(200);
        expect((await srv.agent().get('/legacy/style.css')).status).toBe(200);
    });

    it('the old root no longer serves the legacy app', async () => {
        const res = await srv.agent().get('/');
        expect(res.text).not.toContain('id="loginScreen"');
    });
});
