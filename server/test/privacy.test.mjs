/* GET /privacy.
 *
 * Both app stores require a privacy policy at a URL a reviewer can open
 * without an account. The failures worth guarding are not cosmetic: a page
 * behind the session wall, a page that 404s after a deploy moved the file,
 * and a renderer that silently drops a paragraph of a legal document.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { startServer } from './helpers/server.mjs';
import {
    POLICY_FILE, createPrivacyRouter, privacyPage, renderMarkdown,
} from '../src/core/http/privacy.ts';

let srv;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.stop(); });

describe('the page a store reviewer opens', () => {
    it('is served without signing in', async () => {
        /* A privacy policy behind a login is a privacy policy a reviewer
           reports as missing. srv.agent() carries no session. */
        const res = await srv.agent().get('/privacy');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('is the real policy, not a placeholder', async () => {
        const res = await srv.agent().get('/privacy');
        expect(res.text).toContain('Izy Global Services');
        expect(res.text).toContain('contracts@izyglobalservices.com');
        /* The section both stores actually scrutinise. */
        expect(res.text).toMatch(/only while on shift/i);
    });

    it('is a complete HTML document, not a fragment', async () => {
        const res = await srv.agent().get('/privacy');
        expect(res.text.startsWith('<!doctype html>')).toBe(true);
        expect(res.text).toContain('<meta name="viewport"');
        expect(res.text).toContain('<title>');
    });

    it('can be cached, but not for so long that a correction waits a day', async () => {
        const res = await srv.agent().get('/privacy');
        const cache = String(res.headers['cache-control'] ?? '');
        expect(cache).toMatch(/public/);
        const seconds = Number(/max-age=(\d+)/.exec(cache)?.[1] ?? '0');
        expect(seconds).toBeGreaterThan(0);
        expect(seconds).toBeLessThanOrEqual(86_400);
    });
});

describe('the file it renders', () => {
    it('is the one in the repository, resolved without depending on the working directory', () => {
        /* The path is built from __dirname rather than cwd, because Render
           starts the process from the repository root and a developer starts
           it from server/. A cwd-relative path works in exactly one of
           those. */
        expect(() => readFileSync(POLICY_FILE, 'utf8')).not.toThrow();
        expect(POLICY_FILE.replace(/\\/g, '/')).toMatch(/\/docs\/privacy-policy\.md$/);
    });

    it('says it is unavailable rather than missing when it cannot be read', async () => {
        /* 503 and not 404: the policy exists, this process cannot read it,
           and a 404 tells a reviewer the page is gone rather than broken. */
        const app = express();
        app.use(createPrivacyRouter({ read: () => { throw new Error('no such file'); } }));
        const res = await request(app).get('/privacy');
        expect(res.status).toBe(503);
        expect(res.text).toContain('contracts@izyglobalservices.com');
    });
});

describe('the renderer', () => {
    it('turns the constructs the policy actually uses into HTML', () => {
        const html = renderMarkdown([
            '# Title',
            '',
            'A paragraph with **bold** and `code`.',
            '',
            '- one',
            '- two',
            '',
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
            '',
            '---',
        ].join('\n'));

        expect(html).toContain('<h1>Title</h1>');
        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<code>code</code>');
        expect(html).toContain('<li>one</li>');
        expect(html).toContain('<th>A</th>');
        expect(html).toContain('<td>1</td>');
        expect(html).toContain('<hr>');
        /* The divider row is structure, not content. */
        expect(html).not.toContain('---|');
    });

    it('escapes everything before formatting it', () => {
        /* The content is ours and that is not a reason to interpolate it
           raw. A file edited by hand must never be able to put script into a
           page the company publishes under its own name. */
        const html = renderMarkdown('A <script>alert(1)</script> and R&D and "quotes".');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('R&amp;D');
    });

    it('keeps a table with an empty header row from rendering a blank band', () => {
        /* The checklist at the foot of the policy is a two-column table with
           no header. An empty <thead> draws an empty row above it. */
        const html = renderMarkdown(['| | |', '|---|---|', '| Thing | Why |'].join('\n'));
        expect(html).not.toContain('<thead>');
        expect(html).toContain('<td>Thing</td>');
    });

    it('joins a bullet that wraps onto an indented line', () => {
        const html = renderMarkdown('- a bullet that\n  wraps onto the next line\n');
        expect(html).toContain('<li>a bullet that wraps onto the next line</li>');
    });

    it('leaves fenced blocks alone', () => {
        const html = renderMarkdown('```\nIzy Global Services LLC\n+1 (832) 715 8986\n```');
        expect(html).toContain('<pre><code>Izy Global Services LLC\n+1 (832) 715 8986</code></pre>');
        /* Not turned into a paragraph, and the address not reflowed. */
        expect(html).not.toContain('<p>Izy Global Services LLC');
    });

    it('loses nothing from the real policy', () => {
        /* The failure that matters for a legal document is a renderer that
           silently drops a clause. Checked against the actual file rather
           than a fixture, so a future edit using a construct this does not
           handle shows up here. */
        const markdown = readFileSync(POLICY_FILE, 'utf8');
        const html = privacyPage(markdown);

        for (const phrase of [
            'Izy Global Services LLC',
            'Only while on shift',
            'No patient information is collected by the app from a courier',
            'We do not sell personal information',
            'contracts@izyglobalservices.com',
        ]) {
            expect(html, `the policy says "${phrase}" and the page does not`).toContain(phrase);
        }

        /* Every heading in the file reaches the page. */
        const headings = markdown.split('\n').filter((l) => /^#{1,4}\s+\S/.test(l)).length;
        const rendered = (html.match(/<h[1-4]>/g) ?? []).length;
        expect(rendered).toBe(headings);
    });
});
