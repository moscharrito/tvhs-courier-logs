/* The round-as-a-picture, which has to be tested without a picture.
 *
 * jsdom has no 2D context, so nothing here can paint and nothing here can
 * look. That is why the module splits planning from painting: planRound
 * turns stops into positioned text and is pure given a ruler, so the
 * wrapping, the ordering, the missing-field sentences and the height can
 * all be checked by reading the plan. The two tests at the bottom install
 * just enough of a canvas to watch roundImage decide.
 *
 * The ruler is a character count rather than a real measurement, which is
 * what makes a wrap assertion a number somebody can work out by hand.
 *
 * EVERY NAME AND STREET BELOW WAS GREPPED AGAINST backups/ FIRST, and the
 * first draft of this file had to be changed because of it. This
 * repository is public, and a name invented at a keyboard has a habit of
 * belonging to somebody: on 22 November one did, four times over, in a
 * production backup. A fixture name goes in only after it comes back with
 * no matches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_PIXELS,
    planRound,
    roundImage,
    roundImageName,
    wrapText,
    type Measure,
    type RoundStop,
} from './round-image';

/** Ten pixels a character, whatever the font. The text column is 820 wide,
 *  so a line holds 82 characters and a wrap is countable. */
const ruler: Measure = (text) => text.length * 10;

const COLUMN = 820;

const stop = (over: Partial<RoundStop> = {}): RoundStop => ({
    sequence: 1,
    externalRef: 'RX-100',
    recipientName: 'Nerissa Quillane',
    address: '1200 Thornbeck Row',
    city: 'San Antonio',
    zip: '78207',
    recipientPhone: '(210) 555-0143',
    handlingFlags: [],
    ...over,
});

const head = { driver: 'Ana Driver', site: 'Robert B. Green', serviceDate: '2026-11-23' };

/** Every string in the plan, in the order it would be painted. */
const texts = (stops: RoundStop[], over: Record<string, unknown> = {}) =>
    planRound({ ...head, ...over }, stops, ruler).lines.map((l) => l.text);

describe('wrapping a line', () => {
    it('fills a line before starting the next one', () => {
        /* Eight characters a word: two of them and the space between come
           to 170, and a third would make 260. The line takes everything
           that fits before it breaks, rather than breaking early and
           leaving a column of ragged half-lines down a long address. */
        const words = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'].join(' ');
        expect(wrapText(words, 'f', 200, ruler)).toEqual(['aaaaaaaa bbbbbbbb', 'cccccccc dddddddd']);
    });

    it('leaves a word wider than the column alone rather than cutting it', () => {
        /* A street name split across two lines is worse than one that
           overruns: the driver is matching it against a sign. */
        expect(wrapText('Mmmmmmmmmmmmmmmmmmmm', 'f', 50, ruler)).toEqual(['Mmmmmmmmmmmmmmmmmmmm']);
    });

    it('gives nothing back for nothing', () => {
        expect(wrapText('   ', 'f', 500, ruler)).toEqual([]);
    });
});

describe('the heading', () => {
    it('names the driver, the counter and the day', () => {
        const out = texts([stop()]);
        expect(out[0]).toBe('Ana Driver');
        expect(out[1]).toBe('Robert B. Green  ·  2026-11-23');
    });

    it('says the rows are in driving order only when they are', () => {
        /* A driver reads this top to bottom. Printing "driving order" over
           a round the clusterer fell back to deadline order on would be a
           lie they would act on -- and the fallback is per round, because
           one address without a map point sends its whole round back. */
        expect(texts([stop()], { ordering: 'nearest' })[2]).toBe('1 stop  ·  driving order');
        expect(texts([stop()], { ordering: 'due' })[2]).toBe('1 stop  ·  by deadline');
        expect(texts([stop()])[2]).toBe('1 stop  ·  by deadline');
    });

    it('counts the stops it was given', () => {
        const three = [stop({ sequence: 1 }), stop({ sequence: 2 }), stop({ sequence: 3 })];
        expect(texts(three)[2]).toBe('3 stops  ·  by deadline');
    });
});

