/* One driver's round, as a picture.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A PICTURE WHEN THE SPREADSHEET IS ALREADY THERE.
 *
 * The Excel button beside this one is the manifest: fifteen columns, the
 * file a dispatcher opens on a desktop and the file somebody wants when
 * they want it on paper. It is not what a driver can read.
 *
 * A driver is holding a phone. A .xlsx arriving on an Android handset is a
 * prompt to install something; a PNG opens in the gallery, or in the
 * message it arrived in, with no app and no account, and it stays readable
 * when the signal does not. That is the whole of the reason.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS DRAWN HERE, IN THE BROWSER, AND THAT IS DELIBERATE.
 *
 * The server could render it, but not without a native image library --
 * sharp or node-canvas -- and both are compiled, which makes them a Render
 * build that can fail on a dependency nobody in this repository can read.
 * A canvas is already in the bundle for signatures and for shrinking
 * photographs, so this costs nothing to ship and cannot break a deploy.
 *
 * The stops it draws come from the run's own endpoint, which audits the
 * read, so a picture of a round is recorded the same as opening one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS FULL OF PATIENTS, AND A PICTURE TRAVELS FURTHER THAN A FILE.
 *
 * Every line below is protected health information: a name, an address, a
 * telephone number. The spreadsheet carries exactly the same thing, so
 * this is not a new disclosure -- but a PNG is one tap from a camera roll
 * and two from a group chat, which a .xlsx is not. The footer says so on
 * the image itself, because the warning has to travel with the picture
 * rather than live in the screen it was downloaded from.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LAYOUT IS PLANNED BEFORE ANYTHING IS PAINTED.
 *
 * planRound() turns the stops into positioned text and returns the height
 * the canvas has to be; renderRound() paints that plan and makes no
 * decisions. The split is what lets the wrapping, the ordering and the
 * height be tested, because jsdom has no 2D context to paint into and a
 * function that measured and painted in one pass could only be checked by
 * looking at the picture.
 */

/** A stop as /runs/:id sends it. Everything optional: a list handed over
 *  by a pharmacy is not always complete, and a missing telephone number is
 *  a fact to print rather than a reason to refuse to draw. */
export interface RoundStop {
    sequence: number;
    externalRef?: string;
    recipientName?: string;
    address?: string;
    city?: string;
    zip?: string;
    recipientPhone?: string;
    handlingFlags?: string[];
}

export interface RoundHead {
    driver: string;
    site: string;
    serviceDate: string;
    /** 'nearest' is driving order from the counter; anything else is by
     *  deadline. Printed, because a driver reading top to bottom is owed
     *  the truth about whether that order means anything. */
    ordering?: string;
}

/** One run of text, already positioned. A right-aligned run gives `x` as
 *  its right edge, which is how the prescription reference sits against
 *  the margin whatever its length. */
export interface Line {
    text: string;
    x: number;
    y: number;
    font: string;
    color: string;
    align?: 'right';
}

export interface Plan {
    width: number;
    height: number;
    /** Depth of the green band at the top, in CSS pixels. */
    band: number;
    lines: Line[];
    /** Hairlines between stops, as y positions. */
    rules: number[];
}

/** How wide a string is in a font. The canvas supplies the real one; a
 *  test supplies something it can predict. */
export type Measure = (text: string, font: string) => number;

/* ── The sheet. CSS pixels; `scale` multiplies them on the way out. ───── */
const WIDTH = 960;
const PAD = 44;
const BAND = 124;
/** The gutter the stop number sits in, so names line up down the page. */
const SEQ_W = 52;

/* system-ui only, with no second named family. Canvas parses `font` as a
   CSS shorthand and is unforgiving about a family containing a space; the
   shell's own stack names "Segoe UI", which is the kind of thing that
   renders here as nothing at all rather than as an error. */
const TITLE = '700 30px system-ui, sans-serif';
const SUB = '400 17px system-ui, sans-serif';
const SEQ = '700 22px system-ui, sans-serif';
const NAME = '600 21px system-ui, sans-serif';
const BODY = '400 19px system-ui, sans-serif';
const SMALL = '400 16px system-ui, sans-serif';
const FOOT = '500 15px system-ui, sans-serif';

