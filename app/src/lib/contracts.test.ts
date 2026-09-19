/* Choosing a contract before signing in.
 *
 * What matters here is the wrong-contract case. It has to be helpful, which
 * means naming what the driver DOES drive for, and it has to stay quiet
 * about everything else, which means never confirming anything about the
 * contract they picked by mistake.
 */

import { describe, it, expect } from 'vitest';
import { CONTRACTS, contractByCode, outcomeFor } from './contracts';

const uh = { code: 'uh', name: 'UH Pharmacy Courier' };
const tvhs = { code: 'tvhs', name: 'TVHS RMD Courier' };

describe('the list', () => {
    it('is both contracts, UH first', () => {
        /* UH first because it is the contract being onboarded onto, and a
           list that makes the common case the second tap is a list that
           gets mis-tapped. */
        expect(CONTRACTS.map((c) => c.code)).toEqual(['uh', 'tvhs']);
    });

    it('is fixed rather than fetched', () => {
        /* An unauthenticated endpoint listing Izy's contracts enumerates
           Izy's contracts. Ticket 6.1 refused that for the signup form and
           this must not reintroduce it, so the list is a constant. */
        expect(contractByCode('uh')?.name).toBe('UH Pharmacy Courier');
        expect(contractByCode('nope')).toBeUndefined();
    });
});

describe('a driver who picked the right one', () => {
    it('is let through', () => {
        expect(outcomeFor('uh', [uh])).toEqual({ kind: 'ok', code: 'uh' });
    });

    it('is let through when they drive for both', () => {
        expect(outcomeFor('tvhs', [uh, tvhs])).toEqual({ kind: 'ok', code: 'tvhs' });
    });
});

describe('a driver who picked the wrong one', () => {
    it('is told which contract they actually drive for', () => {
        const out = outcomeFor('tvhs', [uh]);
        if (out.kind === 'ok') throw new Error('expected a refusal');
        expect(out.message).toMatch(/does not drive for TVHS RMD Courier/);
        expect(out.message).toMatch(/You drive for UH Pharmacy Courier/);
    });

    it('says nothing about the contract they picked beyond refusing it', () => {
        /* The refusal must not become a way to learn about a contract you
           are not on. Naming it back is fine, they typed it; what must not
           appear is anything ABOUT it: how many drive it, which pharmacies
           are on it, whether it is running at all.

           An earlier version of this test banned the words "courier" and
           "pharmacy" outright and failed, because both contracts have those
           words in their names. The property is about facts, not vocabulary. */
        const out = outcomeFor('tvhs', [uh]);
        if (out.kind === 'ok') throw new Error('expected a refusal');
        /* No counts of anything. */
        expect(out.message).not.toMatch(/\d+/);
        /* No statement about who else is on it. */
        expect(out.message).not.toMatch(/other drivers|already|currently driving|assigned to/i);
        /* No sites, runs or deliveries. */
        expect(out.message).not.toMatch(/(site|run|route|delivery|deliveries|stop)s?/i);
        /* And the only contract it makes a claim about is the driver's own. */
        expect(out.message).toMatch(/You drive for UH Pharmacy Courier/);
    });

    it('lists both when somebody drives two and picked a third', () => {
        const out = outcomeFor('unknown-contract', [uh, tvhs]);
        if (out.kind === 'ok') throw new Error('expected a refusal');
        expect(out.message).toMatch(/UH Pharmacy Courier and TVHS RMD Courier/);
    });

    it('does not crash on a stale stored choice', () => {
        /* The chosen code is remembered on the phone, and a contract could
           be renamed or retired between one sign-in and the next. */
        const out = outcomeFor('retired-contract', [uh]);
        if (out.kind === 'ok') throw new Error('expected a refusal');
        expect(out.kind).toBe('wrongContract');
        expect(out.message).toMatch(/retired-contract/);
    });
});

describe('an applicant who belongs to nothing', () => {
    it('is told we are still checking, not that they are denied', () => {
        /* Since the DoorDash change in 6.1 this is the ordinary state of a
           real person waiting on us. A locked door is the wrong metaphor and
           the wrong sentence. */
        const out = outcomeFor('uh', []);
        if (out.kind === 'ok') throw new Error('expected a refusal');
        expect(out.kind).toBe('noMembership');
        expect(out.message).toMatch(/still checking your onboarding/);
        expect(out.message).not.toMatch(/denied|refused|not allowed|unauthori/i);
    });
});
