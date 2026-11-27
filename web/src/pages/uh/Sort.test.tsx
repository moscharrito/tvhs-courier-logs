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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Sort } from './Sort';
import { mockFetch } from '../../test/setup';

const readDigits = vi.fn();
/* The second pass over the same strip, with letters allowed, that the
   street tie-breaker runs. Defaults to reading nothing, so every test
   written before it existed behaves as it did. */
const readStreet = vi.fn(async () => '');
const forgetStrip = vi.fn();
const scanSupported = vi.fn(() => true);
vi.mock('../../lib/read-sheet', () => ({
    readDigits: (...a: unknown[]) => readDigits(...a),
    /* No arguments, either of them: readStreet re-reads the strip the
       last readDigits kept, which is the whole point of it. */
    readStreet: () => readStreet(),
    forgetStrip: () => forgetStrip(),
    scanSupported: () => scanSupported(),
    GUIDE: { x: 0.03, y: 0.38, w: 0.94, h: 0.24 },
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

/** What comes back about a package the person asking is not carrying.
 *  No patient on it, no reference, no address -- see modules/uh/sort.ts. */
const elsewhere = (over: Record<string, unknown> = {}) => ({
    orderId: 77,
    serviceDate: '2026-11-21',
    pharmacy: 'UH Pavilion Pharmacy',
    status: 'assigned',
    driver: { name: 'Tamsin Wrenfield', run: 'Wheatley 3', stop: 9 },
    ...over,
});

const open = () => render(<Sort projectCode="uh" />);

/** Longer than the loop's own gap, so "it did not read again" means it. */
const quiet = () => new Promise((r) => { setTimeout(r, 500); });

/**
 * Wait until the loop has looked at the box again.
 *
 * NOT A SLEEP, and that matters now that the loop keeps running behind
 * an answer. The gap while a result is up is deliberately the slow one
 * (HOLD in Sort.tsx), so a fixed wait tuned to it is a test that goes
 * red when somebody tunes the handset's battery life. Waiting for the
 * read itself says what these tests actually mean: the camera looked
 * again, and here is what did or did not follow from it.
 */
const readAgain = async (was: number) => {
    await waitFor(() => { expect(readDigits.mock.calls.length).toBeGreaterThan(was); });
};

/** Put this on the sheet in front of the camera. The page does the rest. */
function scanned(text: string) {
    readDigits.mockResolvedValue(text);
    return open();
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
    /* AND A PICTURE IN IT. jsdom reports videoWidth 0 forever, which is
       what a real camera reports in the moment between being attached
       and painting its first frame -- and the page waits rather than
       reading, correctly, because reading a frame of nothing costs a
       second of worker time per go. Without a size here every test
       below waits for a loop that is right to never start. */
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, value: 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, value: 1080 });
    return track;
}

beforeEach(() => {
    readDigits.mockReset();
    readStreet.mockReset();
    readStreet.mockResolvedValue('');
    forgetStrip.mockReset();
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
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ phone: '2105550147' });
        expect(calls.every((c) => !c.includes('2105550147'))).toBe(true);
    });

    it('puts the driver first and the rest underneath', async () => {
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        scanned('Mobile: 210-555-0147');

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
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Not assigned yet');
        expect(screen.getByText(/Leave it out of the piles/)).toBeInTheDocument();
    });

    it('says when nothing matched at all', async () => {
        mockFetch({ [LOOKUP]: { matches: [], otherRounds: [] } });
        scanned('Mobile: 210-555-0199');

        /* No date in the sentence, because there is no date in the
           question any more. Nothing we hold with that number leaves a
           bad read or the wrong package, and nothing else. */
        await screen.findByText(/no delivery at all with that number on this account/i);
    });

    /* ── NOTHING TODAY IS TWO DIFFERENT ANSWERS.
     *
     * Reported from the bench on 25 November: a sheet was scanned, both
     * numbers came off it correctly, and the page said no delivery had
     * either of them -- for an order that existed and was assigned, on
     * an earlier day. "Not on today's list" and "never heard of it" read
     * identically, so there was no way to tell a bad read from a package
     * for another day. */
    it('shows a delivery from months ago, with its driver and patient', async () => {
        /* The date window is gone: scan a number, get what we hold.
           Being old is not a reason to be told "no such delivery". */
        mockFetch({
            [LOOKUP]: {
                today: '2026-11-25',
                matches: [match({ serviceDate: '2026-09-02', status: 'delivered' })],
            },
        });
        scanned('Mobile: 210-555-0147');

        const card = (await screen.findByText('Ana Driver')).closest('article')!;
        expect(card).toHaveTextContent('Test Patient Alpha');
        /* Twice on purpose -- once on the marker and once in the facts --
           so toHaveTextContent rather than a getByText that would refuse
           two matches. */
        expect(card).toHaveTextContent('2026-09-02');
    });

    it('marks anything that is not today, so it cannot go in today’s pile', async () => {
        mockFetch({
            [LOOKUP]: { today: '2026-11-25', matches: [match({ serviceDate: '2026-09-02' })] },
        });
        scanned('Mobile: 210-555-0147');

        const card = (await screen.findByText('Ana Driver')).closest('article')!;
        expect(within(card).getByText('not today')).toBeInTheDocument();
    });

    it('leaves today’s own delivery unmarked', async () => {
        /* The mark has to mean something. On the card that IS today's
           work, a warning pill would be noise that teaches the bench to
           ignore the pill on the one that matters. */
        mockFetch({
            [LOOKUP]: { today: '2026-11-25', matches: [match({ serviceDate: '2026-11-25' })] },
        });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(screen.queryByText('not today')).not.toBeInTheDocument();
    });

    it('puts the newest first when two numbers found different days', async () => {
        /* A mobile and a landline are two lookups, and merging them by
           order id would interleave the dates. The package in somebody's
           hand is the most likely to be recent. */
        mockFetch({
            [LOOKUP]: {
                today: '2026-11-25',
                matches: [
                    match({ orderId: 61, serviceDate: '2026-09-02', patient: 'Older Patient' }),
                    match({ orderId: 62, serviceDate: '2026-11-25', patient: 'Newer Patient' }),
                ],
            },
        });
        scanned('Mobile: 210-555-0147, 210-555-0199');

        await screen.findByText('Newer Patient');
        const cards = [...document.querySelectorAll('.izy-sort-card')];
        expect(cards[0]).toHaveTextContent('Newer Patient');
    });

    it('marks nothing when the server did not say what today is', async () => {
        /* A browser holding a cached bundle outlives the server that
           grew the field. Marking everything "not today" on a guess
           would be worse than marking nothing. */
        mockFetch({ [LOOKUP]: { matches: [match({ serviceDate: '2026-09-02' })] } });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(screen.queryByText('not today')).not.toBeInTheDocument();
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
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(screen.getByText('Ben Driver')).toBeInTheDocument();
    });

    it('shows the handling, which decides where it is put down', async () => {
        mockFetch({ [LOOKUP]: { matches: [match({ handling: ['Fridge', 'Controlled'] })] } });
        scanned('Mobile: 210-555-0147');

        const card = (await screen.findByText('Ana Driver')).closest('article')!;
        expect(within(card).getByText('Fridge')).toBeInTheDocument();
    });
});