/* The shell's own tokens, copied rather than read: a canvas cannot resolve
   a CSS custom property, and a picture handed to somebody outside the app
   should not change colour because a theme did. */
const PAPER = '#ffffff';
const GREEN = '#14532d';
const ON_BAND = '#ecfdf5';
const ON_BAND_SOFT = '#bbf7d0';
const INK = '#111827';
const SOFT = '#4b5563';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const DANGER = '#b91c1c';

/** Greedy wrap. A word wider than the column is left to overflow rather
 *  than broken: the long ones here are street names, and nobody is helped
 *  by "Guadalu" on one line and "pe" on the next. */
export function wrapText(text: string, font: string, max: number, measure: Measure): string[] {
    const words = text.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) return [];
    const out: string[] = [];
    let line = words[0]!;
    for (const word of words.slice(1)) {
        const joined = `${line} ${word}`;
        if (measure(joined, font) <= max) line = joined;
        else { out.push(line); line = word; }
    }
    out.push(line);
    return out;
}

/** The address as one sentence, skipping the parts the list did not carry
 *  rather than printing the punctuation around them. */
function where(stop: RoundStop): string {
    const street = (stop.address ?? '').trim();
    const town = [(stop.city ?? '').trim(), (stop.zip ?? '').trim()].filter((p) => p !== '').join(' ');
    return [street, town].filter((p) => p !== '').join(', ');
}

/** The line under the address: how to reach them, and what the door needs.
 *  A sentence rather than a blank where there is no number, because a
 *  number the pharmacy never sent and a number we lost are different
 *  facts and only one of them is ours. */
function detail(stop: RoundStop): string {
    const phone = (stop.recipientPhone ?? '').trim();
    const parts = [phone === '' ? 'No telephone number' : phone];
    for (const flag of stop.handlingFlags ?? []) {
        const f = flag.trim();
        if (f !== '') parts.push(f);
    }
    /* Single spaces around the dot, unlike the heading above. This line is
       wrapped, and wrapText splits on runs of whitespace and rejoins with
       one space -- so a wider separator here would survive on a short line
       and quietly close up on a long one. */
    return parts.join(' · ');
}

export function planRound(head: RoundHead, stops: RoundStop[], measure: Measure): Plan {
    const lines: Line[] = [];
    const rules: number[] = [];
    const textX = PAD + SEQ_W;
    const rightX = WIDTH - PAD;
    const column = rightX - textX;

    /* ── the band */
    lines.push({ text: head.driver, x: PAD, y: 54, font: TITLE, color: ON_BAND });
    lines.push({
        text: `${head.site}  ·  ${head.serviceDate}`,
        x: PAD, y: 88, font: SUB, color: ON_BAND_SOFT,
    });
    lines.push({
        text: `${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}  ·  `
            + `${head.ordering === 'nearest' ? 'driving order' : 'by deadline'}`,
        x: rightX, y: 88, font: SUB, color: ON_BAND_SOFT, align: 'right',
    });

    let y = BAND + 44;

    stops.forEach((stop, i) => {
        if (i > 0) rules.push(y - 30);

        /* The number in its gutter, on the same baseline as the name. */
        lines.push({ text: String(stop.sequence), x: PAD, y, font: SEQ, color: GREEN });

        /* The reference hugs the right margin and takes its width out of
           the name's column, so a long name wraps rather than running
           underneath it. */
        const ref = (stop.externalRef ?? '').trim();
        if (ref !== '') lines.push({ text: ref, x: rightX, y, font: SMALL, color: MUTED, align: 'right' });
        const nameWidth = ref === '' ? column : column - measure(ref, SMALL) - 24;

        const name = (stop.recipientName ?? '').trim();
        for (const part of wrapText(name === '' ? 'No name on the list' : name, NAME, nameWidth, measure)) {
            lines.push({ text: part, x: textX, y, font: NAME, color: INK });
            y += 27;
        }

        const address = where(stop);
        for (const part of wrapText(address === '' ? 'No address on the list' : address, BODY, column, measure)) {
            lines.push({ text: part, x: textX, y, font: BODY, color: SOFT });
            y += 25;
        }

        for (const part of wrapText(detail(stop), SMALL, column, measure)) {
            lines.push({ text: part, x: textX, y, font: SMALL, color: MUTED });
            y += 22;
        }

        y += 26;
    });

    /* A round with nothing on it still has to draw something, or the
       button looks broken on the one morning a round comes back empty. */
    if (stops.length === 0) {
        lines.push({ text: 'No stops on this round.', x: textX, y, font: BODY, color: MUTED });
        y += 25;
    }

    /* Back up before the footer rule. The last stop has already paid the
       26 pixels that would have separated it from a stop that is not
       there, and leaving both made the gap above the footer read as a
       missing row. */
    y -= 16;
    rules.push(y);
    y += 34;
    lines.push({
        text: 'Patient information. Do not post, forward or store outside the app.',
        x: PAD, y, font: FOOT, color: DANGER,
    });
    y += 24;
    lines.push({ text: 'TAG  ·  Izy Global Services', x: PAD, y, font: SMALL, color: MUTED });

    return { width: WIDTH, height: Math.round(y + 30), band: BAND, lines, rules };
}

