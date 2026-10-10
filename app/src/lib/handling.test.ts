/* Asking at the door, rather than being refused afterwards.
 *
 * The server holds the real rule. This mirrors only the decision, because
 * the app queues: a Medicare delivery refused after it reached the outbox is
 * discovered when the courier is three streets away and the medication has
 * already changed hands.
 *
 * The cases below are the ones that decide whether a courier is stopped
 * needlessly at a door at seven in the morning, so both directions matter:
 * asking when we should not is as bad as not asking when we should.
 */

import { describe, it, expect } from 'vitest';
import { needsSignerExplanation } from './handling';

const stop = (over = {}) => ({
    signatureRequired: true,
    signatureRule: 'patient_only' as const,
    authorisedSigners: '',
    recipientName: 'Alma Reyes',
    ...over,
});

describe('when nothing needs explaining', () => {
    it('does not ask on an ordinary delivery', () => {
        /* Almost every delivery. Asking for a justification here would
           train couriers to type anything into the box. */
        expect(needsSignerExplanation(stop({ signatureRule: 'anyone' }), 'A Neighbour')).toBe(false);
    });

    it('does not ask on an eighteen-or-over delivery', () => {
        expect(needsSignerExplanation(stop({ signatureRule: 'adult' }), 'A Neighbour')).toBe(false);
    });

    it('does not ask when the patient signed', () => {
        expect(needsSignerExplanation(stop(), 'Alma Reyes')).toBe(false);
    });

    it('forgives case and spacing, which is how a name gets typed on a phone', () => {
        expect(needsSignerExplanation(stop(), '  alma   reyes ')).toBe(false);
    });

    it('does not ask for the caregiver the pharmacy named', () => {
        /* Decided in advance, with the patient, on the telephone. Making the
           courier justify it would be asking them to re-litigate it. */
        const h = stop({ authorisedSigners: 'Delphine Okonkwo (daughter)' });
        expect(needsSignerExplanation(h, 'Delphine Okonkwo')).toBe(false);
    });

    it('does not ask before anything has been typed', () => {
        /* An empty box is a form not yet filled in, not a problem. */
        expect(needsSignerExplanation(stop(), '')).toBe(false);
        expect(needsSignerExplanation(stop(), '   ')).toBe(false);
    });

    it('does not ask when no signature is wanted at all', () => {
        expect(needsSignerExplanation(stop({ signatureRequired: false }), 'A Neighbour')).toBe(false);
    });
});

describe('when it has to ask', () => {
    it('asks about the neighbour', () => {
        /* "Just give it to my neighbor. That is not acceptable." */
        expect(needsSignerExplanation(stop(), 'A Neighbour')).toBe(true);
    });

    it('asks about somebody who is not the named caregiver', () => {
        const h = stop({ authorisedSigners: 'Delphine Okonkwo' });
        expect(needsSignerExplanation(h, 'Marcus Ibarra')).toBe(true);
    });

    it('asks on a partial name, which is how the wrong person gets it', () => {
        const h = stop({ authorisedSigners: 'Delphine Okonkwo' });
        expect(needsSignerExplanation(h, 'Delphine')).toBe(true);
        expect(needsSignerExplanation(stop(), 'Alma')).toBe(true);
    });

    it('stays quiet when the server sent no rule at all', () => {
        /* A server older than this build sends no signatureRule, and it
           sends none for ordinary deliveries too, so undefined cannot be
           read as Medicare without stopping couriers at every door.
           
           The consequence is stated rather than hidden: against an old
           server this prompt does not appear, and the SERVER check is what
           still refuses the delivery. That is the right way round -- the
           control lives there, and this is the courtesy in front of it.
           
           Asserted here, in the block about when it asks, because this is
           the case somebody will come looking for. */
        expect(needsSignerExplanation(stop({ signatureRule: undefined }), 'A Neighbour')).toBe(false);
    });
});