/* ── A PACKAGE WE HOLD THAT THIS DRIVER IS NOT CARRYING.
 *
 * The bench is drivers, and a driver's own scope is their own round, so
 * for most of the heap in front of them the first list is empty. Until
 * 25 November that produced the sentence that means "bad read", on the
 * page whose one job is to say whose pile a package goes in. The server
 * answers a second time with the driver and nothing that names a
 * patient; these are about the screen not wasting that.
 */
describe('a package on somebody else’s round', () => {
    it('names the driver instead of saying we have never heard of it', async () => {
        mockFetch({ [LOOKUP]: { today: '2026-11-21', matches: [], otherRounds: [elsewhere()] } });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Tamsin Wrenfield');
        expect(screen.queryByText(/no delivery at all/i)).not.toBeInTheDocument();
    });

    it('says on its face that it is not theirs', async () => {
        /* A sorter who takes this for their own work puts the package on
           their own trolley. The pill is cheaper to print than that is
           to unwind. */
        mockFetch({ [LOOKUP]: { today: '2026-11-21', matches: [], otherRounds: [elsewhere()] } });
        scanned('Mobile: 210-555-0147');

        const card = (await screen.findByText('Tamsin Wrenfield')).closest('article')!;
        expect(within(card).getByText('not your round')).toBeInTheDocument();
        expect(card).toHaveTextContent('Wheatley 3');
        expect(card).toHaveTextContent('stop 9');
    });

    it('keeps quiet about it when their own round answered', async () => {
        /* The server does not send one in this case either. Belt and
           braces on the half that renders: two cards for what the bench
           reads as one patient is a wrong pile waiting to happen. */
        mockFetch({
            [LOOKUP]: {
                today: '2026-11-21',
                matches: [match()],
                otherRounds: [elsewhere({ driver: { name: 'Tamsin Wrenfield', run: 'x', stop: 1 } })],
            },
        });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
        expect(screen.queryByText('Tamsin Wrenfield')).not.toBeInTheDocument();
        expect(screen.queryByText('not your round')).not.toBeInTheDocument();
    });

    it('shows one card when both numbers answered with the same package', async () => {
        /* A mobile and a landline are two lookups and usually one
           patient, so the same delivery comes back twice. Two identical
           cards read as two packages. */
        mockFetch({
            [LOOKUP]: { today: '2026-11-21', matches: [], otherRounds: [elsewhere()] },
        });
        scanned('Mobile: 210-555-0147, 210-555-0199');

        await screen.findByText('Tamsin Wrenfield');
        expect(document.querySelectorAll('.izy-sort-card')).toHaveLength(1);
    });

    it('marks one from another day as well, so it cannot go in today’s pile', async () => {
        mockFetch({
            [LOOKUP]: {
                today: '2026-11-25',
                matches: [],
                otherRounds: [elsewhere({ serviceDate: '2026-09-02' })],
            },
        });
        scanned('Mobile: 210-555-0147');

        const card = (await screen.findByText('Tamsin Wrenfield')).closest('article')!;
        expect(within(card).getByText('not today')).toBeInTheDocument();
        expect(card).toHaveTextContent('2026-09-02');
    });

    it('tells the bench when nobody is carrying it yet', async () => {
        /* A driver's own list can never contain an unassigned delivery,
           so before this the loose pool was invisible at the bench. */
        mockFetch({
            [LOOKUP]: { today: '2026-11-21', matches: [], otherRounds: [elsewhere({ driver: null })] },
        });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Not assigned yet');
        expect(screen.getByText(/Leave it out of the piles/)).toBeInTheDocument();
    });

    it('still renders against a server that has never heard of the field', async () => {
        /* A bench phone holding a cached bundle outlives the server that
           grew the field, and the other way round. A page that throws
           here is worse than one missing a line. */
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Ana Driver');
    });

    it('goes away when the next parcel is held up, like everything else on the page', async () => {
        /* THIS IS THE ONE THAT USED TO BE A BUTTON PRESS. A driver
           sorting a heap of other people's packages gets this card most
           of the time, so "somebody else has it" is the state the bench
           spends longest in and the one the hand-over has to work from. */
        mockFetch({
            [LOOKUP]: (_url: string, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body ?? '{}'));
                return body.phone === '2105550147'
                    ? { today: '2026-11-21', matches: [], otherRounds: [elsewhere()] }
                    : { today: '2026-11-21', matches: [match()] };
            },
        });
        scanned('Mobile: 210-555-0147');

        await screen.findByText('Tamsin Wrenfield');
        readDigits.mockResolvedValue('Mobile: 210-555-0199');
        await screen.findByText('Ana Driver');
        expect(screen.queryByText('Tamsin Wrenfield')).not.toBeInTheDocument();
    });
});

