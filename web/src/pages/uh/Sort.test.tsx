/* The sort bench.
 *
 * What has to hold: the number goes in the BODY and never the URL, the
 * answer is legible, "nobody has it" is said out loud rather than left
 * as silence, and there is always a way through when the camera will not
 * play. The reader itself is mocked -- four megabytes of WebAssembly has
 * no business in a unit test, and the hard part of reading a sheet lives
 * in lib/phone-scan.ts, which is tested without any of this.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Sort } from './Sort';
import { mockFetch } from '../../test/setup';

const readDigits = vi.fn();
const scanSupported = vi.fn(() => true);
vi.mock('../../lib/read-sheet', () => ({
    readDigits: (...a: unknown[]) => readDigits(...a),
    scanSupported: () => scanSupported(),
    GUIDE: { x: 0.06, y: 0.38, w: 0.88, h: 0.24 },
}));

const LOOKUP = 'POST /api/projects/uh/uh/sort/lookup';

const match = (over: Record<string, unknown> = {}) => ({
    orderId: 51,
    reference: 'RX-912345671',
    patient: 'Test Patient Alpha',
    serviceDate: '2026-11-21',
    pharmacy: 'UH Pavilion Pharmacy',
    serviceType: 'scheduled',
    status: 'assigned',
    handling: [],
    driver: { username: 'ana', name: 'Ana Driver', run: 'Wheatley 1', stop: 4 },
    ...over,
});

const open = () => render(<Sort projectCode="uh" />);

/** jsdom has no camera. Give the page one that works. */
function withCamera(ok = true) {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: ok
                ? vi.fn(async () => stream)
                : vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }),
        },
    });
    /* play() is not implemented in jsdom and rejects loudly otherwise. */
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
        configurable: true, value: vi.fn(async () => {}),
    });
    return track;
}

const startCamera = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    return screen.findByRole('button', { name: 'Scan' });
};

beforeEach(() => {
    readDigits.mockReset();
    scanSupported.mockReturnValue(true);
});

describe('looking a number up', () => {
    it('sends it in the body and never in the URL', async () => {
        /* A telephone number identifies a patient, and a patient's
           identifier in a query string reaches browser history, proxies,
           referrer headers and every log that keeps a request line. This
           is the assertion that stops somebody making it a GET. */
        const { calls, bodies } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        fireEvent.change(screen.getByLabelText(/Last four digits/), { target: { value: '0147' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));

        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ phone: '0147' });
        expect(calls.every((c) => !c.includes('0147'))).toBe(true);
    });

    it('puts the driver first and the rest underneath', async () => {
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();
        fireEvent.change(screen.getByLabelText(/Last four digits/), { target: { value: '0147' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));

        await screen.findByText('Ana Driver');
        expect(screen.getByText(/Wheatley 1 · stop 4/)).toBeInTheDocument();
        /* The name, because four digits is not unique and the sorter is
           holding a sheet that names them. */
        expect(screen.getByText('Test Patient Alpha')).toBeInTheDocument();
    });

    it('says plainly when nobody is carrying it', async () => {
        /* A package nobody has must not go into a pile, and silence would
           send it into one. */
        mockFetch({ [LOOKUP]: { matches: [match({ driver: null })] } });
        open();
        fireEvent.change(screen.getByLabelText(/Last four digits/), { target: { value: '0147' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));

        await screen.findByText('Not assigned yet');
        expect(screen.getByText(/Leave it out of the piles/)).toBeInTheDocument();
    });

    it('says when nothing matched at all', async () => {
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();
        fireEvent.change(screen.getByLabelText(/Last four digits/), { target: { value: '0000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));

        await screen.findByText(/No delivery with that number/);
    });

    it('shows every match when four digits found more than one', async () => {
        mockFetch({
            [LOOKUP]: {
                matches: [
                    match(),
                    match({ orderId: 52, patient: 'Other Person', driver: { username: 'ben', name: 'Ben Driver', run: 'Wheatley 2', stop: 1 } }),
                ],
            },
        });
        open();
        fireEvent.change(screen.getByLabelText(/Last four digits/), { target: { value: '0147' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));

        await screen.findByText('Ana Driver');
        expect(screen.getByText('Ben Driver')).toBeInTheDocument();
    });

    it('shows the handling, which decides where it is put down', async () => {
        mockFetch({ [LOOKUP]: { matches: [match({ handling: ['Fridge', 'Controlled'] })] } });
        open();
        fireEvent.change(screen.getByLabelText(/Last four digits/), { target: { value: '0147' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));

        const card = (await screen.findByText('Ana Driver')).closest('article')!;
        expect(within(card).getByText('Fridge')).toBeInTheDocument();
    });
});

describe('scanning the sheet', () => {
    it('reads one number and goes straight to the answer', async () => {
        withCamera();
        readDigits.mockResolvedValue('PHONE (IMPORTANT) Mobile: 210-555-0147');
        const { bodies } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        fireEvent.click(await startCamera());
        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ phone: '2105550147' });
    });

    it('asks which one when the sheet offered two', async () => {
        /* Guessing would eventually put a package in the wrong van, which
           costs a redelivery and a call from somebody who did not get
           their medication. Two buttons costs a second. */
        withCamera();
        readDigits.mockResolvedValue('Alt 210-555-0000 Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        fireEvent.click(await startCamera());
        await screen.findByText(/Which number is the patient/);
        expect(screen.getByRole('button', { name: '210-555-0147' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '210-555-0000' })).toBeInTheDocument();
    });

    it('never offers our own number, which is on every sheet', async () => {
        withCamera();
        readDigits.mockResolvedValue('IZY GLOBAL SERVICES 832-715-8986');
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        fireEvent.click(await startCamera());
        await screen.findByText(/No telephone number could be read/);
    });

    it('tells the sorter how to get past a bad read', async () => {
        withCamera();
        readDigits.mockResolvedValue('nothing here at all');
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        fireEvent.click(await startCamera());
        await screen.findByText(/type the last four digits/i);
    });
});

describe('when the camera will not play', () => {
    it('says so and points at the keypad', async () => {
        /* A sorter who cannot get past this page stops using it for good
           and goes back to reading addresses off sheets. */
        withCamera(false);
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
        await screen.findByRole('alert');
        expect(screen.getByRole('alert')).toHaveTextContent(/type the last four digits/i);
        /* And the keypad is on the screen, not behind a tab. */
        expect(screen.getByLabelText(/Last four digits/)).toBeInTheDocument();
    });

    it('says when the browser cannot run the reader at all', async () => {
        scanSupported.mockReturnValue(false);
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();
        expect(screen.getByText(/cannot run the reader/)).toBeInTheDocument();
    });

    it('lets go of the camera when the page goes', async () => {
        /* A track left running holds the hardware, and on Android the next
           app to want it gets nothing. A sorter who then cannot take a
           photograph has a worse problem than the one this solves. */
        const track = withCamera();
        mockFetch({ [LOOKUP]: { matches: [] } });
        const view = open();
        await startCamera();
        view.unmount();
        expect(track.stop).toHaveBeenCalled();
    });
});
