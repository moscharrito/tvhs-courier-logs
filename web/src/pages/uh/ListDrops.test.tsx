/* The drop box on screen.
 *
 * What matters here is the promise the page makes. A pharmacist who has
 * used the import screen reasonably expects deliveries to appear, and
 * finding out at four in the afternoon that none did — by telephone — is
 * the failure these tests exist to stop. So the screen says it imports
 * nothing, in as many words, in both of the places a reader looks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ListDrops } from './ListDrops';
import { mockFetch } from '../../test/setup';

const BASE = '/api/projects/uh/uh/list-drops';

const drop = (over = {}) => ({
    id: 11, siteId: 7, pharmacy: 'University Hospital Discharge Pharmacy', pharmacyCode: 'discharge',
    serviceDate: '2026-11-10', filename: 'monday.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: 20480, fingerprint: 'a1b2c3d4e5f6', note: '',
    uploadedBy: 'uh.pharmacist', uploadedAt: '2026-11-09T15:00:00.000Z',
    handledAt: null, handledBy: '', handled: false,
    ...over,
});

const listing = (over = {}) => ({
    drops: [drop()],
    total: 1,
    returned: 1,
    pharmacies: [{ id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' }],
    status: 'outstanding',
    ...over,
});

const routes = (over = {}) => ({ [`GET ${BASE}*`]: listing(), ...over });

function show(r = routes(), props = {}) {
    const mocked = mockFetch(r);
    render(
        <ListDrops
            projectCode="uh"
            timezone="America/Chicago"
            canHandle
            canUpload
            {...props}
        />,
    );
    return mocked;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('what the page promises', () => {
    it('says nothing here is imported, where a reader will see it', async () => {
        show();
        expect(await screen.findByText(/Nothing here is imported/i)).toBeInTheDocument();
        expect(screen.getByText(/no delivery exists until dispatch downloads/i)).toBeInTheDocument();
    });

    it('says it again when a file has just been handed over', async () => {
        /* The moment somebody is most likely to assume work has started. */
        const mocked = show({
            ...routes(),
            [`POST ${BASE}*`]: { id: 12, pharmacy: 'Discharge', filename: 'tuesday.xlsx', bytes: 10 },
        });
        await screen.findByText(/Nothing here is imported/i);

        fireEvent.change(screen.getByLabelText('Pharmacy', { selector: 'select' }), { target: { value: '7' } });
        fireEvent.change(screen.getByLabelText('For the day'), { target: { value: '2026-11-10' } });
        const input = screen.getByLabelText('File') as HTMLInputElement;
        const picked = new File(['x'], 'tuesday.xlsx', { type: 'application/vnd.ms-excel' });
        fireEvent.change(input, { target: { files: [picked] } });
        /* fireEvent.submit, not a click on the button: jsdom runs constraint
           validation on a click and refuses to submit, because a file set
           through fireEvent does not satisfy `required` there the way a real
           pick does. The handler is what this test is about. */
        const form = screen.getByRole('button', { name: 'Hand it over' }).closest('form') as HTMLFormElement;
        fireEvent.submit(form);

        await waitFor(() => {
            expect(mocked.calls.some((c) => c.startsWith('POST'))).toBe(true);
        });
        expect(await screen.findByText(/creates no deliveries/i)).toBeInTheDocument();
    });
});

describe('the list', () => {
    it('opens on what is still to do', async () => {
        const { calls } = show();
        await screen.findByText('monday.xlsx');
        expect(calls.find((c) => c.includes('/list-drops?'))).toContain('status=outstanding');
    });

    it('offers a download that is a plain link, not a blob', async () => {
        /* A blob URL keeps a copy of a pharmacy's patients alive in the tab
           until it is closed. The browser already knows how to save a file. */
        show();
        await screen.findByText('monday.xlsx');
        const link = screen.getByRole('link', { name: 'Download' });
        expect(link).toHaveAttribute('href', `${BASE}/11/file`);
    });

    it('shows the size and fingerprint, so two identical sheets are visible', async () => {
        show();
        const row = (await screen.findByText('monday.xlsx')).closest('tr') as HTMLElement;
        expect(within(row).getByText(/20 KB · a1b2c3d4e5f6/)).toBeInTheDocument();
    });

    it('narrows by status, pharmacy, date and file name', async () => {
        const { calls } = show({
            [`GET ${BASE}*`]: listing({
                pharmacies: [
                    { id: 7, code: 'discharge', name: 'Discharge' },
                    { id: 8, code: 'green', name: 'Robert B. Green' },
                ],
            }),
        });
        await screen.findByText('monday.xlsx');

        fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'handled' } });
        fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
        fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'monday' } });

        await waitFor(() => {
            const last = calls.filter((c) => c.includes('/list-drops?')).pop() ?? '';
            expect(last).toContain('status=handled');
            expect(last).toContain('from=2026-11-01');
            expect(last).toContain('q=monday');
        });
    });

    it('says plainly when there is nothing waiting', async () => {
        show({ [`GET ${BASE}*`]: listing({ drops: [], total: 0, returned: 0 }) });
        expect(await screen.findByText(/Every list handed over has been dealt with/i)).toBeInTheDocument();
    });
});

describe('marking one dealt with', () => {
    it('is offered to dispatch', async () => {
        show();
        await screen.findByText('monday.xlsx');
        expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });

    it('is not offered to a pharmacy, who may still download', async () => {
        /* A pharmacy saying "you have dealt with this" would be reporting on
           our work rather than on theirs, and the server refuses it. */
        show(routes(), { canHandle: false });
        await screen.findByText('monday.xlsx');
        expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    });

    it('offers Reopen on one already done, because people press the wrong row', async () => {
        show({
            [`GET ${BASE}*`]: listing({
                status: 'all',
                drops: [drop({ handled: true, handledAt: '2026-11-09T16:00:00.000Z', handledBy: 'dispatch' })],
            }),
        });
        await screen.findByText('monday.xlsx');
        expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
        /* Scoped to the row: "Dealt with" is also an option in the Showing
           filter, and an unscoped query matches both. */
        const row = screen.getByText('monday.xlsx').closest('tr') as HTMLElement;
        expect(within(row).getByText('Dealt with')).toBeInTheDocument();
    });
});

describe('handing one over', () => {
    it('is not offered at all where the account may not', async () => {
        show(routes(), { canUpload: false });
        await screen.findByText('monday.xlsx');
        expect(screen.queryByRole('button', { name: 'Hand it over' })).toBeNull();
    });

    it('picks the only pharmacy on the account by itself', async () => {
        /* Every ordinary pharmacist has exactly one, and asking them to
           choose it is asking for a decision they have no choice in. */
        show();
        await screen.findByText('monday.xlsx');
        await waitFor(() => {
            expect((screen.getByLabelText('Pharmacy', { selector: 'select' }) as HTMLSelectElement).value).toBe('7');
        });
    });
});
