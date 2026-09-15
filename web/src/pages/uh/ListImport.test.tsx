/* The import screen. What matters here is that a person cannot import
   without looking: the commit button is unreachable until a preview has been
   fetched, blocked rows cannot be selected, and duplicates start unticked. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { ListImport } from './ListImport';
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

        expect(await screen.findByText('Imported 1 orders as list 12.')).toBeInTheDocument();
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
});
