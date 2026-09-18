/* The applications queue (ticket 8.1).
 *
 * Four things are worth a test rather than a look, and they are all the same
 * thing from different angles: this screen is the last place where a claim
 * can be mistaken for a verification.
 *
 *   1. A claim is never in the box where a verification goes, and the
 *      Record form does not open prefilled with what the applicant typed.
 *   2. Approve is offered even when the gates are not green, and the
 *      server's refusal reaches the operator in words.
 *   3. Rejecting says out loud that it disables the account.
 *   4. A courier cannot open this at all.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../app/auth';
import { App } from '../../app/App';
import { mockFetch } from '../../test/setup';

const person = (role: string) => ({
    session: { id: 3, username: `u.${role}`, name: `U ${role}`, role: 'staff', route: null },
    projects: [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role }],
});

const clearance = (over = {}) => ({
    ready: false,
    missing: ['background_check'],
    expired: [],
    failed: [],
    why: 'the background check is not recorded yet. Nobody reads a patient’s address until all five are green.',
    ...over,
});

const row = (over = {}) => ({
    id: 41,
    name: 'Ana Ruiz',
    email: 'ana.ruiz@example.com',
    phone: '210-555-0142',
    claims: 'I have driven for a pharmacy before.',
    status: 'submitted',
    submittedAt: '2026-09-15T14:00:00Z',
    decidedAt: null,
    decidedBy: '',
    decisionReason: '',
    hasAccount: true,
    clearance: clearance(),
    ...over,
});

const check = (kind: string, over = {}) => ({
    kind,
    status: 'pending',
    verifiedBy: '',
    verifiedAt: null,
    reference: '',
    expiresAt: null,
    note: '',
    submitted: null,
    ...over,
});

const detail = (over = {}) => ({
    ...row(),
    checks: [
        check('hipaa_training', {
            status: 'verified', verifiedBy: 'sam.ops', verifiedAt: '2026-09-16T09:00:00Z',
            reference: 'HIPAA-9921', expiresAt: '2027-09-16',
        }),
        check('confidentiality', { status: 'verified', verifiedBy: 'sam.ops', verifiedAt: '2026-09-16T09:05:00Z' }),
        /* The one the applicant typed a number into from the phone (7.2) and
           nobody has checked. This row is the whole point of the screen. */
        check('background_check', {
            submitted: { reference: 'I passed one at my last job, ref 88231', note: '', at: '2026-09-15T20:10:00Z' },
        }),
        check('drivers_licence', { status: 'verified', verifiedBy: 'sam.ops', verifiedAt: '2026-09-16T09:06:00Z', expiresAt: '2029-01-04' }),
        check('insurance', { status: 'verified', verifiedBy: 'sam.ops', verifiedAt: '2026-09-16T09:07:00Z', expiresAt: '2027-03-01' }),
    ],
    ...over,
});

