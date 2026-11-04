/* The import screen. What matters here is that a person cannot import
   without looking: the commit button is unreachable until a preview has been
   fetched, blocked rows cannot be selected, and duplicates start unticked. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { ListImport, importOutcome } from './ListImport';
import { mockFetch } from '../../test/setup';

const sites = [
    { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy', type: 'pharmacy', addressLine: '4502 Medical Drive', city: 'San Antonio', state: 'TX', zip: '78229', fullAddress: '', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
    { id: 9, code: 'green', name: 'University Health Robert B. Green Pharmacy', type: 'pharmacy', addressLine: '903 W. Martin Street', city: 'San Antonio', state: 'TX', zip: '78207', fullAddress: '', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
];

const row = (over: Partial<Record<string, unknown>> = {}) => ({
    row: 4, recipientName: 'Dana Whitfield', recipientPhone: '2105550134',
    address: '1100 Broadway St, Apt 4B', city: 'San Antonio', state: 'TX', zip: '78215',
    serviceType: 'scheduled', quantity: 2, description: 'Cold pack', deliveryNotes: '',
    externalRef: 'RX-1001', signatureRequired: true, zone: 1,
    dueAt: '2026-09-14T19:00:00.000Z', issues: [], duplicateOfRow: null,
    duplicateOfOrderId: null, willImport: true, ...over,
});

const preview = {
    site: { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
    serviceDate: '2026-09-14',
    receivedAt: '2026-09-14T17:00:00.000Z',
    sheetName: 'Manifest',
    headers: ['Rx #', 'Patient Name', 'Address 1', 'Zip Code'],
    mapping: { externalRef: 'Rx #', recipientName: 'Patient Name', addressLine: 'Address 1', zip: 'Zip Code' },
    mappingSource: 'detected',
    missingRequired: [],
    alreadyImportedListId: null,
    summary: { total: 3, willImport: 1, blocked: 1, duplicates: 1, outOfArea: 0, warnings: 1 },
    rows: [
        row(),
        // No ZIP means no zone: the server cannot resolve one, so it sends null.
        row({ row: 5, recipientName: 'Owen Castellanos', externalRef: 'RX-1004', zip: '', zone: null, willImport: false,
            issues: [{ row: 5, field: 'zip', code: 'missing', severity: 'error', message: 'ZIP is empty.' }] }),
        row({ row: 6, externalRef: 'RX-1001', willImport: false, duplicateOfRow: 4,
            issues: [{ row: 6, field: 'row', code: 'duplicate.inFile', severity: 'warning', message: 'Same recipient and address as row 4 in this file.' }] }),
    ],
};

/** The screen sends the file with fetch directly, so stub that call too. */
function stub(routes: Record<string, unknown>, postResult?: { status: number; body: unknown }) {
    const { fn, calls } = mockFetch(routes);
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.includes('/uh/imports')) {
            calls.push(`POST ${url.split('?')[0]}`);
            const r = postResult ?? { status: 200, body: preview };
            return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
        }
        return fn(input, init);
    });
    vi.stubGlobal('fetch', wrapped);
    return { calls };
}

function pickFile(name = 'list.xlsx') {
    const input = screen.getByLabelText(/List file/) as HTMLInputElement;
    const file = new File(['bytes'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    // jsdom's File has no arrayBuffer in this version; the screen calls it.
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(5) });
    fireEvent.change(input, { target: { files: [file] } });
    return file;
}

const baseRoutes = {
    'GET /api/projects/uh/uh/sites': sites,
    'GET /api/projects/uh/uh/imports': [],
};

