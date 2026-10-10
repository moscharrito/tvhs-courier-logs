/* Who is a pharmacy, and where their links go.
 *
 * Small and pure, and worth having because the bug it pins was invisible in
 * every test that existed: the deliveries page was correct, correctly scoped
 * and thoroughly tested, while the two screens in FRONT of it sent a
 * pharmacist to a project picker and then to a URL that is not a page.
 * Nothing asserted what happens before the portal loads.
 */

import { describe, it, expect } from 'vitest';
import { counterName, isPharmacyOnly, projectHref } from './pharmacy';

const member = (code: string, role: string) => ({
    id: 1, code, name: code.toUpperCase(), timezone: 'America/Chicago', role,
} as never);

describe('who gets the counter experience', () => {
    it('is a pharmacy with one pharmacy membership', () => {
        expect(isPharmacyOnly([member('uh', 'pharmacy')])).toBe(true);
    });

    it('is not an Izy administrator, who is enrolled everywhere', () => {
        /* Platform admins are added to every project at boot. Funnelling one
           into a client portal would hide the whole application from the
           person who administers it. */
        expect(isPharmacyOnly([member('uh', 'admin'), member('tvhs', 'admin')])).toBe(false);
    });

    it('is not somebody who is a pharmacy here and staff elsewhere', () => {
        /* EVERY, not some: they need the full shell to reach the other half
           of their job. */
        expect(isPharmacyOnly([member('uh', 'pharmacy'), member('tvhs', 'courier')])).toBe(false);
    });

    it('is not an account with no memberships at all', () => {
        /* An applicant, or a mistake. The picker tells them to ask an admin,
           which is the useful screen; a portal they cannot read is not. */
        expect(isPharmacyOnly([])).toBe(false);
    });

    it('is not a courier', () => {
        expect(isPharmacyOnly([member('uh', 'courier')])).toBe(false);
    });
});

describe('where a project card points', () => {
    it('keeps the doubled path for TVHS, whose legacy screens mount there', () => {
        expect(projectHref('tvhs')).toBe('/projects/tvhs/tvhs');
    });

    it('does not double it for UH, which is what made the card a dead link', () => {
        /* THE BUG. `/projects/${code}/${code}` was applied to every project
           because it was written when TVHS was the only one. For UH it
           produced /projects/uh/uh, which falls through to the catch-all and
           re-renders the picker -- so the first thing a pharmacy clicked did
           nothing, twice. */
        expect(projectHref('uh')).toBe('/projects/uh');
        expect(projectHref('uh')).not.toBe('/projects/uh/uh');
    });
});

describe('the name a counter is shown', () => {
    it('drops the suffix our own directory needs and the reader does not', () => {
        expect(counterName('Robert B. Green Pharmacy (portal)')).toBe('Robert B. Green Pharmacy');
    });

    it('leaves a name that has no suffix alone', () => {
        expect(counterName('Wheatley Pharmacy')).toBe('Wheatley Pharmacy');
    });

    it('is not fooled by a bracket that is part of the name', () => {
        expect(counterName('Pavilion Pharmacy (2nd floor)')).toBe('Pavilion Pharmacy (2nd floor)');
    });
});
