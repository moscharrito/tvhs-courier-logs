/* Initials from a typed name.
 *
 * It runs on every keystroke while somebody types, so the interesting cases
 * are all half-typed names and names that are not two tidy English words.
 */

import { describe, it, expect } from 'vitest';
import { canDeriveInitials, initialsDescription, initialsOf } from './initials';

describe('the ordinary case', () => {
    it('takes the first letter of the first and last name', () => {
        expect(initialsOf('James Madison')).toBe('JM');
        expect(initialsOf('Alison Baker')).toBe('AB');
    });

    it('skips the middle name, the way people do', () => {
        /* "James Fenimore Cooper" is JC to anybody who has initialled a page.
           First-and-second would give JF, which nobody would recognise. */
        expect(initialsOf('James Fenimore Cooper')).toBe('JC');
        expect(initialsOf('Ana Maria Ruiz Delgado')).toBe('AD');
    });

    it('upper-cases whatever was typed', () => {
        expect(initialsOf('james madison')).toBe('JM');
        expect(initialsOf('JAMES MADISON')).toBe('JM');
    });
});

describe('a name being typed', () => {
    it('gives nothing until there is something to work with', () => {
        /* The case that matters: this runs on every keystroke, and a mark
           derived from half a name must not stick around. */
        expect(initialsOf('')).toBe('');
        expect(initialsOf('   ')).toBe('');
        expect(canDeriveInitials('')).toBe(false);
    });

    it('gives one letter for one name, rather than nothing', () => {
        /* Mononyms exist, and so does a pharmacist who gives one name. */
        expect(initialsOf('J')).toBe('J');
        expect(initialsOf('James')).toBe('J');
    });

    it('does not produce a mark from punctuation alone', () => {
        expect(initialsOf('...')).toBe('');
        expect(initialsOf('- -')).toBe('');
        expect(initialsOf('123')).toBe('');
    });
});

describe('names that are not two tidy English words', () => {
    it('treats an apostrophe as part of the surname', () => {
        /* O'Brien is one name. OB would be wrong. */
        expect(initialsOf("Sean O'Brien")).toBe('SO');
    });

    it('handles accents and non-Latin letters', () => {
        expect(initialsOf('Álvaro Núñez')).toBe('ÁN');
        expect(initialsOf('Олена Коваленко')).toBe('ОК');
    });

    it('copes with double spaces and stray whitespace', () => {
        expect(initialsOf('  James   Madison  ')).toBe('JM');
    });

    it('strips leading punctuation from a word', () => {
        expect(initialsOf('(James) Madison')).toBe('JM');
    });
});

describe('what the courier is told', () => {
    it('shows the mark and says it was typed, not drawn', () => {
        /* The courier has to see exactly what is being recorded before they
           record it, because the person handing over is standing there. */
        const out = initialsDescription('James Madison');
        expect(out).toMatch(/Signing as JM/);
        expect(out).toMatch(/initials of James Madison/);
        expect(out).toMatch(/typed, not drawn/);
    });

    it('asks for a name when there is not one yet', () => {
        expect(initialsDescription('  ')).toMatch(/Type the name/);
    });
});
