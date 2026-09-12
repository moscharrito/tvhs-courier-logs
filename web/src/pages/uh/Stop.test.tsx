/* The stop screen.

   What is worth testing here is not the layout, it is the small set of rules
   that decide whether a delivery record is worth anything in a dispute:
   a doorstep drop is not offered at all when the medication needs a signature,
   a delivery cannot be recorded without both a name and a signature, a dry run
   needs a reason for every item, and the photo reaches the bucket before the
   delivery is claimed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Stop } from './Stop';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';
import { IDBFactory } from 'fake-indexeddb';
import { queued, resetOutboxForTests } from '../../lib/outbox';

const session = { id: 4, username: 'ada.courier', name: 'Ada Courier', role: 'driver', route: null };
const projects = [{ id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier' }];

const ORDER = '/api/projects/uh/uh/orders/21';

const order = (over: Record<string, unknown> = {}) => ({
    id: 21,
    recipientName: 'Ines Vargas',
    recipientPhone: '210-555-0134',
    address: '1200 Encanto Street',
    city: 'San Antonio',
    zip: '78215',
    status: 'picked_up',
    serviceType: 'stat',
    dueAt: '2026-09-12T18:00:00.000Z',
    arrivedAt: null,
    deliveryNotes: '',
    signatureRequired: false,
    packages: [
        { id: 51, description: 'Oral solids', quantity: 2, signatureRequired: false, outcome: 'pending' },
    ],
    ...over,
});

const routes = (over: Record<string, unknown> = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/files/status/check': { available: true, reason: '' },
    [`GET ${ORDER}`]: order(),
    ...over,
});

function renderStop(r: Record<string, unknown> = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/orders/21/stop']}>
            <AuthProvider>
                <Routes><Route path="/projects/:code/orders/:orderId/stop" element={<Stop />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

/** Draw on the pad. jsdom has no layout and no PointerEvent, so the box is
 *  given a size and the coordinates are put on the event by hand. */
function sign() {
    const pad = screen.getByRole('application', { name: 'Recipient signature' });
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    if (!pad.setPointerCapture) pad.setPointerCapture = () => {};
    pad.releasePointerCapture = () => {};
    const point = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number, clientY: number) => {
        const evt = (createEvent as unknown as Record<string, (el: Element, init: object) => Event>)[type]!(pad, { pointerId: 1 });
        Object.defineProperty(evt, 'clientX', { value: clientX });
        Object.defineProperty(evt, 'clientY', { value: clientY });
        fireEvent(pad, evt);
    };
    point('pointerDown', 20, 50);
    point('pointerMove', 80, 20);
    point('pointerMove', 140, 60);
    point('pointerUp', 140, 60);
}

const bodyOf = (fn: ReturnType<typeof mockFetch>['fn'], key: string) => {
    const call = fn.mock.calls.find(([url, init]) => `${((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${String(url)}` === key);
    return JSON.parse(String((call?.[1] as RequestInit).body));
};

const setOnline = (online: boolean) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
};

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetOutboxForTests();
    setOnline(true);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 29.5, longitude: -98.6 } } as GeolocationPosition) },
    });
});