const aList = (over: Record<string, unknown> = {}) => ({
    id: 41,
    site: { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
    serviceDate: '2026-11-02',
    status: 'released',
    receivedAt: '2026-11-02T17:00:00.000Z',
    sourceFilename: 'Courier and fedex 11.02.xlsx',
    rowCount: 79, orderCount: 79, skippedCount: 0,
    importedBy: 'uh.discharge', importedByName: 'Discharge Pharmacy',
    ...over,
});

describe('what the uploader is told afterwards', () => {
    const outcome = (over = {}) => importOutcome({
        id: 57,
        summary: { total: 92, willImport: 1, blocked: 0, duplicates: 91, outOfArea: 0, warnings: 0, imported: 1, ...over },
    });

    it('says how many of how many, not just how many', () => {
        /* THE 2 NOVEMBER REPORT. The message was 'Imported 1 orders as list
           57.' for a ninety-two row file, in green, with no mention of the
           ninety-one that were not on it. It came back as a complaint about
           a capacity limit -- 'approximately 102 entries per upload' --
           because from the counter that is what it looks like. */
        const out = outcome();
        expect(out.text).toMatch(/Imported 1 of 92 rows/);
        expect(out.text).toMatch(/91 rows are not on it/);
    });

    it('stops being green the moment a row is missing', () => {
        /* A success colour is a claim. Ninety-one prescriptions short of a
           courier manifest is not a success. */
        expect(outcome().kind).toBe('warn');
        expect(outcome({ total: 92, imported: 92, duplicates: 0 }).kind).toBe('ok');
    });

    it('names the reason, because the two need opposite actions', () => {
        /* A duplicate is accepted on the preview; a blocked row is fixed in
           the file. '91 rows did not import' invites a guess at which. */
        const dup = outcome();
        expect(dup.details?.join(' ')).toMatch(/already on this pharmacy/);

        const bad = outcome({ total: 10, imported: 7, duplicates: 0, blocked: 3 });
        expect(bad.details?.join(' ')).toMatch(/missing name, street or ZIP/);
    });

    it('admits when the reasons do not add up', () => {
        /* Rather than printing a breakdown that is quietly short. A number
           nobody can explain is the one worth saying out loud. */
        const odd = outcome({ total: 10, imported: 4, duplicates: 1, blocked: 1 });
        expect(odd.details?.join(' ')).toMatch(/4 did not import and the reasons above do not cover/);
    });

    it('says all of them when all of them went', () => {
        const all = outcome({ total: 79, imported: 79, duplicates: 0 });
        expect(all.text).toMatch(/Imported all 79 rows/);
        expect(all.details).toBeUndefined();
    });
});

describe('finding an old list', () => {
    const green = aList({ id: 55, site: { id: 9, code: 'green', name: 'University Health Robert B. Green Pharmacy' }, serviceDate: '2026-09-14', sourceFilename: 'RBG 09.14.xlsx' });
    const discharge = aList({ id: 41, sourceFilename: 'Courier and fedex 11.02.xlsx' });

    it('asks the server rather than sifting the rows it already has', async () => {
        /* THE WHOLE POINT. Unfiltered, the endpoint answers with the hundred
           most recent lists. "Where is the one we sent on the 14th" is a
           question about a list that may be past that edge, and a filter
           applied in the browser could never find it. */
        const { calls } = stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [discharge],
            'GET /api/projects/uh/uh/imports?siteId=9': [green],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.change(screen.getByLabelText('Find pharmacy'), { target: { value: '9' } });

        await screen.findByText('RBG 09.14.xlsx');
        expect(calls).toContain('GET /api/projects/uh/uh/imports?siteId=9');
        expect(screen.queryByText('Courier and fedex 11.02.xlsx')).not.toBeInTheDocument();
    });

    it('filters by service date', async () => {
        const { calls } = stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [discharge],
            'GET /api/projects/uh/uh/imports?serviceDate=2026-09-14': [green],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.change(screen.getByLabelText('Find date'), { target: { value: '2026-09-14' } });

        await screen.findByText('RBG 09.14.xlsx');
        expect(calls).toContain('GET /api/projects/uh/uh/imports?serviceDate=2026-09-14');
    });

    it('sends both together when both are chosen', async () => {
        const { calls } = stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [discharge],
            'GET /api/projects/uh/uh/imports?siteId=9': [green],
            'GET /api/projects/uh/uh/imports?siteId=9&serviceDate=2026-09-14': [green],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.change(screen.getByLabelText('Find pharmacy'), { target: { value: '9' } });
        await screen.findByText('RBG 09.14.xlsx');
        fireEvent.change(screen.getByLabelText('Find date'), { target: { value: '2026-09-14' } });

        await waitFor(() => {
            expect(calls).toContain('GET /api/projects/uh/uh/imports?siteId=9&serviceDate=2026-09-14');
        });
    });

    it('does not say "nothing imported yet" when a filter simply matched nothing', async () => {
        /* Under a filter that sentence reads as "this pharmacy has never sent
           one", which is a different and much more alarming claim than "not
           on that day". */
        stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [discharge],
            'GET /api/projects/uh/uh/imports?serviceDate=2026-01-01': [],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.change(screen.getByLabelText('Find date'), { target: { value: '2026-01-01' } });

        await screen.findByText(/No lists match that/);
        expect(screen.queryByText('Nothing imported yet.')).not.toBeInTheDocument();
    });

    it('offers Show all only once something is filtered, and it clears both', async () => {
        const { calls } = stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [discharge],
            'GET /api/projects/uh/uh/imports?siteId=9': [green],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');
        expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Find pharmacy'), { target: { value: '9' } });
        await screen.findByText('RBG 09.14.xlsx');

        fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
        await screen.findByText('Courier and fedex 11.02.xlsx');
        expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
        /* Back to the unfiltered URL, not to siteId= with an empty value. */
        expect(calls.filter((c) => c === 'GET /api/projects/uh/uh/imports').length).toBeGreaterThan(1);
    });

    it('offers a pharmacy that has closed, because its old lists are still there', async () => {
        /* The upload select hides inactive counters; this one must not. The
           day somebody goes looking for a closed pharmacy's list is the day
           after it closed. */
        const withClosed = [...sites, { ...sites[0], id: 12, code: 'shut', name: 'Closed Counter', status: 'inactive' }];
        stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/sites': withClosed,
            'GET /api/projects/uh/uh/imports': [discharge],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        const find = screen.getByLabelText('Find pharmacy');
        expect(within(find).getByRole('option', { name: 'Closed Counter' })).toBeInTheDocument();
    });
});

describe('taking a list back off', () => {
    const withRecent = (lists: unknown[]) => ({
        ...baseRoutes,
        'GET /api/projects/uh/uh/imports': lists,
    });

    it('offers no way to do it unless the caller is dispatch', async () => {
        /* The portal renders this same component. A pharmacy may send a list
           and read its own back; withdrawing one is dispatch's. */
        stub(withRecent([aList()]));
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        expect(screen.queryByRole('columnheader', { name: 'Remove' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Take the .* list off/ })).not.toBeInTheDocument();
    });

    it('asks before it does anything, and does nothing when the answer is no', async () => {
        const { calls } = stub(withRecent([aList()]));
        vi.stubGlobal('confirm', vi.fn(() => false));
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.click(screen.getByRole('button', { name: /Take the 2026-11-02 .* list off/ }));
        await waitFor(() => { expect(confirm).toHaveBeenCalled(); });
        expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    });

    it('says how many deliveries go, so nobody deletes seventy-nine of them by eye', async () => {
        stub(withRecent([aList()]));
        const asked = vi.fn((_text?: string) => false);
        vi.stubGlobal('confirm', asked);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.click(screen.getByRole('button', { name: /Take the 2026-11-02 .* list off/ }));
        await waitFor(() => { expect(asked).toHaveBeenCalled(); });
        const text = String(asked.mock.calls[0]?.[0] ?? '');
        expect(text).toMatch(/79 deliveries? (is|are) deleted outright/);
        /* THE DIALOG HAS TO DESCRIBE WHAT THE BUTTON NOW DOES. It promised
           the opposite until 4 November -- "the deliveries stay on the
           record as cancelled" -- and a confirmation describing behaviour
           the code used to have is worse than none. */
        expect(text).toMatch(/cannot be undone/);
        expect(text).toMatch(/already collected, delivered or photographed/);
        /* And the old promise is gone, not merely unmentioned. */
        expect(text).not.toMatch(/stay on the record/);
        expect(text).not.toMatch(/cancelled/);
    });

    it('sends the delete and reports what went with it', async () => {
        const { calls } = stub({
            ...withRecent([aList()]),
            'DELETE /api/projects/uh/uh/imports/41': { deleted: 79, filesDeleted: 4, filesLeftInStorage: 0, permanent: true },
        });
        vi.stubGlobal('confirm', vi.fn(() => true));
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.click(screen.getByRole('button', { name: /Take the 2026-11-02 .* list off/ }));

        await screen.findByText(/79 deliveries removed, 4 photographs/);
        expect(calls).toContain('DELETE /api/projects/uh/uh/imports/41');
        /* Reloaded, so the table is not left claiming the list is still on. */
        expect(calls.filter((c) => c === 'GET /api/projects/uh/uh/imports').length).toBeGreaterThan(1);
    });

    it('shows the refusal when a courier has already collected something', async () => {
        /* THE REFUSAL IS THE USEFUL PART. A button that failed silently here
           would leave the operator believing a list came off a board it is
           still on. */
        stub({
            ...withRecent([aList()]),
            'DELETE /api/projects/uh/uh/imports/41': {
                status: 409,
                body: {
                    error: 'A courier has already started on this list (3 picked up), so it cannot be taken off. '
                        + 'Cancel the deliveries that have not been collected one at a time instead.',
                    code: 'list.workStarted',
                },
            },
        });
        vi.stubGlobal('confirm', vi.fn(() => true));
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        fireEvent.click(screen.getByRole('button', { name: /Take the 2026-11-02 .* list off/ }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/already started on this list \(3 picked up\)/);
    });

    it('keeps a withdrawn list on the screen, marked, with its sheet still downloadable', async () => {
        /* Somebody reconciling a day needs to see that a list was sent and
           taken back off. A row that vanished would turn that into a
           mystery, which is the opposite of what this screen is for. */
        stub(withRecent([aList({ status: 'cancelled' })]));
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport canWithdraw />);
        await screen.findByText('Courier and fedex 11.02.xlsx');

        expect(screen.getByText('taken off')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Take the .* list off/ })).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Download the deliveries/ }))
            .toHaveAttribute('href', '/api/projects/uh/uh/imports/41/export.xlsx');
    });
});