/* ────────────────── THE DOORSTEP AS WELL ─────────────────────────
 *
 * University Health's spreadsheet sends one phone column; their label
 * prints the patient's contact block. Where those disagree the number a
 * sorter can read is one we were never sent, and before 25 November
 * that was indistinguishable at the bench from a bad read.
 *
 * The house number and the ZIP are in the green box already, two lines
 * above the number, and both halves are digits so the reader's
 * whitelist did not have to change. What these cover is the page end:
 * that it asks, that it says what it asked, and that it does not draw
 * the same parcel twice when both keys find it.
 */
describe('reading the doorstep off the same panel', () => {
    const PANEL = '8812 Rehearsal Way SAN ANTONIO TX 78213\nMobile: 210-555-0147';

    it('asks about the address as well as the number, off one read', async () => {
        /* BOTH, NOT THE ADDRESS AS A SECOND ATTEMPT. Holding it back
           until the number failed would cost a round trip on exactly
           the sheets this exists for. */
        readDigits.mockResolvedValue(PANEL);
        const { calls } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(2);
    });

    it('sends the house number and the ZIP, not the whole address', async () => {
        readDigits.mockResolvedValue('8812 Rehearsal Way SAN ANTONIO TX 78213');
        const { bodies } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ house: '8812', zip: '78213' });
    });

    it('answers a panel with no telephone number on it at all', async () => {
        /* 90 of the 5,515 deliveries in the November snapshot carry no
           phone. Before this there was no way to look any of them up. */
        readDigits.mockResolvedValue('8812 Rehearsal Way SAN ANTONIO TX 78213');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
    });

    it('says the doorstep it asked about, in words a sorter can check', async () => {
        readDigits.mockResolvedValue(PANEL);
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.getByText(/210-555-0147 · no\. 8812 · 78213/)).toBeInTheDocument();
    });

    it('draws one card when the number and the address found the same parcel', async () => {
        /* Which is the ordinary case, and the reason both keys can be
           fired at once without the screen reading as two packages. */
        readDigits.mockResolvedValue(PANEL);
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.getAllByText('Ana Driver')).toHaveLength(1);
    });

    it('stops at four lookups however much the box is holding', async () => {
        /* Round trips on warehouse wifi with a sorter stood waiting.
           Past four the box has the sheet in it, not the panel, and
           more requests will not rescue the read. */
        readDigits.mockResolvedValue(
            'Mobile: 210-555-0147, 210-555-0199, 210-555-0188, 210-555-0177\n'
            + '1 Rehearsal Way SAN ANTONIO TX 78201\n'
            + '22 Rehearsal Way SAN ANTONIO TX 78202\n'
            + '333 Rehearsal Way SAN ANTONIO TX 78203',
        );
        const { calls } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(calls.filter((c) => c.includes('/sort/lookup')).length).toBeLessThanOrEqual(4);
    });

    it('stops telling them to check the digits once it read the address too', async () => {
        /* "Check the digits against the sheet" is the right advice when
           a number is all we had. When the panel was understood and
           nothing we hold matches any of it, the digits are not the
           thing to go back and look at. */
        readDigits.mockResolvedValue(PANEL);
        mockFetch({ [LOOKUP]: { matches: [], otherRounds: [] } });
        open();

        await screen.findByText(/matching what the camera read/i);
        expect(screen.queryByText(/Check the digits against the sheet/)).not.toBeInTheDocument();
    });

    it('keeps the old sentence when a number was all the panel gave', async () => {
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: [], otherRounds: [] } });
        open();

        await screen.findByText(/no delivery at all with that number on this account/i);
    });

    it('stops saying the old doorstep once a different panel is in the box', async () => {
        /* "Looked up" is what a sorter checks a surprising answer
           against, so it has to belong to the sheet in their hand and
           not to the one before it. */
        readDigits.mockResolvedValue(PANEL);
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText(/no\. 8812/);
        readDigits.mockResolvedValue('3177 Rehearsal Way SAN ANTONIO TX 78215');
        await screen.findByText(/no\. 3177/);
        expect(screen.queryByText(/no\. 8812/)).not.toBeInTheDocument();
    });
});

