/* The app's icons, drawn rather than imported.
 *
 * react-native-svg is already here for the signature pad, so these cost no
 * new dependency and no font file. An icon set would have been a package,
 * a licence and a build step for eight shapes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY ICON IN THIS APP HAS A WORD NEXT TO IT, and that is a rule rather
 * than a style. The audience is a courier who may have used the app twice,
 * in a van, in a hurry, possibly in their second language. A row of tasteful
 * glyphs is a memory test. So `decorative` is the default and `aria-hidden`
 * in effect: the label beside the icon is what a screen reader reads, and
 * what the eye reads too.
 *
 * Strokes, not fills, at 1.8 width: a filled glyph at 24px in direct
 * sunlight becomes a blob, and an outline keeps its shape.
 * ───────────────────────────────────────────────────────────────────────── */

import Svg, { Circle, Path, Rect } from 'react-native-svg';

export interface IconProps {
    size?: number;
    color?: string;
    /** Thicker when a tab is selected: weight reads faster than colour. */
    strokeWidth?: number;
}

const base = (size: number) => ({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
});

/** Today's run: a route with a destination. */
export function RouteIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M6 20c0-3 2-4 6-4s6-1 6-4"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeDasharray="0.1 3.4"
            />
            <Circle cx={6} cy={20} r={2.2} stroke={color} strokeWidth={strokeWidth} />
            <Path
                d="M18 3.5c1.9 0 3.5 1.6 3.5 3.6 0 2.6-3.5 5.9-3.5 5.9s-3.5-3.3-3.5-5.9c0-2 1.6-3.6 3.5-3.6z"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
            />
            <Circle cx={18} cy={7.1} r={1.2} stroke={color} strokeWidth={strokeWidth} />
        </Svg>
    );
}

/** Work going: a board of things that are not yours yet. */
export function BoardIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Rect x={3} y={4} width={7} height={9} rx={2} stroke={color} strokeWidth={strokeWidth} />
            <Rect x={14} y={4} width={7} height={5} rx={2} stroke={color} strokeWidth={strokeWidth} />
            <Rect x={3} y={16} width={7} height={4} rx={2} stroke={color} strokeWidth={strokeWidth} />
            <Rect x={14} y={12} width={7} height={8} rx={2} stroke={color} strokeWidth={strokeWidth} />
        </Svg>
    );
}

/** Asked: a hand raised, waiting on an answer. */
export function AskedIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5V4a1.5 1.5 0 0 1 3 0v5.5m0 0V6.5a1.5 1.5 0 0 1 3 0V13c0 4-2.5 7-6 7s-6-2.6-6-6v-1.5a1.5 1.5 0 0 1 3 0"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Svg>
    );
}

/** Back, and the only icon in the app that is ever alone: a chevron with a
 *  word beside it is still a chevron, and everybody knows this one. */
export function BackIcon({ size = 24, color = '#111827', strokeWidth = 2 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M15 5l-7 7 7 7"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Svg>
    );
}

/** Collecting a batch into the van. */
export function BoxIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M3.5 7.8 12 3.5l8.5 4.3v8.4L12 20.5 3.5 16.2z"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
            />
            <Path d="M3.5 7.8 12 12m0 0 8.5-4.2M12 12v8.5" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
        </Svg>
    );
}

/** A stop, opened. */
export function PinIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M12 21s7-5.6 7-10.6A7 7 0 0 0 5 10.4C5 15.4 12 21 12 21z"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
            />
            <Circle cx={12} cy={10.3} r={2.6} stroke={color} strokeWidth={strokeWidth} />
        </Svg>
    );
}

/** Directions, handed to the phone's own maps app. */
export function NavigateIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M21 3 3 10.5l7.6 2.9L13.5 21z"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
            />
        </Svg>
    );
}

/** You: the account this phone is signed in to. */
export function ProfileIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Circle cx={12} cy={8.2} r={3.8} stroke={color} strokeWidth={strokeWidth} />
            <Path
                d="M4.6 20c0-3.6 3.3-5.6 7.4-5.6s7.4 2 7.4 5.6"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
            />
        </Svg>
    );
}

/** Sign out: a door with an arrow leaving it. */
export function SignOutIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Path
                d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <Path d="M17 8.5 20.5 12 17 15.5M20 12H10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
    );
}

/** On or off shift. */
export function ShiftIcon({ size = 24, color = '#111827', strokeWidth = 1.8 }: IconProps) {
    return (
        <Svg {...base(size)}>
            <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={strokeWidth} />
            <Path d="M12 7v5.2l3.3 2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
    );
}
