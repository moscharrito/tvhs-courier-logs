/* GET /privacy. Public, no session.
 *
 * Both app stores require a privacy policy at a URL that is reachable without
 * signing in, and that stays reachable for as long as the app is listed. This
 * is that URL.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE SOURCE, WHICH IS THE WHOLE POINT.
 *
 * The policy is docs/privacy-policy.md and this renders it. The alternative
 * was an HTML copy beside the markdown, and a privacy policy that exists
 * twice is a privacy policy where one of them is wrong: the published claim
 * and the repository's claim drift, and the published one is the one that
 * matters legally.
 *
 * It is read from disk rather than compiled in, so correcting the policy is a
 * commit rather than a release. Read once and cached, because it cannot
 * change under a running process and a store reviewer refreshing the page
 * should not cost a file read each time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A DELIBERATELY NARROW MARKDOWN RENDERER, AND NOT A DEPENDENCY.
 *
 * This server carries seven production dependencies on purpose. A markdown
 * library is a large amount of code, most of it parsing constructs this
 * document does not contain, to render one page that changes a few times a
 * year.
 *
 * So this handles exactly what the policy uses, counted from the file:
 * headings, horizontal rules, bullet lists, tables, fenced code, bold and
 * inline code. There are no links, no images and no ordered lists in it. If
 * somebody adds one, it renders as literal text rather than silently
 * disappearing, which is the right failure for a legal document: visibly
 * wrong beats invisibly missing.
 *
 * EVERYTHING IS ESCAPED FIRST. The content is ours and this is still not a
 * reason to interpolate it raw. A policy that one day quotes an address
 * containing an ampersand should not produce broken markup, and a file that
 * is edited by hand should never be able to inject script into a page the
 * company publishes under its own name.
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* src/core/http and dist/core/http are both three levels below server/, so
   four resolves to the repository root from either. The same shape as
   MIGRATIONS_FOLDER in db/migrate.ts, for the same reason: a path built from
   the current working directory breaks the moment somebody starts the
   process from somewhere else. */
export const POLICY_FILE = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'privacy-policy.md');

const escapeHtml = (s: string): string => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Bold and inline code, applied to text that is already escaped. */
const inline = (s: string): string => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/** A table row's cells, without the leading and trailing pipes. */
const cells = (line: string): string[] => line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

/** True for the `|---|---|` line under a table's header.
 *
 *  It must contain a hyphen. Without that requirement `| | |`, which is how
 *  the policy writes a table with no header, matches this too: the row is
 *  dropped as structure, the first row of real content is promoted to the
 *  header, and the checklist at the foot of the policy renders with "Thing"
 *  and "Why" as column titles. Found by the test for exactly that table. */
const isDivider = (line: string): boolean => /^\s*\|[\s|:-]*-[\s|:-]*\|\s*$/.test(line);

/**
 * The policy's markdown as HTML. Exported for the tests, which is why it
 * takes the text rather than reading the file.
 */