describe('scanning the sheet', () => {
    it('reads one number and goes straight to the answer, with nothing pressed', async () => {
        readDigits.mockResolvedValue('PHONE (IMPORTANT) Mobile: 210-555-0147');
        const { bodies } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(bodies[LOOKUP]).toEqual({ phone: '2105550147' });
    });

    it('looks both up rather than asking which one, when the sheet offered two', async () => {
        /* IT USED TO ASK, and asking was the wrong shape of safe. A
           sorter handed "which of these is the patient's?" is holding a
           parcel, not the patient's file: the mobile and the landline
           look alike to them, so the tap was a coin toss wearing a
           confirmation's clothes. Both are looked up and every delivery
           that comes back is shown, named, to be read against the sheet
           in their other hand. */
        readDigits.mockResolvedValue('Alt 210-555-0000 Mobile: 210-555-0147');
        const { calls } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.queryByText(/Which number is the patient/)).not.toBeInTheDocument();
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(2);
    });

    it('shows one card when both numbers are the same patient', async () => {
        /* Which is the ordinary case: a mobile and a landline on one
           panel belong to one person, so both lookups return the same
           delivery. Two identical cards would read as two packages. */
        readDigits.mockResolvedValue('Mobile: 210-555-0147, 210-555-0199');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.getAllByText('Ana Driver')).toHaveLength(1);
    });

    it('says which numbers it asked about, not just the one that answered', async () => {
        readDigits.mockResolvedValue('Mobile: 210-555-0147, 210-555-0199');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.getByText(/210-555-0147 · 210-555-0199/)).toBeInTheDocument();
    });

    it('never offers our own number, which is on every sheet', async () => {
        readDigits.mockResolvedValue('IZY GLOBAL SERVICES 832-715-8986');
        const { bodies } = mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        await screen.findByText(/Fill the green box with the RECIPIENT panel/);
        expect(bodies[LOOKUP]).toBeUndefined();
    });

    it('tells the sorter what to do about a bad read, without calling it an error', async () => {
        /* WHAT TO CHANGE, not that it failed. And a status rather than
           an alert: a read that found nothing is the ordinary state
           between two sheets, the page is reading several times a
           second, and an error at that rate teaches people to ignore
           errors. */
        readDigits.mockResolvedValue('nothing here at all');
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        const said = await screen.findByRole('status');
        expect(said).toHaveTextContent(/Fill the green box with the RECIPIENT panel/);
        expect(said).toHaveTextContent(/hold the sheet flat/);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('keeps reading until a number turns up', async () => {
        /* A press was one shot: a frame that happened to be blurred was
           a failure the sorter had to notice and repeat. Holding the
           sheet steady is now the whole of the recovery. */
        readDigits.mockResolvedValue('nothing here at all');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText(/Fill the green box/);
        await waitFor(() => { expect(readDigits.mock.calls.length).toBeGreaterThan(1); });

        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        await screen.findByText('Ana Driver');
    });

    it('keeps reading once there is an answer, so the next parcel needs no press', async () => {
        /* The loop used to stop dead here and start again on Clear.
           Everything below is what now has to be true instead. */
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        await readAgain(readDigits.mock.calls.length);
    });

    it('does not look the same sheet up again, however many times it reads it', async () => {
        /* THE WHOLE OF WHAT REPLACED THE CLEAR BUTTON. The camera stays
           pointed at the parcel for as long as the sorter is reading the
           name off the screen, and every one of those reads finds the
           number that was already answered. One request, and nothing on
           screen moves -- a page that re-asked would draw the same card
           again and look identical, which is why the count of requests
           is the thing asserted and not the card. */
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        const { calls } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        await readAgain(readDigits.mock.calls.length);
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(1);
        expect(screen.getByText('Ana Driver')).toBeInTheDocument();
    });

    it('treats a half-read of the same panel as the same parcel, not a new one', async () => {
        /* A panel gives up a number and a doorstep, and the next read of
           it may give up only one of them because a line went blurred.
           Matching on equality would call that a hand-over, and the
           answer would flicker between two readings of one sheet. One
           key in common is what "still this one" has to mean. */
        readDigits.mockResolvedValue('8812 Rehearsal Way SAN ANTONIO TX 78213\nMobile: 210-555-0147');
        const { calls } = mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        const asked = calls.filter((c) => c.includes('/sort/lookup')).length;
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        await readAgain(readDigits.mock.calls.length);
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(asked);
    });

    it('replaces the answer by itself when a different parcel comes up', async () => {
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        mockFetch({
            [LOOKUP]: (_url: string, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body ?? '{}'));
                return body.phone === '2105550147'
                    ? { matches: [match()] }
                    : {
                        matches: [match({
                            orderId: 60,
                            driver: { username: 'bo', name: 'Bo Courier', run: 'Vida 2', stop: 1 },
                        })],
                    };
            },
        });
        open();

        await screen.findByText('Ana Driver');
        readDigits.mockResolvedValue('Mobile: 210-555-0199');
        await screen.findByText('Bo Courier');
        expect(screen.queryByText('Ana Driver')).not.toBeInTheDocument();
    });

    it('leaves the answer alone when the camera is pointed at nothing', async () => {
        /* The sorter tilts the phone to read the name and the box fills
           with bench. That is not a hand-over, and an answer that
           vanished whenever the sheet left the frame would be unreadable
           by the person it is for. */
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        readDigits.mockResolvedValue('nothing here at all');
        await readAgain(readDigits.mock.calls.length);
        expect(screen.getByText('Ana Driver')).toBeInTheDocument();
        /* And it does not start coaching somebody who has what they came
           for and is looking straight at it. */
        expect(screen.queryByText(/Fill the green box/)).not.toBeInTheDocument();
    });

    it('has nothing on it to press', async () => {
        /* No Scan, no Start, no Stop, and from 26 November no Clear. The
           one button this page can still grow is the camera-failed retry
           and that lives behind a refused permission. */
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getByText('Hold the next package in the box.')).toBeInTheDocument();
    });

    it('will not fire a request for every number a bad read invented', async () => {
        /* One route, one number, so each candidate is a round trip on
           warehouse wifi with a sorter stood waiting. A read that found
           five was a bad read and more requests will not save it. */
        readDigits.mockResolvedValue(
            '210-555-0001 210-555-0002, 210-555-0003 / 210-555-0004, 210-555-0005');
        const { calls } = mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        await screen.findByText(/no delivery at all/i);
        expect(calls.filter((c) => c.includes('/sort/lookup')).length).toBeLessThanOrEqual(3);
    });

    it('reports a broken reader once and stops, rather than sixty times a minute', async () => {
        /* A blocked worker or a browser without WebAssembly does not get
           better by being asked again, and a loop around it would bury
           the handset. */
        readDigits.mockRejectedValue(new Error('Failed starting the reader'));
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        await screen.findByRole('alert');
        const tried = readDigits.mock.calls.length;
        await quiet();
        expect(readDigits.mock.calls.length).toBe(tried);
    });
});

