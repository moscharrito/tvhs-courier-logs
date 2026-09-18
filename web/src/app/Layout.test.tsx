/* The side rail, and collapsing it (ticket 5.14).
 *
 * Most of these are about what collapsing must NOT cost. Two of them are
 * defects this file was written after hitting: a Sign out button that lost
 * its name to a display:none, and a rail that highlighted nothing once it was
 * down to two letters.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { App } from './App';
import { mockFetch } from '../test/setup';

const session = { id: 1, username: 'dee.dispatch', name: 'Dee Dispatch', role: 'staff', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'admin' }];

function renderAt(path: string, routes: Record<string, unknown> = {}) {
    mockFetch({
        'GET /api/session': session,
        'GET /api/me/projects': projects,
        'GET /api/login/device': { enrolled: false },
        ...routes,
    });
    return render(
        <MemoryRouter initialEntries={[path]}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
}

const rail = () => document.querySelector('.izy') as HTMLElement;
const toggle = () => screen.getByRole('button', { name: /the menu/ });

beforeEach(() => { window.localStorage.clear(); });

describe('the side rail', () => {
    it('collapses and expands, and says which the button will do', async () => {
        renderAt('/');
        const button = await screen.findByRole('button', { name: 'Collapse the menu' });
        expect(button).toHaveAttribute('aria-expanded', 'true');
        expect(rail()).not.toHaveClass('is-collapsed');

        fireEvent.click(button);
        expect(rail()).toHaveClass('is-collapsed');
        expect(toggle()).toHaveAccessibleName('Expand the menu');
        expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    });

    it('remembers, so it is not a choice you make every morning', async () => {
        const { unmount } = renderAt('/');
        fireEvent.click(await screen.findByRole('button', { name: 'Collapse the menu' }));
        unmount();

        renderAt('/');
        expect(await screen.findByRole('button', { name: 'Expand the menu' })).toBeInTheDocument();
        expect(rail()).toHaveClass('is-collapsed');
    });

    it('keeps every link reachable and named while collapsed', async () => {
        /* A rail that hides itself entirely takes the navigation with it, so
           reaching Home costs opening a menu first. It collapses to initials,
           and the words stay in the document for anybody who cannot see the
           initials: "UP" is not a project name.

           Same caveat as the Sign out case below: css:false here, so this
           pins the markup and the browser pins the clipping. */
        renderAt('/');
        fireEvent.click(await screen.findByRole('button', { name: 'Collapse the menu' }));

        const nav = screen.getByRole('navigation', { name: 'Main' });
        for (const name of ['Home', 'UH Pharmacy Courier', 'This phone']) {
            expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
        }
    });

    it('keeps the word Sign out in the document when the eye cannot see it', async () => {
        /* The first rule written for this hid every span in the footer, which
           caught the button's own label as well as the username and left an
           icon button with no accessible name at all.

           BE HONEST ABOUT WHAT THIS COVERS. vitest runs with css:false, so no
           stylesheet is applied here and this cannot fail the way the real
           bug failed. It pins the half that lives in the markup: the word is
           rendered rather than swapped for the icon. The other half, that the
           collapsed rules clip the label instead of display:none-ing it out
           of the accessibility tree, was checked in a browser and can only be
           checked in one. */
        renderAt('/');
        fireEvent.click(await screen.findByRole('button', { name: 'Collapse the menu' }));
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });

    it('lights the project anywhere inside it, not only on its own page', async () => {
        /* A project's link points at the project's own page, so standing on
           the board lit nothing in this rail. Survivable while every item was
           spelled out; with the rail down to two letters, nothing highlighted
           means nothing telling you which project you are in. */
        renderAt('/projects/uh/board', {
            'GET /api/projects/uh/uh/board*': {
                serviceDate: '2026-09-15',
                /* `summary`, not `stats`, and `total`, not `orders`. This
                   fixture had never matched the endpoint, so Board rendered
                   against undefined and threw on every run of this file. The
                   assertion below is about the rail and passed anyway, which
                   is how an unhandled error sat in a green-looking suite:
                   242 tests passing and `npm test -w web` exiting 1. */
                summary: { total: 0, unassigned: 0, assigned: 0, inTransit: 0, delivered: 0, failed: 0, dueSoon: 0, overdue: 0 },
                pool: [], lanes: [], activity: [], idleCouriers: [], sites: [],
            },
        });
        const link = await screen.findByRole('link', { name: 'UH Pharmacy Courier' });
        expect(link).toHaveClass('active');
    });

    it('does not light a project you are merely near', async () => {
        // /users is nobody's project.
        renderAt('/users', { 'GET /api/users': [] });
        const link = await screen.findByRole('link', { name: 'UH Pharmacy Courier' });
        expect(link).not.toHaveClass('active');
    });
});
