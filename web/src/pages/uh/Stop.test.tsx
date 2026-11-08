/* The stop screen.

   What is worth testing here is not the layout, it is the small set of rules
   that decide whether a delivery record is worth anything in a dispute:
   a doorstep drop is not offered at all when the medication needs a signature,
   a delivery cannot be recorded without both a name and a signature, a dry run
   needs a reason for every item, and the photo reaches the bucket before the
   delivery is claimed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { Stop } from './Stop';
import { AuthProvider } from '../../app/auth';
import { mockFetch } from '../../test/setup';
import { IDBFactory } from 'fake-indexeddb';
import { queued, rejections, resetOutboxForTests } from '../../lib/outbox';

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

/* A contract that allows a doorstep drop, for the tests about the mechanism
   rather than about the prohibition. */
const DOORSTEP_ALLOWED = {
    'GET /api/projects/uh/settings': { settings: { delivery: { personalHandoverOnly: false } } },
};

const routes = (over: Record<string, unknown> = {}) => ({
    'GET /api/session': session,
    'GET /api/me/projects': projects,
    'GET /api/projects/uh/uh/files/status/check': { available: true, reason: '' },
    /* Addendum 2 clause 4: University Health forbid leaving a package
       unattended, so the default here is the contract the product actually
       runs under. The tests that exercise the doorstep flow turn it off,
       because the capability still exists for a contract that permits one. */
    'GET /api/projects/uh/settings': { settings: { delivery: { personalHandoverOnly: true } } },
    [`GET ${ORDER}`]: order(),
    ...over,
});

/* Where the router thinks we are. The screen navigates on its own now --
   a second attempt lands on the delivery it created -- and "did it go
   there" is the assertion, not "did it call something". */
function LocationProbe() {
    const at = useLocation();
    return (
        <>
            <span data-testid="location">{at.pathname}</span>
            <span data-testid="search">{at.search}</span>
        </>
    );
}

function renderStop(r: Record<string, unknown> = routes()) {
    const mocked = mockFetch(r);
    render(
        <MemoryRouter initialEntries={['/projects/uh/orders/21/stop']}>
            <AuthProvider>
                <LocationProbe />
                <Routes><Route path="/projects/:code/orders/:orderId/stop" element={<Stop />} /></Routes>
            </AuthProvider>
        </MemoryRouter>,
    );
    return mocked;
}

/** Draw on the pad. jsdom has no layout and no PointerEvent, so the box is
 *  given a size and the coordinates are put on the event by hand. */
/* THE RECIPIENT'S PAD IS GONE from the deliver screen (17 October): the
   pharmacy's form is signed on paper and photographed, so asking for a
   scrawl on glass too was asking one person to sign twice. These tests
   now prove the handover the way the screen does.

   Kept as a helper rather than inlined, because the courier's own
   countersignature on a controlled handover IS still drawn and uses the
   same pointer dance. */
/* THERE IS ONLY ONE BRANCH NOW. This used to type a reason instead of
   attaching a photograph, because the server took either. It takes only the
   photograph, on every delivery, so proving a handover means attaching one
   and every test that proves one pays the cost of the file service. */
function proveHandover() {
    attachForm();
}

function attachForm() {
    const input = screen.getByLabelText(/Photo of the signed form/) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'form.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
}

/** The three steps the uploader takes, so a photo test can reach a bucket. */
const fileRoutes = {
    'POST /api/projects/uh/uh/files': { id: 99, upload: { url: 'https://bucket.test/put', method: 'PUT', headers: {} } },
    'PUT https://bucket.test/put': { ok: true },
    'POST /api/projects/uh/uh/files/99/stored': { ok: true },
};

