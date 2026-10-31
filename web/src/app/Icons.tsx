/* The driver screens' icons, drawn rather than imported.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE ARE THE SAME SHAPES AS app/src/ui/Icons.tsx, ON PURPOSE.
 *
 * Every University Health driver works in the BROWSER for the first month
 * and then moves to the phone app. Two icon sets would mean a courier
 * learning the box glyph twice, and the second one would be the week they
 * are also learning a new contract.
 *
 * So the path data below is copied from the app's file, not redrawn: same
 * 24-unit grid, same 1.8 stroke, same outlines rather than fills. If a shape
 * changes there it changes here, and the comment in that file explains the
 * reasoning behind each one.
 *
 * EVERY ICON HAS A WORD NEXT TO IT, which is a rule and not a style — see
 * the app's header. These are therefore decorative: `aria-hidden` on all of
 * them, because the label beside them is the accessible name. An icon that
 * needed its own label would mean a control that is missing one.
 *
 * Two shapes here are NOT in the app: a telephone and a package going back.
 * Both are controls the app does not have — the app dials through the
 * platform and returns are still web-only — so they are drawn to match
 * rather than copied.
 * ───────────────────────────────────────────────────────────────────────── */

export interface IconProps {
    size?: number;
    /** Inherits the control's colour by default, so a tone change cannot
     *  leave a glyph invisible against its own button. */
    color?: string;
    /** Thicker when a tab is selected: weight reads faster than colour, and
     *  survives both sunlight and a colourblind eye. */
    strokeWidth?: number;
}

/** The shared frame. `fill: none` because every shape here is an outline. */
function frame(size: number) {
    return {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none' as const,
        'aria-hidden': true as const,
        focusable: 'false' as const,
    };
}

/** Today's run: a route with a destination. */
export function RouteIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M6 20c0-3 2-4 6-4s6-1 6-4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray="0.1 3.4" />
            <circle cx={6} cy={20} r={2.2} stroke={color} strokeWidth={strokeWidth} />
            <path d="M18 3.5c1.9 0 3.5 1.6 3.5 3.6 0 2.6-3.5 5.9-3.5 5.9s-3.5-3.3-3.5-5.9c0-2 1.6-3.6 3.5-3.6z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
            <circle cx={18} cy={7.1} r={1.2} stroke={color} strokeWidth={strokeWidth} />
        </svg>
    );
}

/** Collecting a batch into the van. */
export function BoxIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M3.5 7.8 12 3.5l8.5 4.3v8.4L12 20.5 3.5 16.2z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
            <path d="M3.5 7.8 12 12m0 0 8.5-4.2M12 12v8.5" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
        </svg>
    );
}

/** A stop, opened. */
export function PinIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M12 21s7-5.6 7-10.6A7 7 0 0 0 5 10.4C5 15.4 12 21 12 21z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
            <circle cx={12} cy={10.3} r={2.6} stroke={color} strokeWidth={strokeWidth} />
        </svg>
    );
}

/** Directions, handed to the phone's own maps app. */
export function NavigateIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M21 3 3 10.5l7.6 2.9L13.5 21z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
        </svg>
    );
}

/** You: the account this browser is signed in to. */
export function ProfileIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <circle cx={12} cy={8.2} r={3.8} stroke={color} strokeWidth={strokeWidth} />
            <path d="M4.6 20c0-3.6 3.3-5.6 7.4-5.6s7.4 2 7.4 5.6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
        </svg>
    );
}

/** Sign out: a door with an arrow leaving it. */
export function SignOutIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
            <path d="M17 8.5 20.5 12 17 15.5M20 12H10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** Delivery history: a clock with an arrow turning back on it. */
export function HistoryIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M3.8 12a8.2 8.2 0 1 0 2.5-5.9" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
            <path d="M3.4 4.2v3.6h3.6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 7.6V12l3 1.8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/* ── The two the app has no control for ─────────────────────────────────── */

/** Ring dispatch. The app leaves dialling to the platform, so there is no
 *  phone glyph there to copy; this is drawn on the same grid. */
export function PhoneIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path
                d="M7.2 3.8h2.1l1.3 3.4-1.9 1.4a10.4 10.4 0 0 0 4.7 4.7l1.4-1.9 3.4 1.3v2.1a2.4 2.4 0 0 1-2.6 2.4C10.2 16.7 7.3 13.8 4.8 6.4a2.4 2.4 0 0 1 2.4-2.6z"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** Handing undelivered packages back: a box with the arrow turned around. */
export function ReturnIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M4 9.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
            <path d="M13.5 3.5 10 7l3.5 3.5M10 7h4.5A4.5 4.5 0 0 1 19 11.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** Something at the door did not match the paperwork. */
export function FlagIcon({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
    return (
        <svg {...frame(size)}>
            <path d="M6 20.5V4.2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
            <path d="M6 4.6h11.5l-2.2 4 2.2 4H6z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
        </svg>
    );
}
