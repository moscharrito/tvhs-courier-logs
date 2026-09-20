/* The driver app's look.
 *
 * Glass, and larger targets than a design tool would suggest, because of who
 * holds this: somebody standing beside a van, one-handed, in Texas sun, with
 * a cold pack in the other hand. Every number below is chosen for that person
 * rather than for a screenshot.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY GLASS IS DONE WITH LAYERED FILLS AND NOT A BLUR.
 *
 * React Native has no backdrop-filter. Real frosting needs expo-blur, which
 * is a native module: it does not run in Expo Go on every platform, it costs
 * a dependency, and a BlurView over a scrolling list is the classic way to
 * make an Android mid-range phone drop frames. A courier scrolling twelve
 * stops on a three-year-old handset is the actual test.
 *
 * So the glass here is translucent fills over a soft gradient ground, with a
 * light top border and a wide, soft shadow. It reads as depth, costs one
 * View, and renders identically on both platforms. If a real blur is ever
 * wanted, GLASS.fill is the single place it swaps in.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const theme = {
    /* The same green as the web shell, so one product does not look like
       two. Unchanged from ticket 7.1 on purpose: the colour is the brand,
       the glass is the surface. */
    green: '#14532d',
    greenBright: '#16a34a',
    greenSoft: '#dcfce7',
    ink: '#111827',
    muted: '#6b7280',
    line: '#e5e7eb',
    bg: '#f6f8f7',
    card: '#ffffff',
    danger: '#b91c1c',
    dangerSoft: '#fee2e2',
} as const;

/* The ground the glass sits on. Flat white gives nothing to be translucent
   against, so panels would look like plain cards with a weak border. */
export const GROUND = {
    /* More separation between the bands, so there is something for the glass
       to be translucent against. Three near-identical greys gave the panes
       nothing to catch. */
    top: '#e3ede7',
    middle: '#f2f6f3',
    bottom: '#d8e6dd',
} as const;

export const GLASS = {
    /* Denser than the first pass, which read as washed-out white rather than
       as glass. More opacity in the fill plus a harder top edge and a deeper
       shadow is what makes a panel look like a pane sitting above something
       instead of a pale rectangle painted on it. */
    fill: 'rgba(255,255,255,0.58)',
    /* Deeper, for a sheet that has to sit above content and stay readable. */
    fillStrong: 'rgba(255,255,255,0.8)',
    /* A tint for anything carrying the brand. */
    fillGreen: 'rgba(20,83,45,0.92)',
    /* Light catching the top edge is most of what sells glass, and a full
       white edge against a denser fill is what gives it thickness. */
    border: 'rgba(255,255,255,0.95)',
    borderSubtle: 'rgba(17,24,39,0.06)',
    /* Wide and soft, so the panel floats rather than being outlined. */
    shadow: {
        shadowColor: '#0b2318',
        shadowOpacity: 0.16,
        shadowRadius: 30,
        shadowOffset: { width: 0, height: 12 },
        /* Android has no shadow radius control, so elevation approximates. */
        elevation: 6,
    },
    shadowLifted: {
        shadowColor: '#0b2318',
        shadowOpacity: 0.16,
        shadowRadius: 34,
        shadowOffset: { width: 0, height: -6 },
        elevation: 14,
    },
} as const;

/* ─────────────────────────────────────────────────────────────────────────
 * TOUCH SIZES.
 *
 * Apple asks for 44pt and Android for 48dp as a MINIMUM, and those minima
 * assume a person sitting still indoors. The old screens used 15px text and
 * bare Text elements as links, which is the size that was reported as hard
 * to read and hard to hit.
 *
 * These are floors, not targets. Nothing a courier taps while working should
 * be smaller than `tap.primary`.
 * ───────────────────────────────────────────────────────────────────────── */
export const TAP = {
    /* Anything that records custody: collect, deliver, arrive, go on shift. */
    primary: 64,
    /* Ordinary navigation: open a stop, pick a contract. */
    standard: 56,
    /* The floor, for a dense row in a list. Still above both platform minima. */
    minimum: 48,
} as const;

export const RADIUS = {
    card: 22,
    button: 18,
    sheet: 28,
    pill: 999,
} as const;

export const SPACE = {
    xs: 6,
    sm: 10,
    md: 16,
    lg: 22,
    xl: 30,
} as const;

/* Type scale. The old screens leaned on 13 to 15px; a windscreen-glare floor
   of 16 for anything a courier reads, and 17 for anything they act on. */
export const TYPE = {
    display: 32,
    title: 26,
    heading: 20,
    body: 17,
    label: 16,
    meta: 15,
} as const;
