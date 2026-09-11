/* The settings card. Two things matter beyond rendering: a member who cannot
   manage gets no Edit button, and a changed value is visibly marked as
   changed rather than passing for a contract default. */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProjectSettings } from './ProjectSettings';
import { mockFetch } from '../test/setup';

const defaults = {
    sla: { clockStart: 'receipt', scheduledMinutes: 120, statMinutes: 120, statFromPickupMinutes: 60, adhocMinutes: 240 },
    businessHours: { start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] },
    listRelease: { earliest: '12:00', latest: '14:00' },
    pricing: { afterHoursStart: '20:00', afterHoursEnd: '07:00', dryRunReplacesBase: true },
};

const example = [
    { serviceType: 'scheduled', receivedAt: '2026-09-14T17:00:00.000Z', dueAt: '2026-09-14T19:00:00.000Z', minutes: 120, from: 'receipt', pending: false, basis: '120 minutes from the list being received.' },
    { serviceType: 'stat', receivedAt: '2026-09-14T17:00:00.000Z', dueAt: '2026-09-14T19:00:00.000Z', minutes: 120, from: 'receipt', pending: false, basis: '120 minutes from the request, and 60 minutes from pickup.' },
    { serviceType: 'adhoc', receivedAt: '2026-09-14T17:00:00.000Z', dueAt: '2026-09-14T21:00:00.000Z', minutes: 240, from: 'receipt', pending: false, basis: '240 minutes from the request.' },
];

const payload = (over: Partial<Record<string, unknown>> = {}) => ({
    timezone: 'America/Chicago',
    settings: defaults,
    defaults,
    overridden: [],
    canManage: true,
    example,
    ...over,
});

describe('ProjectSettings', () => {
    it('shows each value beside its contract default and the worked examples', async () => {
        mockFetch({ 'GET /api/projects/uh/settings': payload() });
        render(<ProjectSettings projectCode="uh" />);

        expect(await screen.findByText('Operating settings')).toBeInTheDocument();
        // "list received" is both the value and the default, so scope to the row.
        const clockRow = screen.getByText(/Scheduled clock starts at/).closest('tr')!;
        expect(within(clockRow).getAllByText('list received')).toHaveLength(2);
        expect(screen.getByText('120 min from request')).toBeInTheDocument();
        expect(screen.getByText('60 min from pickup')).toBeInTheDocument();
        expect(screen.getByText('replaces the delivery charge')).toBeInTheDocument();
        expect(screen.getByText('120 minutes from the list being received.')).toBeInTheDocument();
        // Nothing is marked as changed while everything is on the default.
        expect(screen.queryByText('changed')).not.toBeInTheDocument();
    });

    it('marks a value someone overrode, so it cannot pass for the contract default', async () => {
        mockFetch({
            'GET /api/projects/uh/settings': payload({
                settings: { ...defaults, pricing: { ...defaults.pricing, afterHoursEnd: '08:00' } },
                overridden: ['pricing.afterHoursEnd'],
            }),
        });
        render(<ProjectSettings projectCode="uh" />);

        const row = (await screen.findByText(/After hours/)).closest('tr')!;
        expect(within(row).getByText('changed')).toBeInTheDocument();
        expect(within(row).getByText('20:00 to 08:00')).toBeInTheDocument();
        expect(within(row).getByText('20:00 to 07:00')).toBeInTheDocument();
    });

    it('gives no Edit button to a member who cannot manage the project', async () => {
        mockFetch({ 'GET /api/projects/uh/settings': payload({ canManage: false }) });
        render(<ProjectSettings projectCode="uh" />);
        expect(await screen.findByText('Operating settings')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('saves a change and shows what came back', async () => {
        const saved = payload({
            settings: { ...defaults, sla: { ...defaults.sla, clockStart: 'pickup' } },
            overridden: ['sla.clockStart'],
            example: [{ ...example[0]!, dueAt: null, pending: true, from: 'pickup', basis: 'The clock starts at pickup, which has not happened yet.' }, example[1]!, example[2]!],
        });
        const { calls } = mockFetch({
            'GET /api/projects/uh/settings': payload(),
            'PATCH /api/projects/uh/settings': saved,
        });
        render(<ProjectSettings projectCode="uh" />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
        fireEvent.change(screen.getByLabelText(/Scheduled clock starts at/), { target: { value: 'pickup' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

        expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
        expect(calls).toContain('PATCH /api/projects/uh/settings');
        expect(screen.getByText('courier pickup')).toBeInTheDocument();
        expect(screen.getByText('changed')).toBeInTheDocument();
        expect(screen.getByText(/clock starts at pickup, which has not happened yet/)).toBeInTheDocument();
    });

    it('shows the validation details the API returns and stays in the form', async () => {
        mockFetch({
            'GET /api/projects/uh/settings': payload(),
            'PATCH /api/projects/uh/settings': { status: 400, body: { error: 'Invalid request', details: ['pricing.afterHoursEnd: expected HH:MM, 24-hour'] } },
        });
        render(<ProjectSettings projectCode="uh" />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request');
        expect(screen.getByText('pricing.afterHoursEnd: expected HH:MM, 24-hour')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled());
    });
});
