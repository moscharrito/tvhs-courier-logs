/* Taking a STAT call. The deadline has to be visible before the dispatcher
   commits, and the result has to say what the order actually became. */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewOrder } from './NewOrder';
import { mockFetch } from '../../test/setup';

const sites = [
    { id: 7, code: 'discharge', name: 'University Hospital Discharge Pharmacy', type: 'pharmacy', addressLine: '4502 Medical Drive', city: 'San Antonio', state: 'TX', zip: '78229', fullAddress: '', lat: null, lng: null, geocodeStatus: 'pending', releasesList: true, status: 'active', notes: '' },
];

const routes = { 'GET /api/projects/uh/uh/sites': sites };

function fill() {
    fireEvent.change(screen.getByLabelText('Pharmacy'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'Ines Vargas' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '1100 Broadway St' } });
    fireEvent.change(screen.getByLabelText('ZIP'), { target: { value: '78215' } });
}

describe('NewOrder', () => {
    it('offers nothing at all to someone who cannot create orders', () => {
        mockFetch(routes);
        const { container } = render(<NewOrder projectCode="uh" canCreate={false} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says STAT is two hours, and that it is also one hour from pickup', async () => {
        mockFetch(routes);
        render(<NewOrder projectCode="uh" canCreate />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));

        expect(screen.getByText(/Saved now, this is due by/)).toBeInTheDocument();
        expect(screen.getByText(/one hour of pickup/)).toBeInTheDocument();
    });

    it('drops the pickup clock line for ad hoc, which has no such rule', async () => {
        mockFetch(routes);
        render(<NewOrder projectCode="uh" canCreate />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'adhoc' } });
        expect(screen.queryByText(/one hour of pickup/)).not.toBeInTheDocument();
    });

    it('creates the order and reports its number, deadline and zone', async () => {
        const { calls } = mockFetch({
            ...routes,
            'POST /api/projects/uh/uh/orders': {
                id: 41, serviceType: 'stat', status: 'ready', zone: 1,
                dueAt: '2026-09-14T19:00:00.000Z', recipientName: 'Ines Vargas',
            },
        });
        render(<NewOrder projectCode="uh" canCreate />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Create order' }));

        expect(await screen.findByRole('status')).toHaveTextContent(/Order 41 created and ready for dispatch/);
        expect(screen.getByRole('status')).toHaveTextContent(/Zone 1/);
        expect(calls).toContain('POST /api/projects/uh/uh/orders');
        // The form closes, so the same call is not saved twice by accident.
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Create order' })).not.toBeInTheDocument());
    });

    it('warns when the address is outside the zone list rather than staying silent', async () => {
        mockFetch({
            ...routes,
            'POST /api/projects/uh/uh/orders': {
                id: 42, serviceType: 'stat', status: 'ready', zone: null,
                dueAt: '2026-09-14T19:00:00.000Z', recipientName: 'Theo Nakamura',
            },
        });
        render(<NewOrder projectCode="uh" canCreate />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
        expect(await screen.findByRole('status')).toHaveTextContent(/Out of area, so it needs a distance/);
    });

    it('shows the server validation details and keeps the form open', async () => {
        mockFetch({
            ...routes,
            'POST /api/projects/uh/uh/orders': { status: 400, body: { error: 'Invalid request', details: ['zip: five digit ZIP, optionally ZIP+4'] } },
        });
        render(<NewOrder projectCode="uh" canCreate />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take an order' }));
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Create order' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request');
        expect(screen.getByText('zip: five digit ZIP, optionally ZIP+4')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create order' })).toBeInTheDocument();
    });
});