function renderAs(role: string, routes: Record<string, unknown> = {}) {
    const p = person(role);
    const mocked = mockFetch({
        'GET /api/session': p.session,
        'GET /api/me/projects': p.projects,
        'GET /api/projects/uh/driver-applications?status=submitted': { applications: [row()] },
        'GET /api/projects/uh/driver-applications/41': detail(),
        ...routes,
    });
    render(
        <MemoryRouter initialEntries={['/projects/uh/applications']}>
            <AuthProvider><App /></AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

describe('a claim is not a verification', () => {
    it('labels what the applicant typed as theirs, and never as a check', async () => {
        renderAs('admin');
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

        /* The number Ana typed about herself is on screen, because the
           person verifying needs it to go and look. It is attributed. */
        expect(await screen.findByText(/Typed by the applicant on 2026-09-15/)).toBeInTheDocument();
        expect(screen.getByText(/ref 88231/)).toBeInTheDocument();

        /* And the check itself is still pending with nobody's name on it. */
        const backgroundRow = screen.getByText('Background check').closest('tr')!;
        expect(backgroundRow).toHaveTextContent('pending');
        expect(backgroundRow).not.toHaveTextContent('sam.ops');
    });

    it('does not prefill the Record form with what the applicant claimed', async () => {
        /* A box prefilled with somebody's own claim turns verification into
           pressing Save, which is the failure this screen exists to avoid. */
        renderAs('admin');
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByText('Background check');

        const backgroundRow = screen.getByText('Background check').closest('tr')!;
        fireEvent.click(within(backgroundRow).getByRole('button', { name: 'Record' }));

        const reference = await screen.findByLabelText('Background check reference');
        expect(reference).toHaveValue('');
    });

    it('sends what the verifier typed, with their chosen status', async () => {
        const mocked = renderAs('admin', {
            'PUT /api/projects/uh/driver-applications/41/checks/background_check': { ok: true, clearance: clearance({ ready: true, missing: [] }) },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        await screen.findByText('Background check');

        const backgroundRow = screen.getByText('Background check').closest('tr')!;
        fireEvent.click(within(backgroundRow).getByRole('button', { name: 'Record' }));
        fireEvent.change(await screen.findByLabelText('Background check reference'), { target: { value: 'Checkr 7781' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(mocked.bodies['PUT /api/projects/uh/driver-applications/41/checks/background_check'])
                .toEqual({ status: 'verified', reference: 'Checkr 7781', expiresAt: null, note: '' });
        });
    });
});

describe('approval', () => {
    it('is offered even when the gates are not green, and the server refuses in words', async () => {
        /* Deliberate. A disabled button is the screen deciding clearance,
           and a screen holding a stale clearance disables the person who is
           entitled to act. */
        renderAs('admin', {
            'POST /api/projects/uh/driver-applications/41/approve': {
                status: 409,
                body: { error: 'the background check is not recorded yet. Nobody reads a patient’s address until all five are green.', code: 'onboarding.incomplete' },
            },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

        const approve = await screen.findByRole('button', { name: 'Approve and grant access' });
        expect(approve).toBeEnabled();
        fireEvent.click(approve);

        expect(await screen.findByRole('alert')).toHaveTextContent(/background check is not recorded yet/);
    });

    it('says which username the person can now sign in as', async () => {
        renderAs('admin', {
            'GET /api/projects/uh/driver-applications/41': detail({ clearance: clearance({ ready: true, missing: [], why: 'Every onboarding check is recorded and current.' }) }),
            'POST /api/projects/uh/driver-applications/41/approve': { status: 201, body: { ok: true, username: 'ana.ruiz@example.com' } },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Approve and grant access' }));

        expect(await screen.findByText(/can sign in as ana\.ruiz@example\.com/)).toBeInTheDocument();
    });
});

describe('rejection', () => {
    it('says out loud that it disables the account, and needs a reason', async () => {
        const mocked = renderAs('admin', {
            'POST /api/projects/uh/driver-applications/41/reject': { ok: true },
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));

        const submit = await screen.findByRole('button', { name: 'Reject and disable the account' });
        const reason = screen.getByLabelText(/Why this is being rejected/);
        /* The server takes a minimum of ten characters; the box says so
           rather than letting somebody type "no" and read a 400. */
        expect(reason).toHaveAttribute('minLength', '10');
        expect(reason).toBeRequired();

        fireEvent.change(reason, { target: { value: 'Background check returned a disqualifying result.' } });
        fireEvent.click(submit);

        await waitFor(() => {
            expect(mocked.bodies['POST /api/projects/uh/driver-applications/41/reject'])
                .toEqual({ reason: 'Background check returned a disqualifying result.' });
        });
        expect(await screen.findByText(/their account is disabled/)).toBeInTheDocument();
    });
});

describe('a courier', () => {
    it('cannot open the queue, and is told why rather than bounced', async () => {
        /* The server refuses them too. This is so the refusal is a sentence
           about somebody's licence number and background check, rather than
           a blank screen that looks like a bug. */
        renderAs('courier');
        expect(await screen.findByText('Not yours to see')).toBeInTheDocument();
        expect(screen.getByText(/result of a background check/)).toBeInTheDocument();
    });
});