describe('when the camera will not play', () => {
    it('says so, and offers another go rather than a dead page', async () => {
        /* A refused permission or another app holding the camera. The
           page cannot do its job, so it has to say what happened and
           give a way to retry -- this is the ONE case on the page that
           has a button at all. */
        withCamera(false);
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();

        await screen.findByRole('alert');
        expect(await screen.findByRole('button', { name: 'Try the camera again' })).toBeInTheDocument();
    });

    it('says when the browser cannot run the reader at all', async () => {
        scanSupported.mockReturnValue(false);
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();
        expect(screen.getByText(/cannot run the reader/)).toBeInTheDocument();
    });

    it('has nothing to press at all while the camera is working', async () => {
        /* A Stop button and a keypad were each asked for and each
           removed. Scan went on 25 November, because a press costs a
           hand the sorter has not got and moves the picture at the
           moment it needs to be still. */
        readDigits.mockResolvedValue('nothing here at all');
        mockFetch({ [LOOKUP]: { matches: [] } });
        open();
        await screen.findByRole('status');
        expect(screen.queryAllByRole('button')).toEqual([]);
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
        readDigits.mockResolvedValue('nothing here at all');
        const view = open();
        await screen.findByRole('status');
        view.unmount();
        expect(track.stop).toHaveBeenCalled();
    });
});