describe('ListImport', () => {
    it('will not import anything until the file has been reviewed', async () => {
        stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');

        // No commit button exists before a preview.
        expect(screen.queryByRole('button', { name: /^Import \d+ orders$/ })).not.toBeInTheDocument();
        // And the review button is disabled until a site and a file are chosen.
        expect(screen.getByRole('button', { name: 'Review the file' })).toBeDisabled();
    });

    it('previews the file and shows the rows, the counts and the blocking reasons', async () => {
        const { calls } = stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');

        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));

        expect(await screen.findByText('1 of 3 rows will be imported')).toBeInTheDocument();
        expect(calls).toContain('POST /api/projects/uh/uh/imports/preview');
        // Rows 4 and 6 are the same person: that is what makes 6 a duplicate.
        expect(screen.getAllByText('Dana Whitfield')).toHaveLength(2);
        expect(screen.getByText('ZIP is empty.')).toBeInTheDocument();
        expect(screen.getByText('Same recipient and address as row 4 in this file.')).toBeInTheDocument();
        expect(screen.getByText(/1 blocked, 1 duplicate/)).toBeInTheDocument();
    });

    it('marks a blocked row as blocked and gives it no checkbox', async () => {
        stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));
        await screen.findByText('1 of 3 rows will be imported');

        const blockedRow = screen.getByText('Owen Castellanos').closest('tr')!;
        expect(within(blockedRow).getByText('blocked')).toBeInTheDocument();
        expect(within(blockedRow).queryByRole('checkbox')).not.toBeInTheDocument();
        // Its ZIP is missing, so the zone is unknown rather than out of area:
        // calling it out of area would imply we priced it per mile.
        expect(within(blockedRow).getByText('unknown')).toBeInTheDocument();
        expect(within(blockedRow).queryByText('out of area')).not.toBeInTheDocument();
        // The duplicate has a checkbox, but it starts unticked.
        expect(screen.getByLabelText('Import row 6')).not.toBeChecked();
        expect(screen.getByLabelText('Import row 4')).toBeChecked();
    });

    it('commits and reports what was created', async () => {
        const { calls } = stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));
        await screen.findByText('1 of 3 rows will be imported');

        // Re-stub so the commit POST answers with the created list. The new
        // stub gets its own call log, which is the one the commit lands in.
        const commit = stub(baseRoutes, { status: 201, body: { id: 12, site: preview.site, serviceDate: '2026-09-14', summary: { ...preview.summary, imported: 1 } } });
        fireEvent.click(screen.getByRole('button', { name: 'Import 1 orders' }));

        /* 'Imported 1 orders as list 12.' until 3 November, in green, with
           no mention of the two rows that did not make it. This fixture is
           the same shape as the Southeast file that prompted the report:
           three rows in, one on the list. */
        expect(await screen.findByText(/Imported 1 of 3 rows as list 12/)).toBeInTheDocument();
        expect(screen.getByText(/2 rows are not on it/)).toBeInTheDocument();
        expect(commit.calls).toContain('POST /api/projects/uh/uh/imports');
        expect(calls).toContain('POST /api/projects/uh/uh/imports/preview');
        // The preview is cleared, so the same file cannot be committed twice by accident.
        await waitFor(() => expect(screen.queryByText('1 of 3 rows will be imported')).not.toBeInTheDocument());
    });

    it('shows the server validation details and keeps the preview on screen', async () => {
        stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));
        await screen.findByText('1 of 3 rows will be imported');

        stub(baseRoutes, { status: 400, body: { error: 'No rows would be imported.', details: ['fix the blocked rows first'] } });
        fireEvent.click(screen.getByRole('button', { name: 'Import 1 orders' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('No rows would be imported.');
        expect(screen.getByText('1 of 3 rows will be imported')).toBeInTheDocument();
    });

    it('warns when a required column is not mapped and blocks the import', async () => {
        stub(baseRoutes, { status: 200, body: { ...preview, missingRequired: ['zip'], summary: { ...preview.summary, willImport: 0 }, rows: [] } });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/No column is mapped for: ZIP/);
        expect(screen.getByRole('button', { name: /^Import 0 orders$/ })).toBeDisabled();
    });

    it('says the file was already imported', async () => {
        stub(baseRoutes, { status: 200, body: { ...preview, alreadyImportedListId: 5 } });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));
        expect(await screen.findByText(/already imported as list 5/)).toBeInTheDocument();
    });

    it('tells a member who cannot import why, and offers no controls', async () => {
        stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport={false} />);
        expect(await screen.findByText(/need the admin role/)).toBeInTheDocument();
        expect(screen.queryByLabelText('Pharmacy')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Review the file' })).not.toBeInTheDocument();
    });

    it('lists recent imports', async () => {
        stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [{
                id: 3, site: { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
                serviceDate: '2026-09-14', status: 'released', receivedAt: '2026-09-14T17:00:00.000Z',
                sourceFilename: 'manifest.xlsx', rowCount: 8, orderCount: 5, skippedCount: 3, importedBy: 'admin',
            }],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        const row3 = (await screen.findByText('manifest.xlsx')).closest('tr')!;
        expect(within(row3).getByText('2026-09-14')).toBeInTheDocument();
        expect(within(row3).getByText('5')).toBeInTheDocument();
    });

    it('offers each list as a download, pointed at that list and no other', async () => {
        /* "Send me the list the pharmacy sent" used to mean filtering the
           orders export to a date and a pharmacy, which is wrong twice: a
           pharmacy can send two lists for one day, and an order added by
           hand afterwards falls inside the same filter. The link is keyed on
           the list id so it cannot pick up either. */
        stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [{
                id: 3, site: { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
                serviceDate: '2026-09-14', status: 'released', receivedAt: '2026-09-14T17:00:00.000Z',
                sourceFilename: 'manifest.xlsx', rowCount: 8, orderCount: 5, skippedCount: 3, importedBy: 'admin',
            }, {
                id: 4, site: { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy' },
                serviceDate: '2026-09-14', status: 'released', receivedAt: '2026-09-14T19:00:00.000Z',
                sourceFilename: 'second-run.xlsx', rowCount: 2, orderCount: 2, skippedCount: 0, importedBy: 'admin',
            }],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);

        /* TWO LISTS, ONE PHARMACY, ONE DAY -- the case a filtered export
           cannot tell apart. Each row's link must carry its own id. */
        const first = (await screen.findByText('manifest.xlsx')).closest('tr')!;
        const second = (await screen.findByText('second-run.xlsx')).closest('tr')!;
        expect(within(first).getByRole('link', { name: /Download/ }))
            .toHaveAttribute('href', '/api/projects/uh/uh/imports/3/export.xlsx');
        expect(within(second).getByRole('link', { name: /Download/ }))
            .toHaveAttribute('href', '/api/projects/uh/uh/imports/4/export.xlsx');
    });
    /* ───────── the preview and the import disagreeing (28 October 2026) */

    const previewed = async () => {
        const r = stub(baseRoutes);
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        await screen.findByText('Daily list import');
        fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
        pickFile();
        fireEvent.click(screen.getByRole('button', { name: 'Review the file' }));
        await screen.findByText('1 of 3 rows will be imported');
        return r;
    };

    it('REFUSES TO IMPORT once a column has moved under the preview', async () => {
        /* Changing a column updates what the commit sends but does not
           re-run the preview, so the table on screen stops describing what
           would be created. Confirming one thing and importing another is
           the whole failure: with ZIP or Recipient name pointed at the
           wrong column it is a list of deliveries to the wrong addresses,
           approved against a preview of the right ones. */
        await previewed();
        expect(screen.getByRole('button', { name: /^Import \d+ orders$/ })).toBeEnabled();

        fireEvent.change(screen.getByLabelText(/^ZIP/), { target: { value: 'Address 1' } });

        expect(screen.getByRole('button', { name: /^Import \d+ orders$/ })).toBeDisabled();
        expect(screen.getByText(/columns have changed since this preview was read/i)).toBeInTheDocument();
    });

    it('points at the control that fixes it rather than just refusing', async () => {
        await previewed();
        fireEvent.change(screen.getByLabelText(/^ZIP/), { target: { value: 'Address 1' } });
        /* The warning names the control, and the control is right there.
           Both, because a refusal with no way forward is worse than the
           bug it prevents. */
        expect(screen.getByRole('status')).toHaveTextContent('Re-read with these columns');
        expect(screen.getByRole('button', { name: 'Re-read with these columns' })).toBeEnabled();
    });

    it('lets the import through again once the preview is re-read', async () => {
        await previewed();
        fireEvent.change(screen.getByLabelText(/^ZIP/), { target: { value: 'Address 1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Re-read with these columns' }));

        /* The stub answers with the same preview, whose mapping becomes the
           new baseline -- which is exactly what the server does. */
        await waitFor(() => {
            expect(screen.getByRole('button', { name: /^Import \d+ orders$/ })).toBeEnabled();
        });
        expect(screen.queryByText(/columns have changed/i)).not.toBeInTheDocument();
    });

    it('does not cry change when a column is put back the way it was', async () => {
        /* The fingerprint is sorted for this: JSON.stringify follows
           insertion order, so unmapping and remapping the same column read
           as a change and demanded a re-read that would do nothing. */
        await previewed();
        const zip = screen.getByLabelText(/^ZIP/);
        fireEvent.change(zip, { target: { value: '' } });
        expect(screen.getByRole('button', { name: /^Import \d+ orders$/ })).toBeDisabled();

        fireEvent.change(zip, { target: { value: 'Zip Code' } });
        expect(screen.getByRole('button', { name: /^Import \d+ orders$/ })).toBeEnabled();
    });

    it('names the person who uploaded a list, not their username', async () => {
        /* A pharmacy counter's username is an address. */
        stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [{
                id: 4, site: { id: 9, code: 'green', name: 'University Health Robert B. Green Pharmacy' },
                serviceDate: '2026-10-28', status: 'released', receivedAt: '2026-10-28T17:00:00.000Z',
                sourceFilename: 'green.csv', rowCount: 8, orderCount: 8, skippedCount: 0,
                importedBy: 'dana.whitfield@example.com', importedByName: 'Dana Whitfield',
            }],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        const row4 = (await screen.findByText('green.csv')).closest('tr')!;
        expect(within(row4).getByText('Dana Whitfield')).toBeInTheDocument();
        expect(within(row4).queryByText('dana.whitfield@example.com')).not.toBeInTheDocument();
    });

    it('falls back to the username when a server sends no name', async () => {
        /* A deployed bundle can be newer than the server for a minute. */
        stub({
            ...baseRoutes,
            'GET /api/projects/uh/uh/imports': [{
                id: 5, site: { id: 9, code: 'green', name: 'University Health Robert B. Green Pharmacy' },
                serviceDate: '2026-10-28', status: 'released', receivedAt: '2026-10-28T17:00:00.000Z',
                sourceFilename: 'older.csv', rowCount: 1, orderCount: 1, skippedCount: 0, importedBy: 'uh.green',
            }],
        });
        render(<ListImport projectCode="uh" timezone="America/Chicago" canImport />);
        const row5 = (await screen.findByText('older.csv')).closest('tr')!;
        expect(within(row5).getByText('uh.green')).toBeInTheDocument();
    });
});