describe('Stop', () => {
    it('asks for the arrival on its own, because that is the time that is measured', async () => {
        const { fn } = renderStop({ ...routes(), [`POST ${ORDER}/arrive`]: { status: 201, body: { status: 'arrived' } } });
        await screen.findByRole('heading', { name: 'Stop' });

        fireEvent.click(screen.getByRole('button', { name: 'I have arrived' }));
        await waitFor(() => expect(screen.getByText('Arrival recorded.')).toBeInTheDocument());
        // The position goes with it: Scope 1.2.8 wants where the courier was.
        expect(bodyOf(fn, `POST ${ORDER}/arrive`)).toMatchObject({ lat: 29.5, lng: -98.6 });
    });

    it('stops asking once the courier has arrived', async () => {
        renderStop({ ...routes(), [`GET ${ORDER}`]: order({ arrivedAt: '2026-09-12T17:40:00.000Z' }) });
        await screen.findByRole('heading', { name: 'Stop' });
        expect(screen.queryByRole('button', { name: 'I have arrived' })).not.toBeInTheDocument();
    });

    it('does not offer the door when the medication needs a signature', async () => {
        /* Scope 1.2.3 allows a doorstep drop "depending on the medication
           type". A control a courier can see is a control a courier will try,
           so it is absent, not disabled. */
        renderStop({ ...routes(), [`GET ${ORDER}`]: order({ signatureRequired: true }) });
        await screen.findByRole('heading', { name: 'Stop' });

        expect(screen.queryByRole('button', { name: 'Left at the door' })).not.toBeInTheDocument();
        expect(screen.getByText(/cannot be left at the door/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Could not deliver' })).toBeInTheDocument();
    });

    it('does not offer the door when one package of several needs a signature', async () => {
        renderStop({
            ...routes(),
            [`GET ${ORDER}`]: order({
                packages: [
                    { id: 51, description: 'Oral solids', quantity: 1, signatureRequired: false, outcome: 'pending' },
                    { id: 52, description: 'Controlled', quantity: 1, signatureRequired: true, outcome: 'pending' },
                ],
            }),
        });
        await screen.findByRole('heading', { name: 'Stop' });
        expect(screen.queryByRole('button', { name: 'Left at the door' })).not.toBeInTheDocument();
    });

    it('will not record a delivery without both a name and a signature', async () => {
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));

        const submit = screen.getByRole('button', { name: 'Record the delivery' });
        expect(submit).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        expect(submit).toBeDisabled();

        sign();
        expect(screen.getByRole('button', { name: 'Record the delivery' })).toBeEnabled();
    });

    it('sends the signature as strokes, not as a picture', async () => {
        const { fn } = renderStop({ ...routes(), [`POST ${ORDER}/deliver`]: { status: 201, body: { status: 'delivered' } } });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        sign();
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        await waitFor(() => expect(screen.getByText('Delivered and signed for.')).toBeInTheDocument());
        const body = bodyOf(fn, `POST ${ORDER}/deliver`);
        expect(body.signedName).toBe('Ines Vargas');
        expect(body.strokes[0].length).toBeGreaterThan(2);
        expect(body.strokes[0][0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    });

    it('needs a reason for every item before a dry run can be recorded', async () => {
        // The contract bills a dry run per item, so the reason is what the
        // invoice line rests on.
        renderStop({
            ...routes(),
            [`GET ${ORDER}`]: order({
                packages: [
                    { id: 51, description: 'Oral solids', quantity: 1, signatureRequired: false, outcome: 'pending' },
                    { id: 52, description: 'Refrigerated', quantity: 1, signatureRequired: false, outcome: 'pending' },
                ],
            }),
        });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Could not deliver' }));

        const submit = screen.getByRole('button', { name: 'Record the attempt' });
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Reason for package 51'), { target: { value: 'no_access' } });
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Reason for package 52'), { target: { value: 'refused' } });
        expect(submit).toBeEnabled();
    });

    it('makes "something else" say what happened', async () => {
        const { fn } = renderStop({ ...routes(), [`POST ${ORDER}/attempt`]: { status: 201, body: { status: 'failed' } } });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Could not deliver' }));
        fireEvent.change(screen.getByLabelText('Reason for package 51'), { target: { value: 'other' } });

        expect(screen.getByRole('button', { name: 'Record the attempt' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Note for package 51'), { target: { value: 'Building was locked and the gate code failed' } });
        fireEvent.click(screen.getByRole('button', { name: 'Record the attempt' }));

        await waitFor(() => expect(screen.getByText('Recorded as a dry run.')).toBeInTheDocument());
        expect(bodyOf(fn, `POST ${ORDER}/attempt`).packages).toEqual([
            { packageId: 51, reasonCode: 'other', note: 'Building was locked and the gate code failed' },
        ]);
    });

    it('puts the photo in the bucket before it claims the delivery', async () => {
        /* If the delivery were claimed first, a failed upload would leave a
           doorstep drop on the record with no photo behind it. */
        const { fn, calls } = renderStop({
            ...routes(),
            'POST /api/projects/uh/uh/files': {
                status: 201,
                body: { id: 9, upload: { method: 'PUT', url: 'https://bucket.example/put?sig=x', headers: { 'Content-Type': 'image/jpeg' } } },
            },
            'PUT https://bucket.example/put?sig=x': {},
            'POST /api/projects/uh/uh/files/9/stored': { id: 9, status: 'stored' },
            [`POST ${ORDER}/doorstep`]: { status: 201, body: { status: 'delivered', photoFileId: 9 } },
        });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Left at the door' }));

        const photo = new File(['pretend jpeg bytes'], 'door.jpg', { type: 'image/jpeg' });
        fireEvent.change(screen.getByLabelText(/Photo of where you left it/), { target: { files: [photo] } });
        fireEvent.change(screen.getByLabelText(/Why nobody signed/), { target: { value: 'Nobody answered, left inside the screen door' } });
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        /* A doorstep delivery always goes through the offline queue: the photo
           has to be in the bucket before the delivery is claimed, and that is
           the queue's job whether or not there is signal right now. */
        await waitFor(() => expect(screen.getByText(/Saved on this phone/)).toBeInTheDocument());
        const expected = ['POST /api/projects/uh/uh/files', 'PUT https://bucket.example/put?sig=x', 'POST /api/projects/uh/uh/files/9/stored', `POST ${ORDER}/doorstep`];
        await waitFor(() => expect(calls.filter((c) => expected.includes(c))).toEqual(expected));
        expect(bodyOf(fn, `POST ${ORDER}/doorstep`)).toMatchObject({ fileId: 9, noSignatureReason: 'Nobody answered, left inside the screen door' });
    });

    it('says so rather than pretending when photo storage is not switched on', async () => {
        renderStop({ ...routes(), 'GET /api/projects/uh/uh/files/status/check': { available: false, reason: 'S3 is not configured' } });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Left at the door' }));

        expect(await screen.findByText(/photo storage is not switched on yet/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Record the delivery' })).toBeDisabled();
    });

    it('shows the server refusal instead of a generic failure', async () => {
        renderStop({
            ...routes(),
            [`POST ${ORDER}/deliver`]: { status: 409, body: { error: 'A delivered order cannot be delivered again', code: 'transition.invalid' } },
        });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        sign();
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A delivered order cannot be delivered again'));
    });

    it('accepts the delivery with no signal and says it is on the phone', async () => {
        /* A courier in a stairwell has still made the delivery. Being told to
           check their signal means doing it again later from memory, or not
           at all. */
        setOnline(false);
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        sign();
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        await waitFor(() => expect(screen.getByText(/Saved on this phone/)).toBeInTheDocument());
        const waiting = await queued();
        expect(waiting).toHaveLength(1);
        expect(waiting[0]).toMatchObject({ orderId: 21, label: expect.stringContaining('Delivery for Ines Vargas') });
        expect(waiting[0]!.body).toMatchObject({ signedName: 'Ines Vargas' });

        // And the stop stops offering an outcome it has already been given.
        expect(screen.getByRole('heading', { name: 'Waiting to send' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Handed over' })).not.toBeInTheDocument();
    });

    it('offers nothing to record on a stop that is already finished', async () => {
        renderStop({ ...routes(), [`GET ${ORDER}`]: order({ status: 'delivered', arrivedAt: '2026-09-12T17:40:00.000Z' }) });
        await screen.findByRole('heading', { name: 'Stop' });

        expect(screen.getByRole('heading', { name: 'Finished' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Handed over' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Could not deliver' })).not.toBeInTheDocument();
    });
});