describe('a stop', () => {
    it('keeps the sequence the run gave it rather than counting rows', () => {
        /* The numbers on the picture have to be the numbers on the run:
           a driver reading "4" here and "4" in the app is the whole point
           of printing them. A re-numbered list would look right and be
           wrong the first time a STAT came off a round. */
        const out = texts([stop({ sequence: 4 }), stop({ sequence: 7 })]);
        expect(out).toContain('4');
        expect(out).toContain('7');
        expect(out.indexOf('4')).toBeLessThan(out.indexOf('7'));
    });

    it('draws them in the order they arrive and does not sort them', () => {
        const out = texts([
            stop({ sequence: 1, recipientName: 'First Stop' }),
            stop({ sequence: 2, recipientName: 'Aaa Second' }),
        ]);
        expect(out.indexOf('First Stop')).toBeLessThan(out.indexOf('Aaa Second'));
    });

    it('puts the address and the town on one line', () => {
        expect(texts([stop()])).toContain('1200 Thornbeck Row, San Antonio 78207');
    });

    it('leaves out the part the pharmacy did not send instead of its punctuation', () => {
        expect(texts([stop({ city: '', zip: '' })])).toContain('1200 Thornbeck Row');
        expect(texts([stop({ address: '' })])).toContain('San Antonio 78207');
    });

    it('says so when there is no telephone number', () => {
        /* Not a blank. A number the list never carried and a number we
           lost are different facts, and a courier who is asked to confirm
           one at the door has to be able to tell them apart. */
        expect(texts([stop({ recipientPhone: '' })])).toContain('No telephone number');
    });

    it('says so when there is no name and no address', () => {
        const out = texts([stop({ recipientName: '', address: '', city: '', zip: '' })]);
        expect(out).toContain('No name on the list');
        expect(out).toContain('No address on the list');
    });

    it('prints what the door needs beside the telephone number', () => {
        expect(texts([stop({ handlingFlags: ['Cold chain', 'ID required'] })]))
            .toContain('(210) 555-0143 · Cold chain · ID required');
    });

    it('hangs the prescription reference on the right margin', () => {
        const plan = planRound(head, [stop({ externalRef: 'RX-9988' })], ruler);
        const ref = plan.lines.find((l) => l.text === 'RX-9988');
        expect(ref?.align).toBe('right');
        expect(ref?.x).toBe(plan.width - 44);
    });

    it('wraps a long name out of the reference rather than under it', () => {
        /* The reference is 7 characters, so it takes 70 pixels plus a 24
           pixel gutter off the 820 column and leaves 726 -- 72 characters.
           A 76-character name fits on the line when nothing is sitting in
           the margin and has to break when something is, which is the only
           claim being made here: the name gives way to the reference, not
           the other way round, and never runs underneath it. */
        const name = 'Wilhelmina Konstantinopoulos Featherstonehaugh de la Vossberg Quillane Jr';
        expect(name.length).toBe(73);

        const roomy = texts([stop({ recipientName: name, externalRef: '' })]);
        expect(roomy).toContain(name);

        const crowded = texts([stop({ recipientName: name, externalRef: 'RX-9988' })]);
        expect(crowded).not.toContain(name);
        expect(crowded).toContain('RX-9988');
        expect(crowded.length).toBeGreaterThan(roomy.length);
    });

    it('wraps an address that will not fit and grows the picture to hold it', () => {
        const long = `${'Rancho '.repeat(14)}Road`;
        expect(long.length).toBeGreaterThan(COLUMN / 10);

        const short = planRound(head, [stop()], ruler);
        const tall = planRound(head, [stop({ address: long })], ruler);
        expect(tall.height).toBeGreaterThan(short.height);
        expect(tall.lines.filter((l) => l.text.startsWith('Rancho')).length).toBeGreaterThan(1);
    });
});

describe('the picture as a whole', () => {
    it('carries the warning that a picture travels further than a file', () => {
        /* On the image, not on the screen it was downloaded from. The
           screen does not go into the group chat; this does. */
        expect(texts([stop()]))
            .toContain('Patient information. Do not post, forward or store outside the app.');
    });

    it('still draws something for a round with no stops', () => {
        /* An empty round is rare and the button still has to produce a
           file, or the morning it happens the download looks broken. */
        const out = texts([]);
        expect(out).toContain('No stops on this round.');
        expect(out).toContain('0 stops  ·  by deadline');
        expect(out)
            .toContain('Patient information. Do not post, forward or store outside the app.');
    });

    it('gets taller with every stop and keeps its width', () => {
        const one = planRound(head, [stop()], ruler);
        const five = planRound(head, [1, 2, 3, 4, 5].map((sequence) => stop({ sequence })), ruler);
        expect(five.height).toBeGreaterThan(one.height);
        expect(five.width).toBe(one.width);
    });

    it('rules a line between the stops and above the footer', () => {
        /* One between each pair, plus the footer's own: three stops is
           two separators and one rule under the last of them. */
        expect(planRound(head, [stop(), stop(), stop()], ruler).rules).toHaveLength(3);
        expect(planRound(head, [stop()], ruler).rules).toHaveLength(1);
    });
});

