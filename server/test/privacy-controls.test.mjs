/* The control inventory has to stay true.
 *
 * Ticket 4.7. docs/privacy-controls.md says which file implements each
 * control and which test proves it. A document like that is worth exactly as
 * much as its weakest citation, and it rots the first time somebody renames a
 * module: the prose still reads convincingly, and every path in it points at
 * nothing.
 *
 * So this file reads the document and checks it. Every file path it cites has
 * to exist, and the numbers a privacy programme would quote back at us have
 * to match the code they are quoted from. A session timeout that is changed
 * in one place and left in the other is exactly the kind of discrepancy an
 * auditor finds and we would not.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_DIR } from './helpers/server.mjs';
import { lifetimesFor } from '../src/core/auth/sessions.ts';
import { LIMITS } from '../src/core/auth/throttle.ts';
import { RETENTION } from '../src/core/retention/policy.ts';
import { READ_URL_SECONDS, WRITE_URL_SECONDS, DELETE_URL_SECONDS } from '../src/core/files/storage.ts';
import { CLIENT_EVENT_RETENTION_DAYS } from '../src/core/http/idempotency.ts';

const REPO = path.resolve(SERVER_DIR, '..');
const DOC = path.join(REPO, 'docs', 'privacy-controls.md');
const text = fs.readFileSync(DOC, 'utf8');
/* The document is hard-wrapped, so a sentence a test looks for is usually
 * split across a line break. Every prose assertion below runs against this
 * flattened copy rather than being written with \s+ in it. */
const prose = text.replace(/\s+/g, ' ');

/* Every server/, web/ or docs/ path the document mentions, including the ones
 * inside prose rather than in a table cell. Trailing punctuation is stripped;
 * a trailing slash means a directory. */
function citedPaths(markdown) {
    const found = new Set();
    const pattern = /`((?:server|web|docs)\/[A-Za-z0-9_./-]+)`/g;
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
        found.add(match[1].replace(/[.,]$/, ''));
    }
    return [...found];
}

describe('the control inventory', () => {
    it('cites files that exist', () => {
        const missing = citedPaths(text).filter((p) => !fs.existsSync(path.join(REPO, p)));
        expect(missing, 'docs/privacy-controls.md cites files that are not there any more').toEqual([]);
    });

    it('cites at least one test for most of what it claims', () => {
        /* Not every row can have one: a BAA is not a unit test. But a document
           whose evidence column is mostly prose is a document nobody checked. */
        const testFiles = citedPaths(text).filter((p) => p.startsWith('server/test/'));
        expect(testFiles.length).toBeGreaterThan(15);
        for (const file of testFiles) {
            expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
        }
    });

    it('names the gaps rather than implying everything is done', () => {
        /* The failure mode for a document like this is quiet optimism. These
           are the four things that are actually missing and that a reader has
           to see: if somebody deletes these sections, this test asks why. */
        expect(prose).toMatch(/There is no written privacy and security program yet/);
        expect(prose).toMatch(/BAAs with Render, Turso and AWS/);
        expect(prose).toMatch(/Breach notification/);
        expect(prose).toMatch(/A second administrator/);
        /* Ticket 5.10 removed the second factor. The gap it leaves has to be
           named in the document rather than quietly stop being mentioned. */
        expect(prose).toMatch(/A decision on authentication strength/);
    });

    it('says plainly that it is not a legal assessment', () => {
        expect(prose).toMatch(/engineering inventory and not a legal assessment/);
    });
});

describe('the numbers a programme would quote', () => {
    /* Each of these appears in the document as a fact about the system. They
       are asserted here against the code they describe, so the two cannot
       drift apart silently. */

    it('session timeouts', () => {
        const cfg = {
            staffIdleMinutes: 30, staffAbsoluteMinutes: 12 * 60,
            courierIdleMinutes: 12 * 60, courierAbsoluteMinutes: 30 * 24 * 60,
        };
        expect(lifetimesFor('staff', cfg)).toEqual({ idleMinutes: 30, absoluteMinutes: 720 });
        expect(lifetimesFor('driver', cfg)).toEqual({ idleMinutes: 720, absoluteMinutes: 43200 });
        expect(prose).toMatch(/Staff: 30 minutes idle, 12 hours absolute/);
        expect(prose).toMatch(/Couriers: 12 hours idle, 30 days absolute/);
    });

    it('failed-attempt limits', () => {
        expect(LIMITS.password.maxAttempts).toBe(10);
        expect(LIMITS.password.windowMs).toBe(15 * 60 * 1000);
        expect(LIMITS.passwordByAddress.maxAttempts).toBe(50);
        expect(LIMITS.pin.maxAttempts).toBe(5);
        expect(LIMITS.pin.windowMs).toBe(10 * 60 * 1000);
        expect(prose).toMatch(/10 password attempts per account and 50 per address in 15 minutes, 5 PIN attempts per account in 10/);
    });

    it('signed URL lifetimes', () => {
        expect(READ_URL_SECONDS).toBe(5 * 60);
        expect(WRITE_URL_SECONDS).toBe(15 * 60);
        expect(DELETE_URL_SECONDS).toBe(60);
        expect(prose).toMatch(/5 minutes to read, 15 to write, 60 seconds to delete/);
    });

    it('the one retention period anybody has decided', () => {
        expect(CLIENT_EVENT_RETENTION_DAYS).toBe(7);
        expect(RETENTION.client_events.days).toBe(7);
        expect(prose).toMatch(/kept 7 days and swept automatically/);
    });

    it('and the ones nobody has', () => {
        /* If somebody quietly marks a category decided, the document stops
           being true and this is where it shows. */
        for (const category of ['delivery_records', 'proof_of_delivery_files', 'signatures', 'invoices']) {
            expect(RETENTION[category].decided, category).toBe(false);
        }
        expect(prose).toMatch(/retention periods themselves are undecided/);
    });

    it('the audit trail is never purged, in the policy and in the document', () => {
        expect(RETENTION.audit_events.purgeable).toBe(false);
        expect(prose).toMatch(/The audit trail is never purged/);
    });
});
