/* The sentence a courier is given at a door, and the flags on a list.
 *
 * Pure, and worth pinning on its own because the whole reason modules/uh/
 * handling.ts exists is that five surfaces have to say the SAME thing. The
 * rule a courier is told at a door and the rule printed on the proof of
 * delivery afterwards must be the same words, or the proof does not prove
 * what happened -- which is the failure pod-photos.ts was written to stop
 * happening to photographs.
 */

import { describe, it, expect } from 'vitest';
import {
    presentHandling, signingInstruction, handlingFlags, isNamedSigner, ruleOf, handlingColumns,
} from '../src/modules/uh/handling.ts';

const row = (over = {}) => presentHandling({
    signature_required: 1,
    signature_rule: 'anyone',
    authorised_signers: '',
    refrigerated: 0,
    controlled: 0,
    id_required: 0,
    ...over,
});

describe('reading the row', () => {
    it('turns the columns into booleans and a rule', () => {
        const h = row({ refrigerated: 1, controlled: 1, id_required: 1, signature_rule: 'adult' });
        expect(h).toMatchObject({
            signatureRequired: true, signatureRule: 'adult',
            refrigerated: true, controlled: true, idRequired: true,
        });
    });

    it('reads an unrecognised rule as the default rather than crashing a run', () => {
        /* A row holding a value no version of this code wrote is not a
           reason to fail a courier's day. 'anyone' still requires a
           signature from somebody. */
        expect(ruleOf('something_else')).toBe('anyone');
        expect(ruleOf(null)).toBe('anyone');
        expect(ruleOf(undefined)).toBe('anyone');
    });

    it('spells its columns out rather than selecting a star', () => {
        /* A star is what let package_count mask a computed alias in
           pickup.ts, and u.pin shadow d.pin in core/auth/devices.ts. */
        const sql = handlingColumns('o');
        expect(sql).toContain('o.signature_rule');
        expect(sql).toContain('o.id_required');
        expect(sql).not.toContain('*');
    });
});

describe('who may sign, in words', () => {
    it('names the patient when only the patient will do', () => {
        /* Medicare. The counters were emphatic: not a caregiver, not a
           spouse, unless separately named. */
        const s = signingInstruction(row({ signature_rule: 'patient_only' }), 'Alma Reyes');
        expect(s).toContain('Alma Reyes must sign');
        expect(s).toContain('Nobody else');
    });

    it('does not leave a blank where a name should be', () => {
        const s = signingInstruction(row({ signature_rule: 'patient_only' }), '');
        expect(s).toContain('The patient must sign');
    });

    it('says eighteen or over for the IV protocol', () => {
        expect(signingInstruction(row({ signature_rule: 'adult' }), 'Alma Reyes'))
            .toBe('Anyone 18 or over at this address may sign.');
    });

    it('still asks for a signature in the ordinary case', () => {
        /* "We don't just drop it off at the door and leave it. We don't do
           Amazon." */
        expect(signingInstruction(row(), 'Alma Reyes'))
            .toBe('Anyone at this address may sign.');
    });

    it('says so plainly when none is needed', () => {
        expect(signingInstruction(row({ signature_required: 0 }), 'Alma Reyes'))
            .toBe('No signature needed.');
    });

    it('names the caregiver the pharmacy named', () => {
        const s = signingInstruction(row({ authorised_signers: 'Delphine Okonkwo (daughter)' }), 'Alma Reyes');
        expect(s).toContain('Delphine Okonkwo (daughter)');
    });

    it('names a caregiver even alongside patient-only, strict half first', () => {
        /* The import warns about that combination rather than resolving it,
           so a courier holding a highlighted form with a name on it has to
           be told what we think. Skim-reading must give the stricter half. */
        const s = signingInstruction(
            row({ signature_rule: 'patient_only', authorised_signers: 'Delphine Okonkwo' }),
            'Alma Reyes',
        );
        expect(s.indexOf('Nobody else')).toBeLessThan(s.indexOf('Delphine Okonkwo'));
    });
});

describe('the flags on a list row', () => {
    it('leads with the ones that change what you do before leaving the counter', () => {
        const flags = handlingFlags(row({ refrigerated: 1, controlled: 1, id_required: 1 }));
        expect(flags).toEqual(['Fridge', 'Controlled', 'ID']);
    });

    it('marks a door that cannot be left to a neighbour', () => {
        expect(handlingFlags(row({ signature_rule: 'patient_only' }))).toContain('Patient only');
        expect(handlingFlags(row({ signature_rule: 'adult' }))).toContain('18+');
    });

    it('is empty for an ordinary delivery, rather than noisy', () => {
        expect(handlingFlags(row())).toEqual([]);
    });

    it('says nothing about a signature rule when no signature is wanted', () => {
        expect(handlingFlags(row({ signature_required: 0, signature_rule: 'patient_only' }))).toEqual([]);
    });
});

describe('is this person named', () => {
    it('matches the name the pharmacy wrote, ignoring case and the relationship', () => {
        const h = row({ authorised_signers: 'Delphine Okonkwo (daughter)' });
        expect(isNamedSigner(h, 'delphine okonkwo')).toBe(true);
        expect(isNamedSigner(h, '  Delphine Okonkwo ')).toBe(true);
    });

    it('handles several names', () => {
        const h = row({ authorised_signers: 'Delphine Okonkwo; Marcus Ibarra' });
        expect(isNamedSigner(h, 'Marcus Ibarra')).toBe(true);
    });

    it('refuses a partial match, which is how the neighbour gets the package', () => {
        const h = row({ authorised_signers: 'Delphine Okonkwo' });
        expect(isNamedSigner(h, 'Del')).toBe(false);
        expect(isNamedSigner(h, 'Okonkwo')).toBe(false);
    });

    it('refuses an empty name against an empty list', () => {
        expect(isNamedSigner(row(), '')).toBe(false);
        expect(isNamedSigner(row({ authorised_signers: 'Delphine Okonkwo' }), '')).toBe(false);
    });
});