function drawOn(label: string) {
    const pad = screen.getByRole('application', { name: label });
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

const sign = () => drawOn('Recipient signature');

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

    /* ───────────────────────────────── the call, 4 November 2026
     *
     * It was a card of its own in the sheet, under the panel. Two costs:
     * it took a full row away from the three endings a driver came here
     * to choose between, and it sat apart from the one thing that says
     * who would answer it. Ringing somebody is a thing you do to a
     * person, so it belongs beside their name. */

    it('puts the call beside the name, as something a thumb can hit', async () => {
        renderStop();
        const panel = await screen.findByRole('group', { name: 'This delivery' });
        const call = within(panel).getByRole('link', { name: /Call Ines Vargas/ });
        expect(call).toHaveAttribute('href', 'tel:210-555-0134');
    });

    it('names who is being rung, because "Call" on its own names nobody', async () => {
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        expect(screen.getByRole('link', { name: 'Call Ines Vargas on 210-555-0134' })).toBeInTheDocument();
    });

    it('does not print the number beside the button that dials it', async () => {
        /* The button is the whole of it. This panel does not scroll away
           while the form below is filled in, so a line repeating what the
           control beside it already carries is a line the form never gets.
           One action, one control. */
        renderStop();
        const panel = await screen.findByRole('group', { name: 'This delivery' });
        expect(within(panel).queryByText('210-555-0134')).not.toBeInTheDocument();
        expect(within(panel).getAllByRole('link')).toHaveLength(1);
    });

    it('offers nothing to dial when the pharmacy sent no number', async () => {
        renderStop({ ...routes(), [`GET ${ORDER}`]: order({ recipientPhone: '' }) });
        await screen.findByRole('heading', { name: 'Stop' });
        expect(screen.queryByRole('link', { name: /^Call / })).not.toBeInTheDocument();
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

    it('offers the camera when the pharmacy stamped ID Required', async () => {
        /* FOUND ON A PHONE, 17 OCTOBER. The server refuses a delivery marked
           ID Required without patientIdFileId, and this screen had no way to
           supply one: a courier got a red server error at the door with no
           control to satisfy it. The phone app had the capture; the web
           never got it, which mattered the moment drivers moved to the
           browser because Apple enrolment was late. */
        renderStop(routes({ 'GET /api/projects/uh/uh/orders/21': order({ idRequired: true }) }));
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));

        expect(screen.getByText(/ID Required/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Photo of the identification/)).toBeInTheDocument();
    });

    it('does not ask for identification when the pharmacy did not', async () => {
        /* A control demanded at every door is one nobody reads. */
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        expect(screen.queryByLabelText(/Photo of the identification/)).not.toBeInTheDocument();
    });

    it('lets a courier choose a photo as well as take one', async () => {
        /* It used to carry capture="environment", which opens the rear
           camera AND removes the choice: no library, no file, one tap and no
           way round it.

           Reported from a real handset on 30 October: the in-page camera
           opened to a black frame and would not show or take anything. That
           sheet belongs to the browser, not to us, and when it misbehaves a
           courier at a door has no second option and the delivery cannot be
           recorded at all.

           Without the attribute the phone offers its own chooser -- Take
           Photo, Photo Library, Browse -- so the camera is still one tap
           away and it is the phone's own camera app rather than an embedded
           sheet. Asserted because the attribute is one word and would come
           back without anybody noticing. */
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));

        const form = screen.getByLabelText(/Photo of the signed form/);
        expect(form).not.toHaveAttribute('capture');
        /* Still a photo field: the accept list is what keeps a PDF out. */
        expect(form).toHaveAttribute('accept', expect.stringContaining('image/'));
    });

    it('offers no camera of its own: the file chooser is the only way in', async () => {
        /* IT WAS A SECOND DOOR WE BUILT OURSELVES, on 31 October, after a
           courier tapped the field, chose Take Photo and got a black frame.
           The operating system’s chooser turned out to be fine -- on both
           collection and drop-off -- and the extra button sat under the one
           screen a driver uses at a doorstep, confusing it. Removed on
           2 November at the owner’s instruction.

           This is the screen that had two of them, for the form and for the
           identification, so it is the one worth pinning at zero. */
        renderStop(routes({ 'GET /api/projects/uh/uh/orders/21': order({ idRequired: true }) }));
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));

        expect(screen.queryAllByRole('button', { name: 'Take a picture' })).toHaveLength(0);
        /* And both fields still take a photograph, which is the thing that
           must not have been removed with the button. */
        for (const f of screen.getAllByLabelText(/Photo of/)) {
            expect(f).toHaveAttribute('accept', 'image/*');
        }
    });

    it('names a file the server would refuse, rather than letting it become a four-hundred', async () => {
        /* This field took whatever it was handed and checked nothing, while
           the doorstep field below it validated -- and this is the path every
           ordinary delivery goes down. */
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));

        /* The name goes in FIRST, deliberately. With it missing the record
           button is disabled for that reason alone, and an assertion about
           the refused file would pass whether the file was refused or not. */
        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });

        const field = screen.getByLabelText(/Photo of the signed form/) as HTMLInputElement;
        const docket = new File(['%PDF-1.4'], 'docket.pdf', { type: 'application/pdf' });
        fireEvent.change(field, { target: { files: [docket] } });

        expect(await screen.findByText(/not a photo this app can store/i)).toBeInTheDocument();
        /* And it is not held on to: the record button stays shut, and says
           the photograph is what is missing. */
        expect(screen.getByRole('button', { name: /Record the delivery/ })).toBeDisabled();
        expect(screen.getByText('Photograph the signed form.')).toBeInTheDocument();
    });

    it('always offers the signed form, because the signature moved onto paper', async () => {
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        expect(screen.getByLabelText(/Photo of the signed form/)).toBeInTheDocument();
    });

    it('will not record a delivery without both a name and some proof', async () => {
        renderStop();
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));

        const submit = screen.getByRole('button', { name: 'Record the delivery' });
        expect(submit).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        expect(submit).toBeDisabled();

        proveHandover();
        expect(screen.getByRole('button', { name: 'Record the delivery' })).toBeEnabled();
    });

    it('sends the photographed form as the proof, and nothing else', async () => {
        const { fn } = renderStop({ ...routes(), ...fileRoutes, [`POST ${ORDER}/deliver`]: { status: 201, body: { status: 'delivered' } } });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        attachForm();
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        /* THROUGH THE QUEUE, EVEN ON FULL SIGNAL. A photograph has to reach
           the bucket before the delivery that references it, so the entry is
           queued and drained immediately rather than posted inline. The
           screen says so in those words. */
        await waitFor(() => expect(screen.getByText(/Saved on this phone and sending now/)).toBeInTheDocument());
        await waitFor(() => expect(bodyOf(fn, `POST ${ORDER}/deliver`)).toBeDefined());
        const body = bodyOf(fn, `POST ${ORDER}/deliver`);
        expect(body.signedName).toBe('Ines Vargas');
        /* THE PHOTOGRAPH IS THE PROOF, AND THE ONLY THING SENT.
           `strokes: []` used to ride along so the column kept its shape.
           Nothing draws a delivery signature any more, so sending an empty
           array every time was a field that could only ever be empty --
           and a reader of the request could not tell "captured nothing"
           from "cannot capture". It is absent now; the server defaults it. */
        expect(body.courierFormFileId).toBe(99);
        expect(body.strokes).toBeUndefined();
        /* And no reason, because there WAS a form. A reason beside a
           photograph would be a contradiction in the record. */
        expect(body.noSignatureReason).toBeUndefined();
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

        await waitFor(() => expect(screen.getByText('Successful. Proceed to your next stop.')).toBeInTheDocument());
        expect(bodyOf(fn, `POST ${ORDER}/attempt`).packages).toEqual([
            { packageId: 51, reasonCode: 'other', note: 'Building was locked and the gate code failed' },
        ]);
    });

    it('puts the photo in the bucket before it claims the delivery', async () => {
        /* If the delivery were claimed first, a failed upload would leave a
           doorstep drop on the record with no photo behind it. */
        const { fn, calls } = renderStop({
            ...routes(),
            ...DOORSTEP_ALLOWED,
            'POST /api/projects/uh/uh/files': {
                status: 201,
                body: { id: 9, upload: { method: 'PUT', url: 'https://bucket.example/put?sig=x', headers: { 'Content-Type': 'image/jpeg' } } },
            },
            'PUT https://bucket.example/put?sig=x': {},
            'POST /api/projects/uh/uh/files/9/stored': { id: 9, status: 'stored' },
            [`POST ${ORDER}/doorstep`]: { status: 201, body: { status: 'delivered', photoFileId: 9 } },
        });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(await screen.findByRole('button', { name: 'Left at the door' }));

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

    it('does not offer a doorstep drop on a contract that forbids one', async () => {
        /* ADDENDUM 2 CLAUSE 4. The server refuses the endpoint outright.
           Without this the screen would still show the button, and a courier
           would photograph a porch, type a reason, submit, and be told no,
           having already put the package down. */
        renderStop(routes());
        await screen.findByRole('heading', { name: 'Stop' });
        expect(screen.queryByRole('button', { name: 'Left at the door' })).not.toBeInTheDocument();
        /* The two that remain are the two the contract allows. */
        expect(screen.getByRole('button', { name: 'Handed over' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Could not deliver' })).toBeInTheDocument();
    });

    it('fails closed when it cannot read the contract', async () => {
        /* Refusing a doorstep that was allowed is a phone call. Recording one
           that was forbidden is a breach of the contract. */
        renderStop({ ...routes(), 'GET /api/projects/uh/settings': { status: 500, body: { error: 'nope' } } });
        await screen.findByRole('heading', { name: 'Stop' });
        expect(screen.queryByRole('button', { name: 'Left at the door' })).not.toBeInTheDocument();
    });

    it('says so rather than pretending when photo storage is not switched on', async () => {
        renderStop({
            ...routes(),
            ...DOORSTEP_ALLOWED,
            'GET /api/projects/uh/uh/files/status/check': { available: false, reason: 'S3 is not configured' },
        });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(await screen.findByRole('button', { name: 'Left at the door' }));

        expect(await screen.findByText(/photo storage is not switched on yet/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Record the delivery' })).toBeDisabled();
    });

    it('shows the server refusal instead of a generic failure', async () => {
        const { fn } = renderStop({
            ...routes(),
            ...fileRoutes,
            [`POST ${ORDER}/deliver`]: { status: 409, body: { error: 'A delivered order cannot be delivered again', code: 'transition.invalid' } },
        });
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        fireEvent.change(screen.getByLabelText(/Printed name/), { target: { value: 'Ines Vargas' } });
        proveHandover();
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        /* The refusal arrives through the queue now rather than inline,
           because the delivery is queued behind its photograph. What must
           not happen is the courier being told it saved: a 409 is a refusal
           and the entry is rejected, not retried forever. */
        await waitFor(() => expect(bodyOf(fn, `POST ${ORDER}/deliver`)).toBeDefined());
        await waitFor(async () => expect(await rejections()).toHaveLength(1));
        const [rejected] = await rejections();
        expect(rejected?.error).toMatch(/A delivered order cannot be delivered again/);
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
        proveHandover();
        fireEvent.click(screen.getByRole('button', { name: 'Record the delivery' }));

        await waitFor(() => expect(screen.getByText(/Saved on this phone/)).toBeInTheDocument());
        const waiting = await queued();
        expect(waiting).toHaveLength(1);
        expect(waiting[0]).toMatchObject({ orderId: 21, label: expect.stringContaining('Delivery for Ines Vargas') });
        expect(waiting[0]!.body).toMatchObject({ signedName: 'Ines Vargas' });

        // And the stop stops offering an outcome it has already been given.
        expect(screen.getByRole('heading', { name: 'Recorded' })).toBeInTheDocument();
        expect(screen.getByText('What you saved is recorded and sent to dispatch.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Handed over' })).not.toBeInTheDocument();
    });

    it('says what the record is in one word, with no paragraph under it', async () => {
        /* It opened as a wall of prose: a sentence under the heading, a
           sentence under every button, and "second attempt" twice. A
           driver at a door reads none of it. */
        renderStop({ ...routes(), [`GET ${ORDER}`]: order({ status: 'failed', arrivedAt: '2026-09-12T17:40:00.000Z' }) });
        await screen.findByRole('heading', { name: 'Not delivered' });

        expect(screen.queryByText(/second attempt/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/reattempt/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/stays on the record/i)).not.toBeInTheDocument();
    });

    it('offers nothing to RECORD on a stop that is already finished', async () => {
        renderStop({ ...routes(), [`GET ${ORDER}`]: order({ status: 'delivered', arrivedAt: '2026-09-12T17:40:00.000Z' }) });
        await screen.findByRole('heading', { name: 'Stop' });

        expect(screen.getByRole('heading', { name: 'Delivered' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Handed over' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Could not deliver' })).not.toBeInTheDocument();
    });

    /* ─────────────────────────────────────────────────────────────────────
     * AMENDING A STOP THAT ALREADY HAS AN OUTCOME (4 November 2026).
     *
     * This screen said "Finished" and offered a link back to the round, and
     * the run list did not link to a finished stop at all. Two things
     * happen often enough that the gate cost more than it protected: a
     * photograph of the signed form that came out blurred, and a dry run
     * where the patient rang the pharmacy back and the driver got there
     * again an hour later. Both were a telephone call to somebody holding
     * the admin role, or went unrecorded.
     *
     * The server has had both routes since 4 November and so has the Expo
     * app. Nobody was reaching them: the drivers are on the web.
     *
     * The property every one of these is testing: the picture can be
     * replaced and the outcome cannot.
     * ───────────────────────────────────────────────────────────────────── */

    const finished = (status: string, over: Record<string, unknown> = {}) => ({
        ...routes(),
        [`GET ${ORDER}`]: order({ status, arrivedAt: '2026-09-12T17:40:00.000Z', ...over }),
    });

    it('lets a driver add a better photograph of a delivery already recorded', async () => {
        renderStop(finished('delivered'));
        await screen.findByRole('heading', { name: 'Delivered' });
        expect(screen.getByRole('button', { name: 'Replace the signed form' })).toBeInTheDocument();
    });

    it('asks for the identification separately, where the pharmacy stamped it', async () => {
        renderStop(finished('delivered', { idRequired: true }));
        await screen.findByRole('heading', { name: 'Delivered' });
        expect(screen.getByRole('button', { name: 'Replace the ID photo' })).toBeInTheDocument();
    });

    it('does not ask for identification on a delivery that never needed it', async () => {
        renderStop(finished('delivered'));
        await screen.findByRole('heading', { name: 'Delivered' });
        expect(screen.queryByRole('button', { name: 'Replace the ID photo' })).not.toBeInTheDocument();
    });

    it('offers the second attempt on a failed stop', async () => {
        renderStop(finished('failed'));
        await screen.findByRole('heading', { name: 'Not delivered' });
        expect(screen.getByRole('button', { name: 'Handed over' })).toBeInTheDocument();
    });

    it('does not offer a second attempt on one that was delivered', async () => {
        /* A delivered stop is finished. Offering to deliver it again is how
           one delivery becomes two on an invoice. */
        renderStop(finished('delivered'));
        await screen.findByRole('heading', { name: 'Delivered' });
        expect(screen.queryByRole('button', { name: 'Handed over' })).not.toBeInTheDocument();
    });

    it('offers neither on a cancelled stop', async () => {
        /* Called off before anybody had the package: no handover to
           photograph and no door to have gone back to. The server refuses
           both routes for it, so the screen does not offer them. */
        renderStop(finished('cancelled'));
        await screen.findByRole('heading', { name: 'Cancelled' });
        expect(screen.queryByRole('button', { name: 'Replace the signed form' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Handed over' })).not.toBeInTheDocument();
    });

    it('asks the server for the second attempt and lands on the handover form', async () => {
        /* Not back to the round: the stop they are looking at is the
           first attempt and is finished, and hunting a list for a row
           that was not there a moment ago is how the wrong stop gets
           recorded. It lands on ?handover=1, which opens the form
           directly -- they have already said what they are doing. */
        const { fn } = renderStop({
            ...finished('failed'),
            [`POST ${ORDER}/redeliver`]: { status: 201, body: { id: 99, reattemptOf: 21, runId: 7 } },
            /* The delivery it made. Without this the screen it lands on
               has nothing to render and the assertion below would be
               about an error page. */
            'GET /api/projects/uh/uh/orders/99': order({ id: 99, status: 'picked_up' }),
        });
        await screen.findByRole('heading', { name: 'Not delivered' });

        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).endsWith('/redeliver'))).toBe(true));

        /* ON THE FORM, not on the menu above it. ?handover=1 carried them
           there and was then stripped, so the assertion is what is on
           screen rather than what is in the URL -- and stripping it is
           the point: Back out of the form must not read the flag again
           and put them straight back in.

           ONE waitFor FOR THE WHOLE LANDING, with room to breathe. The
           click starts a POST, a navigation, a GET for the new order and
           an effect that opens the form -- four turns of the loop. Three
           separate one-second waits in a row flaked about once in forty
           full-suite runs, which is often enough to teach somebody that a
           red suite means nothing. */
        await waitFor(() => {
            expect(screen.getByTestId('location')).toHaveTextContent('/projects/uh/orders/99/stop');
            expect(screen.getByRole('heading', { name: 'Handed over' })).toBeInTheDocument();
            expect(screen.getByTestId('search').textContent).not.toContain('handover');
        }, { timeout: 5000 });
    });

    it('says what went wrong rather than moving on, when the server refuses', async () => {
        /* 409 is the one that matters: the delivery is already going out
           again, because somebody tapped twice or dispatch got there
           first. Sending them to a second attempt that is not theirs would
           be worse than saying so. */
        renderStop({
            ...finished('failed'),
            [`POST ${ORDER}/redeliver`]: {
                status: 409,
                body: { error: 'This delivery is already going out again. Open that stop instead of this one.' },
            },
        });
        await screen.findByRole('heading', { name: 'Not delivered' });

        fireEvent.click(screen.getByRole('button', { name: 'Handed over' }));
        expect(await screen.findByText(/already going out again/)).toBeInTheDocument();
        expect(screen.getByTestId('location')).toHaveTextContent('/projects/uh/orders/21/stop');
    });
});

/* ─────────────────────────────── THE PHOTOGRAPH ON "COULD NOT DELIVER"
 *
 * "Handed over" has had a slot since the signature came off glass and this
 * had none. That is the whole of what drivers were reporting when they said
 * there was nowhere to upload: not a missing screen elsewhere, a missing
 * field on the form in front of them.
 *
 * Addendum 1 charges a flat fee for every item on an attempted delivery, so
 * a dry run is the invoice line most likely to be queried and the picture of
 * the shut office is what answers the query.
 */
describe('the stop that could not be completed', () => {
    const openAttempt = async () => {
        await screen.findByRole('heading', { name: 'Stop' });
        fireEvent.click(screen.getByRole('button', { name: 'Could not deliver' }));
        fireEvent.change(screen.getByLabelText('Reason for package 51'), { target: { value: 'no_access' } });
    };

    const picture = () => new File([new Uint8Array([1, 2, 3])], 'door.jpg', { type: 'image/jpeg' });

    it('offers a slot, in the place the driver already is', async () => {
        renderStop(routes());
        await openAttempt();
        expect(screen.getByLabelText(/Upload signed sheet/)).toBeInTheDocument();
    });

    it('sends the picture to the bucket and the file id with the attempt', async () => {
        const { fn, calls } = renderStop({
            ...routes(),
            ...fileRoutes,
            [`POST ${ORDER}/attempt`]: { status: 201, body: { status: 'failed', photoFileId: 99 } },
        });
        await openAttempt();
        fireEvent.change(screen.getByLabelText(/Upload signed sheet/), { target: { files: [picture()] } });
        fireEvent.click(screen.getByRole('button', { name: 'Record the attempt' }));

        /* THROUGH THE QUEUE, picture first. A dry run happens at a door
           nobody answered, which is disproportionately a basement or a
           gated yard -- uploading ahead of the record would make the stop
           most likely to need the photograph the one least able to send
           it, and a failure would record nothing at all. */
        const expected = [
            'POST /api/projects/uh/uh/files',
            'PUT https://bucket.test/put',
            'POST /api/projects/uh/uh/files/99/stored',
            `POST ${ORDER}/attempt`,
        ];
        await waitFor(() => expect(calls.filter((c) => expected.includes(c))).toEqual(expected));
        expect(bodyOf(fn, `POST ${ORDER}/attempt`)).toMatchObject({
            exceptionFileId: 99,
            packages: [{ packageId: 51, reasonCode: 'no_access', note: '' }],
        });
    });

    it('records the attempt without one, because there is not always something to photograph', async () => {
        /* OPTIONAL ON PURPOSE. A suite number the building has never had
           leaves a driver with nothing to point a camera at, and refusing
           the stop until they produce a picture of that would have them
           choosing between photographing a wall and recording nothing. */
        const { fn } = renderStop({
            ...routes(),
            [`POST ${ORDER}/attempt`]: { status: 201, body: { status: 'failed' } },
        });
        await openAttempt();
        expect(screen.getByRole('button', { name: 'Record the attempt' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Record the attempt' }));

        await waitFor(() => expect(screen.getByText('Successful. Proceed to your next stop.')).toBeInTheDocument());
        expect(bodyOf(fn, `POST ${ORDER}/attempt`).exceptionFileId).toBeUndefined();
    });

    it('refuses a file the bucket would refuse, before the driver waits on it', async () => {
        const { calls } = renderStop({ ...routes(), ...fileRoutes });
        await openAttempt();

        const wrong = new File([new Uint8Array(4)], 'clip.mov', { type: 'video/quicktime' });
        fireEvent.change(screen.getByLabelText(/Upload signed sheet/), { target: { files: [wrong] } });

        /* A sentence now rather than a four-hundred from the far end of a
           pharmacy car park. lib/photos.ts decides the type; the `accept`
           attribute is a hint to the chooser and not a check. */
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        /* NOT "nothing mentioning /files": the screen asks the status
           endpoint on load, so that assertion passed for the wrong reason
           and would have gone on passing if the upload had fired. */
        expect(calls).not.toContain('POST /api/projects/uh/uh/files');
    });

    it('hides the slot when there is nowhere to put a picture, and still records the stop', async () => {
        const { fn } = renderStop({
            ...routes(),
            'GET /api/projects/uh/uh/files/status/check': { available: false, reason: 'S3 is not configured' },
            [`POST ${ORDER}/attempt`]: { status: 201, body: { status: 'failed' } },
        });
        await openAttempt();

        /* Hidden rather than shown and then refused -- the doorstep form
           makes the same call. And the dry run is NOT blocked by it: the
           photograph is evidence for an invoice line, and the stop is the
           thing that has to be recorded either way. */
        await waitFor(() => expect(screen.queryByLabelText(/Upload signed sheet/)).not.toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Record the attempt' }));
        await waitFor(() => expect(bodyOf(fn, `POST ${ORDER}/attempt`)).toBeDefined());
    });

    it('keeps the attempt and the picture together with no signal', async () => {
        setOnline(false);
        renderStop({ ...routes(), ...fileRoutes });
        await openAttempt();
        fireEvent.change(screen.getByLabelText(/Upload signed sheet/), { target: { files: [picture()] } });
        fireEvent.click(screen.getByRole('button', { name: 'Record the attempt' }));

        await waitFor(() => expect(screen.getByText(/as soon as you have signal/)).toBeInTheDocument());
        const waiting = await queued();
        expect(waiting.length).toBe(1);
        /* The photograph is in the entry, not uploaded and lost. */
        expect(waiting[0]!.url).toContain('/attempt');
        expect(waiting[0]!.photos?.length).toBe(1);
        expect(waiting[0]!.photos?.[0]?.kind).toBe('exception');
    });

    /* ───────── AND AFTERWARDS, when the form has gone.
     *
     * The slot is optional, so a driver in a hurry skips it -- and once the
     * attempt is recorded the form is not on screen any more. Without a
     * second way in, a dry run photographed badly or not at all could never
     * be completed by anybody, which is exactly what made a return recorded
     * without its sheet unrepairable. */
    const finishedAs = (status: string) => ({
        ...routes(),
        [`GET ${ORDER}`]: order({ status, arrivedAt: '2026-09-12T17:40:00.000Z' }),
    });

    it('lets a driver add the photograph to a dry run already recorded', async () => {
        const { fn } = renderStop({
            ...finishedAs('failed'),
            ...fileRoutes,
            [`POST ${ORDER}/evidence`]: { status: 201, body: { status: 'failed' } },
        });
        await screen.findByRole('heading', { name: 'Not delivered' });
        fireEvent.click(screen.getByRole('button', { name: 'Add or replace the photo' }));

        fireEvent.change(screen.getByLabelText(/The signed sheet/), { target: { files: [picture()] } });
        fireEvent.click(screen.getByRole('button', { name: 'Add this photo' }));

        await waitFor(() => expect(bodyOf(fn, `POST ${ORDER}/evidence`)).toMatchObject({ kind: 'exception', fileId: 99 }));
    });

    it('does not offer it on a delivery that was handed over', async () => {
        /* The server refuses the kind on anything that was delivered
           (evidence.notFailed): the page it prints under says the sheet was
           uploaded when the delivery was recorded as ATTEMPTED, and on a
           handover that is false. A control a driver can see is a control a
           driver will try -- and the two labels are now one word apart. */
        renderStop(finishedAs('delivered'));
        await screen.findByRole('heading', { name: 'Delivered' });
        expect(screen.queryByRole('button', { name: 'Add or replace the photo' })).not.toBeInTheDocument();
    });
});