/* ────────────────── BREAKING A DOORSTEP TIE BY STREET NAME ───────────
 *
 * A house number and a ZIP find exactly one delivery 78.8% of the time
 * over the November snapshot. Where they find several, the street is on
 * the same line of the label and read-sheet.ts still has the pixels.
 *
 * WHAT THESE COVER IS THE SPENDING AND THE OWNING UP. Whether a street
 * name should decide a tie at all is street-match.ts's question and is
 * measured there; what matters here is that the second read is paid for
 * only when there is a tie, that the street goes up with the pair it
 * narrows, that a failure anywhere in it is a non-event, and that a
 * sorter is told when a card was put aside for them.
 */
describe('breaking a doorstep tie with the street name', () => {
    const DOOR = '8812 Rehearsal Way SAN ANTONIO TX 78213';
    const TWO = [match({ orderId: 51 }), match({ orderId: 52, patient: 'Test Patient Beta' })];

    /** First ask answers with a tie; the one carrying a street narrows it. */
    const tieThenNarrow = (narrowed = true) => ({
        [LOOKUP]: (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            if (typeof body.street === 'string' && body.street !== '') {
                return narrowed
                    ? { matches: [TWO[0]], narrowedBy: 'street', narrowedFrom: 2 }
                    : { matches: TWO, narrowedBy: null, narrowedFrom: null };
            }
            return { matches: TWO };
        },
    });

    it('does not read the street when the doorstep found one delivery', async () => {
        /* THE WHOLE COST CONTROL. A second pass of the reader is about a
           second on a warehouse handset, and fourteen scans in fifteen
           have nothing to disambiguate. */
        readDigits.mockResolvedValue(DOOR);
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        open();

        await screen.findByText('Ana Driver');
        expect(readStreet).not.toHaveBeenCalled();
    });

    it('does not read the street for a number, however many it found', async () => {
        /* The street narrows a DOORSTEP. Two deliveries on one telephone
           number are two prescriptions for one patient, and the street
           they share cannot tell them apart. */
        readDigits.mockResolvedValue('Mobile: 210-555-0147');
        mockFetch({ [LOOKUP]: { matches: TWO } });
        open();

        /* Both cards, so by name: they share a driver. */
        await screen.findByText('Test Patient Beta');
        expect(readStreet).not.toHaveBeenCalled();
    });

    it('reads the street once the doorstep came back with a tie', async () => {
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue(DOOR);
        mockFetch(tieThenNarrow());
        open();

        await screen.findByText('Ana Driver');
        expect(readStreet).toHaveBeenCalledTimes(1);
    });

    it('sends the street alongside the house number and the ZIP', async () => {
        /* Never on its own: the street is not a key and the route would
           refuse it as half a doorstep. */
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue(DOOR);
        const { bodies } = mockFetch(tieThenNarrow());
        open();

        await screen.findByText('Ana Driver');
        /* THE CITY IS STILL ON IT, and that is right. Some labels print
           the whole address on one line; findStreet cuts the ZIP and the
           state off the end because both have a shape worth recognising,
           and leaves the city because it has none -- there is nothing in
           "SAN ANTONIO" that says it is not more street. What forgives
           it is street-match.ts scoring the stored street against the
           OPENING of this read, since the street comes first. Trimming
           it here by guesswork would be the version that eats a street
           name on the labels that print two words. */
        expect(bodies[LOOKUP]).toEqual({
            house: '8812', zip: '78213', street: 'Rehearsal Way SAN ANTONIO',
        });
    });

    it('shows the card the street chose, and says what it set aside', async () => {
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue(DOOR);
        mockFetch(tieThenNarrow());
        open();

        await screen.findByText('Ana Driver');
        expect(screen.queryByText('Test Patient Beta')).not.toBeInTheDocument();
        await screen.findByText(/One other delivery shares this house number and ZIP/i);
    });

    it('shows the one it set aside, without asking again', async () => {
        /* IT CAME BACK WITH THE FIRST LOOKUP. A sorter who wants to see
           the other card is stood at a bench holding a parcel, and a
           round trip to show them something already downloaded is a
           round trip spent on nothing. */
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue(DOOR);
        const { calls } = mockFetch(tieThenNarrow());
        open();

        const button = await screen.findByRole('button', { name: /Show it too/i });
        const before = calls.filter((c) => c.includes('/sort/lookup')).length;
        fireEvent.click(button);

        await screen.findByText('Test Patient Beta');
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(before);
        expect(screen.queryByText(/shares this house number/i)).not.toBeInTheDocument();
    });

    it('leaves the answer alone when the server declined to narrow', async () => {
        /* 29 of the 130 real ties carry street names too alike to
           separate. The server refuses those, and a refusal must read
           exactly like never having asked. */
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue(DOOR);
        mockFetch(tieThenNarrow(false));
        open();

        await screen.findByText('Test Patient Beta');
        expect(screen.queryByText(/shares this house number/i)).not.toBeInTheDocument();
    });

    it('leaves the answer alone when the street could not be read', async () => {
        /* readStreet returns '' for a reader that will not start or a
           strip that was dropped. Nothing about that should reach the
           bench: they get the cards the doorstep found. */
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue('');
        const { calls } = mockFetch(tieThenNarrow());
        open();

        await screen.findByText('Test Patient Beta');
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(1);
    });

    it('leaves the answer alone when no line carried the house number', async () => {
        /* findStreet finds the address line BY the house number. A
           letters read that lost it cannot say which line is the street,
           and guessing would risk sending the patient's name as one. */
        readDigits.mockResolvedValue(DOOR);
        readStreet.mockResolvedValue('TEST PATIENT ALPHA\nSOME WARD');
        const { calls } = mockFetch(tieThenNarrow());
        open();

        await screen.findByText('Test Patient Beta');
        expect(calls.filter((c) => c.includes('/sort/lookup'))).toHaveLength(1);
    });

    it('lets go of the frame when the page closes', async () => {
        /* The strip is a photograph of a patient's address kept in
           module memory for this tie-breaker, and the question it was
           kept for ends when the page does.

           IT USED TO HANG ON CLEAR, which meant a sorter who simply
           walked away left it sitting there. The camera and the frame go
           together now, which is the stronger of the two promises. */
        readDigits.mockResolvedValue(DOOR);
        mockFetch({ [LOOKUP]: { matches: [match()] } });
        const { unmount } = open();

        await screen.findByText('Ana Driver');
        expect(forgetStrip, 'not while the bench is still working').not.toHaveBeenCalled();
        unmount();
        expect(forgetStrip).toHaveBeenCalled();
    });
});