describe('naming the file', () => {
    it('is named after the driver and the day', () => {
        expect(roundImageName('Ana Driver', '2026-11-23')).toBe('Ana Driver 2026-11-23 round.png');
    });

    it('takes out the characters a file system refuses', () => {
        expect(roundImageName('Ana / Driver: "the quick one"', '2026-11-23'))
            .toBe('Ana  Driver the quick one 2026-11-23 round.png');
    });

    it('still produces a filename for a driver with no usable name', () => {
        expect(roundImageName('///', '2026-11-23')).toBe('round 2026-11-23 round.png');
    });
});

/* ───────────────────────────── roundImage, with a canvas that is not one
 *
 * jsdom's canvas hands back no context at all, which is the reason the
 * real failures here are thrown with sentences rather than left to
 * surface as "cannot read property of null". */

interface Fake {
    sized: Array<{ w: number; h: number }>;
    blob: Blob | null;
    noToBlob?: boolean;
    noContext?: boolean;
}

function installCanvas(fake: Fake) {
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const hadContext = proto['getContext'];
    const hadBlob = proto['toBlob'];

    proto['getContext'] = function getContext(this: HTMLCanvasElement) {
        if (fake.noContext) return null;
        if (this.width > 0 && this.height > 0) fake.sized.push({ w: this.width, h: this.height });
        return {
            font: '',
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            textAlign: 'left',
            textBaseline: 'alphabetic',
            save: () => {},
            restore: () => {},
            scale: () => {},
            fillRect: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => {},
            fillText: () => {},
            measureText: (text: string) => ({ width: text.length * 10 }),
        };
    };
    if (fake.noToBlob) delete proto['toBlob'];
    else proto['toBlob'] = (cb: (b: Blob | null) => void) => { cb(fake.blob); };

    return () => {
        if (hadContext) proto['getContext'] = hadContext; else delete proto['getContext'];
        if (hadBlob) proto['toBlob'] = hadBlob; else delete proto['toBlob'];
    };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('encoding the picture', () => {
    it('draws at twice the size so the text survives a phone screen', async () => {
        const fake: Fake = { sized: [], blob: new Blob([new Uint8Array(10)], { type: 'image/png' }) };
        const undo = installCanvas(fake);
        try {
            await roundImage(head, [stop()]);
            const painted = fake.sized.at(-1)!;
            expect(painted.w).toBe(1920);
            expect(painted.h % 2).toBe(0);
        } finally { undo(); }
    });

    it('drops to life size rather than hand back a blank picture', async () => {
        /* Past a few dozen megapixels a canvas comes back empty on some
           handsets instead of failing, so a very long round is drawn at 1x.
           A readable picture of sixty stops beats an unreadable one. */
        const many = Array.from({ length: 80 }, (_, i) => stop({ sequence: i + 1 }));
        const plan = planRound(head, many, ruler);
        expect(plan.width * plan.height * 4).toBeGreaterThan(MAX_PIXELS);

        const fake: Fake = { sized: [], blob: new Blob([new Uint8Array(10)], { type: 'image/png' }) };
        const undo = installCanvas(fake);
        try {
            await roundImage(head, many);
            expect(fake.sized.at(-1)!.w).toBe(960);
        } finally { undo(); }
    });

    it('says what went wrong when the canvas will not encode', async () => {
        const fake: Fake = { sized: [], blob: null };
        const undo = installCanvas(fake);
        try {
            await expect(roundImage(head, [stop()])).rejects.toThrow(/could not be encoded/);
        } finally { undo(); }
    });

    it('says what went wrong when the browser has no canvas to give', async () => {
        const fake: Fake = { sized: [], blob: null, noContext: true };
        const undo = installCanvas(fake);
        try {
            await expect(roundImage(head, [stop()])).rejects.toThrow(/canvas to draw on/);
        } finally { undo(); }
    });
});
