import { describe, it, expect } from 'vitest';
import { readablePhone } from './phone';

describe('a phone number a courier reads aloud', () => {
    it('formats the ten digits the server stores', () => {
        /* The whole point: "2105550100" has to be parsed by a human before it
           can be spoken, and this is read at a doorway against the person
           standing there. */
        expect(readablePhone('2105550100')).toBe('(210) 555-0100');
    });

    it('handles a country code without mangling the rest', () => {
        expect(readablePhone('12105550100')).toBe('+1 (210) 555-0100');
    });

    it('leaves anything it does not recognise exactly as it came', () => {
        /* Not ten digits is not the same as wrong: international numbers,
           extensions and a pharmacy's own oddities all arrive here. Showing
           it as sent is honest; reshaping it would be a guess. */
        for (const odd of ['+44 20 7946 0958', '555-0100 ext 12', '', 'call the ward']) {
            expect(readablePhone(odd)).toBe(odd);
        }
    });

    it('is not fooled by punctuation the pharmacy already added', () => {
        expect(readablePhone('(210) 555-0100')).toBe('(210) 555-0100');
        expect(readablePhone('210.555.0100')).toBe('(210) 555-0100');
    });
});