/** Paints a plan. Decides nothing. */
export function renderRound(ctx: CanvasRenderingContext2D, plan: Plan, scale: number): void {
    ctx.save();
    ctx.scale(scale, scale);

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, plan.width, plan.height);
    ctx.fillStyle = GREEN;
    ctx.fillRect(0, 0, plan.width, plan.band);

    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    for (const y of plan.rules) {
        ctx.beginPath();
        /* The half pixel keeps a one-pixel rule one pixel, rather than two
           grey ones either side of the line it was asked for. */
        ctx.moveTo(PAD, y + 0.5);
        ctx.lineTo(plan.width - PAD, y + 0.5);
        ctx.stroke();
    }

    ctx.textBaseline = 'alphabetic';
    for (const line of plan.lines) {
        ctx.font = line.font;
        ctx.fillStyle = line.color;
        ctx.textAlign = line.align === 'right' ? 'right' : 'left';
        ctx.fillText(line.text, line.x, line.y);
    }

    ctx.restore();
}

/** Beyond this a canvas comes back blank on some handsets rather than
 *  failing, so the scale is dropped instead: a readable 1x picture of a
 *  sixty-stop round beats an empty 2x one. */
export const MAX_PIXELS = 24_000_000;

export async function roundImage(head: RoundHead, stops: RoundStop[], scale = 2): Promise<Blob> {
    const ruler = document.createElement('canvas').getContext('2d');
    if (!ruler) throw new Error('This browser would not give the page a canvas to draw on.');
    const measure: Measure = (text, font) => { ruler.font = font; return ruler.measureText(text).width; };

    const plan = planRound(head, stops, measure);
    const at = plan.width * plan.height * scale * scale > MAX_PIXELS ? 1 : scale;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(plan.width * at);
    canvas.height = Math.round(plan.height * at);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser would not give the page a canvas to draw on.');
    renderRound(ctx, plan, at);

    if (typeof canvas.toBlob !== 'function') {
        throw new Error('This browser cannot save a picture from the page.');
    }
    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
    if (!blob) throw new Error('The picture could not be encoded.');
    return blob;
}

/** Hands a blob to the browser as a download and then lets go of it. An
 *  object URL that is never revoked keeps the whole picture in memory for
 *  the life of the tab, and a dispatcher saves one of these per driver
 *  every morning. */
export function saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Not immediately: Safari reads the URL after the click returns. */
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** `Ana Driver 2026-11-23 round.png`, with the characters a file system
 *  refuses taken out. Named after the driver because a dispatcher saves
 *  one of these per driver into the same folder, and three files called
 *  round.png are two called round(2).png. */
export function roundImageName(driver: string, serviceDate: string): string {
    const who = driver.replace(/[\\/:*?"<>|]/g, '').trim() || 'round';
    return `${who} ${serviceDate} round.png`;
}
