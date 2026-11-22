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

/** Read this off the sheet, then wait for the answer to land. */
async function scanned(text: string) {
    readDigits.mockResolvedValue(text);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Scan' }));
}

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

beforeEach(() => {
    readDigits.mockReset();
    scanSupported.mockReturnValue(true);
    /* THE PAGE STARTS ITS OWN CAMERA. There is no Start button in the
       ordinary case and no Stop button at all: this page is the camera,
       and a control whose only effect is to make the one thing on the
       screen stop working gets pressed by accident and nothing else. */
    withCamera();
});

describe('looking a number up', () => {
    it('sends it in the body and never in the URL', async () => {
        /* A telephone number identifies a patient, and a patient's
           identifier in a query string reaches browser history, proxies,
           referrer headers and every log that keeps a request line. This
           is the assertion that stops somebody making it a GET. */
        const { calls, bodies } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        await scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ phone: '2105550147' });
        expect(calls.every((c) => !c.includes('2105550147'))).toBe(true);
    });

    it('puts the driver first and the rest underneath', async () => {
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        await scanned('Mobile: 210-555-0147');

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
        await scanned('Mobile: 210-555-0147');

        await screen.findByText('Not assigned yet');
        expect(screen.getByText(/Leave it out of the piles/)).toBeInTheDocument();
    });

    it('says when nothing matched at all', async () => {
        mockFetch({ [LOOKUP]: { matches: [] } });
        await scanned('Mobile: 210-555-0199');

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
        await scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(screen.getByText('Ben Driver')).toBeInTheDocument();
    });

    it('shows the handling, which decides where it is put down', async () => {
        mockFetch({ [LOOKUP]: { matches: [match({ handling: ['Fridge', 'Controlled'] })] } });
        await scanned('Mobile: 210-555-0147');

        const card = (await screen.findByText('Ana Driver')).closest('article')!;
        expect(within(card).getByText('Fridge')).toBeInTheDocument();
    });
});

describe('scanning the sheet', () => {
    it('reads one number and goes straight to the answer', async () => {
        readDigits.mockResolvedValue('PHONE (IMPORTANT) Mobile: 210-555-0147');
        const { bodies } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        fireEvent.click(await screen.findByRole('button', { name: 'Scan' }));
        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ phone: '2105550147' });
    });

    it('asks which one when the sheet offered two', async () => {
        /* Guessing would eventually put a package in the wrong van, which
           costs a redelivery and a call from somebody who did not get
           their medication. Two buttons costs a second. */
        readDigits.mockResolvedValue('Alt 210-555-0000 Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        fireEvent.click(await screen.findByRole('button', { name: 'Scan' }));
        await screen.findByText(/Which number is the patient/);
        expect(screen.getByRole('button', { name: '210-555-0147' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '210-555-0000' })).toBeInTheDocument();
    });

    it('never offers our own number, which is on every sheet', async () => {
        readDigits.mockResolvedValue('IZY GLOBAL SERVICES 832-715-8986');
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        fireEvent.click(await screen.findByRole('button', { name: 'Scan' }));
        await screen.findByText(/No telephone number could be read/);
    });

    it('tells the sorter what to do about a bad read', async () => {
        /* WHAT TO CHANGE, not that it failed. "Could not read" on its own
           gets the same shot taken again. With no keypad left as a way
           round, the advice IS the recovery. */
        readDigits.mockResolvedValue('nothing here at all');
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        fireEvent.click(await screen.findByRole('button', { name: 'Scan' }));
        const said = await screen.findByRole('alert');
        expect(said).toHaveTextContent(/Fill the green box with the RECIPIENT panel/);
        expect(said).toHaveTextContent(/hold the sheet flat/);
    });
});

describe('when the camera will not play', () => {
    it('says so, and offers another go rather than a dead page', async () => {
        /* A refused permission or another app holding the camera. The
           page cannot do its job, so it has to say what happened and
           give a way to retry -- this is the ONE case that gets a button
           other than Scan. */
        withCamera(false);
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        await screen.findByRole('alert');
        expect(await screen.findByRole('button', { name: 'Try the camera again' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Scan' })).not.toBeInTheDocument();
    });

    it('says when the browser cannot run the reader at all', async () => {
        scanSupported.mockReturnValue(false);
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();
        expect(screen.getByText(/cannot run the reader/)).toBeInTheDocument();
    });

    it('has no Stop button, and no keypad', async () => {
        /* Both were asked for and both were removed. The keypad was my
           own addition as a way through a bad read; the bench did not
           want a second way to do the job and a text box on a page meant
           to be used one-handed is a text box nobody fills in. */
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();
        await screen.findByRole('button', { name: 'Scan' });
        expect(screen.queryByRole('button', { name: /Stop camera/i })).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/Last four digits/)).not.toBeInTheDocument();
    });

    it('lets go of the camera when the page goes', async () => {
        /* A track left running holds the hardware, and on Android the next
           app to want it gets nothing. A sorter who then cannot take a
           photograph has a worse problem than the one this solves. With
           no Stop button, this teardown is the ONLY thing that releases
           it. */
        const track = withCamera();
        mockFetch({ [LOOKUP]: { matches: [] } });
        const view = open();
        await screen.findByRole('button', { name: 'Scan' });
        view.unmount();
        expect(track.stop).toHaveBeenCalled();
    });
});
