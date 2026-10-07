/* The decisions that live in render.yaml, and must stay there.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A TEST ABOUT A DEPLOYMENT FILE.
 *
 * Two values in this system are decisions rather than configuration, and both
 * of them spent weeks being wrong because they were environment variables
 * nobody owned.
 *
 * RETENTION_LOCATION_TRACE_DAYS decides how long an identified driver's
 * minute-by-minute movements are kept. It sat on a checklist as "somebody
 * must set this" for weeks, and while it was unset the server collected no
 * position at all, so the feature dispatch runs on did nothing.
 *
 * TRUST_PROXY decides which address every session row, audit entry and
 * throttle bucket is keyed on. It said one hop while Cloudflare sat in front
 * of Render, so every one of those recorded a Cloudflare edge instead of a
 * person, and the per-address throttle counted everybody behind one edge as
 * the same caller.
 *
 * A blueprint value is re-applied on every sync, so a number typed into the
 * Render dashboard is reverted the next time this file is applied. That makes
 * the dashboard the wrong place for either of them and this file the right
 * one: a diff, a reviewer, and the argument for the number sitting beside it.
 *
 * So this asserts they are declared with a value rather than left to a web
 * form. It is a cheap test for a failure that is expensive and silent: a
 * deploy where somebody "tidied" a line and nobody noticed until a courier's
 * track was not there, or an address was Cloudflare's again.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BLUEPRINT = path.join(import.meta.dirname, '..', '..', 'render.yaml');
const yaml = fs.readFileSync(BLUEPRINT, 'utf8');

/** The declared value for a key, or null when it is sync:false or absent. */
function declaredValue(key) {
    const lines = yaml.split('\n');
    const at = lines.findIndex((l) => l.trim() === `- key: ${key}`);
    if (at === -1) return null;
    const next = (lines[at + 1] ?? '').trim();
    const m = /^value:\s*"?([^"]*)"?$/.exec(next);
    return m ? m[1] : null;
}

describe('the decisions that must not live in a dashboard', () => {
    it('keeps a courier track for a number of days the file states', () => {
        /* Seven. The live need is hours and the evidential need is met by the
           custody events and the proof of delivery, which are kept for years;
           every extra day a breadcrumb trail is held is a day it can be
           subpoenaed, breached or used for something nobody agreed to. */
        const days = declaredValue('RETENTION_LOCATION_TRACE_DAYS');
        expect(days, 'render.yaml must declare the retention period').not.toBeNull();
        expect(Number(days)).toBeGreaterThanOrEqual(1);
        /* An upper bound rather than an exact number, so changing the policy
           is a one-line commit and not a fight with a test. Anything above a
           month is not "days, not years" any more and should be argued for. */
        expect(Number(days), 'a track kept longer than a month wants a reason').toBeLessThanOrEqual(31);
    });

    it('trusts the hops that are actually in front of this service', () => {
        /* Client, Cloudflare, Render, the process. Two. Observed on
           production rather than reasoned: a portal session recorded
           172.71.146.35, inside Cloudflare's range, while this said one. */
        const hops = declaredValue('TRUST_PROXY');
        expect(hops, 'render.yaml must declare the hop count').not.toBeNull();
        expect(Number(hops)).toBe(2);
    });

    it('states the reason beside each of them, not only the number', () => {
        /* The point of moving these out of a dashboard. A number with no
           argument attached is a number the next person changes. */
        expect(yaml).toMatch(/RETENTION_LOCATION_TRACE_DAYS/);
        expect(yaml, 'say why the retention period is what it is')
            .toMatch(/subpoenaed, breached/);
        expect(yaml, 'say why the hop count is what it is')
            .toMatch(/Cloudflare/);
    });

    it('still refuses to collect a track when nothing has been decided', () => {
        /* The local case, and the safe direction. A checkout with no
           blueprint behind it has no agreed period, so core/tracking takes no
           point at all rather than collecting with no expiry. */
        expect(process.env['RETENTION_LOCATION_TRACE_DAYS'] ?? '').toBe('');
    });
});