export function renderMarkdown(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];

    let paragraph: string[] = [];
    const closeParagraph = () => {
        if (paragraph.length > 0) {
            out.push(`<p>${inline(paragraph.join(' '))}</p>`);
            paragraph = [];
        }
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;

        if (line.startsWith('```')) {
            closeParagraph();
            const block: string[] = [];
            i += 1;
            while (i < lines.length && !lines[i]!.startsWith('```')) {
                block.push(lines[i]!);
                i += 1;
            }
            out.push(`<pre><code>${escapeHtml(block.join('\n'))}</code></pre>`);
            continue;
        }

        if (/^\s*\|/.test(line)) {
            closeParagraph();
            const rows: string[][] = [];
            while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
                if (!isDivider(lines[i]!)) rows.push(cells(lines[i]!));
                i += 1;
            }
            i -= 1;
            if (rows.length > 0) {
                const [head, ...body] = rows;
                /* The policy has a two-column table with an empty header row.
                   Rendering an empty <thead> puts a blank band above it, so a
                   header whose cells are all empty is dropped. */
                /* Markdown always has a header row syntactically, so row
                   zero is always it. An empty one is a deliberate choice to
                   show no column titles, and it is dropped rather than
                   rendered as a blank band above the table. */
                const headed = head!.some((c) => c !== '');
                out.push('<table>');
                if (headed) out.push(`<thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`);
                out.push(`<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`);
                out.push('</table>');
            }
            continue;
        }

        if (/^-\s+/.test(line)) {
            closeParagraph();
            const items: string[] = [];
            while (i < lines.length && /^-\s+/.test(lines[i]!)) {
                /* A wrapped bullet continues on an indented line. */
                let text = lines[i]!.replace(/^-\s+/, '');
                while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) {
                    i += 1;
                    text += ` ${lines[i]!.trim()}`;
                }
                items.push(`<li>${inline(text)}</li>`);
                i += 1;
            }
            i -= 1;
            out.push(`<ul>${items.join('')}</ul>`);
            continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            closeParagraph();
            const level = heading[1]!.length;
            out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
            continue;
        }

        if (/^---+\s*$/.test(line)) {
            closeParagraph();
            out.push('<hr>');
            continue;
        }

        if (line.trim() === '') {
            closeParagraph();
            continue;
        }

        paragraph.push(line.trim());
    }

    closeParagraph();
    return out.join('\n');
}

/* Inline, because the CSP allows inline styles and a stylesheet would be a
 * second request for a page that is read once. Deliberately plain: this is a
 * legal document and a reviewer should be able to read it on a phone. */
const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0 auto; padding: 2rem 1rem 4rem; max-width: 46rem; line-height: 1.6;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 1.9rem; line-height: 1.25; }
h2 { font-size: 1.35rem; margin-top: 2.5rem; }
h3 { font-size: 1.1rem; margin-top: 2rem; }
hr { border: 0; border-top: 1px solid currentColor; opacity: .2; margin: 2.5rem 0; }
table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; }
th, td { border: 1px solid currentColor; padding: .5rem .6rem; text-align: left;
  vertical-align: top; }
th { font-weight: 600; }
pre { padding: .85rem 1rem; overflow-x: auto; border: 1px solid currentColor; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { font-size: .9rem; } code { font-size: .95em; }
ul { padding-left: 1.2rem; } li { margin: .35rem 0; }
@media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
`.trim();

/** The whole page. Exported so a test can assert the shell, not only the body. */
export function privacyPage(markdown: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy: Izy Courier</title>
<style>${STYLE}</style>
</head>
<body>
${renderMarkdown(markdown)}
</body>
</html>`;
}

export interface PrivacyDeps {
    /** Overridable for tests. Defaults to reading POLICY_FILE. */
    read?: () => string;
}

export function createPrivacyRouter({ read }: PrivacyDeps = {}): Router {
    const router = Router();
    const load = read ?? (() => readFileSync(POLICY_FILE, 'utf8'));

    /* Rendered once. The file cannot change under a running process, and a
       reviewer refreshing should not cost a read and a parse each time. The
       failure is cached too, deliberately: a missing file is a deployment
       fault, and retrying it on every request would turn one fault into a
       stream of them in the log. */
    let page: string | null = null;
    let failed = false;

    router.get('/privacy', (_req: Request, res: Response) => {
        if (page === null && !failed) {
            try {
                page = privacyPage(load());
            } catch {
                failed = true;
            }
        }
        if (page === null) {
            /* 503 and not 404: the policy exists, this process cannot read
               it, and a 404 would tell a store reviewer the page is gone
               rather than that something is broken. */
            res.status(503).type('text/plain').send(
                'The privacy policy is temporarily unavailable. '
                + 'Please contact contracts@izyglobalservices.com.',
            );
            return;
        }
        /* Cached by the CDN for an hour. Long enough to matter, short enough
           that a correction to a legal document is live the same morning. */
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.type('html').send(page);
    });

    return router;
}
