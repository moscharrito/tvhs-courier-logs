/* The glass pieces a driver's screens are built from, in the browser.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THESE EXIST, AND WHY THEY HAVE THE SAME NAMES AS app/src/ui/Glass.tsx.
 *
 * Every University Health driver works in the BROWSER for the first month
 * and only then moves to the phone app. That was decided for a good reason
 * — thirty-five people cannot be onboarded onto an unreleased build the
 * week a contract starts — but it left a gap nobody had closed: the app's
 * driver screens were designed as a rideshare shape, context above and a
 * bottom sheet of actions under the thumb, and the browser was still
 * rendering the same screens as an admin console. A courier was going to
 * learn one layout in November and a different one in December.
 *
 * So this is the app's Glass.tsx with HTML instead of React Native: the same
 * five pieces, the same names, the same tones. A change to the shape of a
 * card button is two files rather than two products.
 *
 * WHAT IS DELIBERATELY DIFFERENT, because the browser is not the phone:
 *
 *   A CARD BUTTON CAN BE A LINK. On the phone every action is onPress and
 *   the app has no router. In the browser "Open the stop" IS a URL, and
 *   rendering it as a <button> that calls navigate() would break opening it
 *   in a new tab, break the middle click, and lie to a screen reader about
 *   what it is. So there are three: CardButton, CardLink and CardAnchor,
 *   with one shared face between them.
 *
 *   THE BLUR IS REAL. React Native has no backdrop-filter, so the app fakes
 *   glass with layered fills — see the long note in app/src/theme.ts. A
 *   browser has the real thing, and the sheet is the one surface on a
 *   driver's screen that content scrolls under, so it earns it. The look is
 *   the same; the technique is better here.
 *
 * Sizes, radii and colours live in styles.css as custom properties that
 * mirror TAP, RADIUS, SPACE, TYPE and GLASS from app/src/theme.ts. The
 * numbers are the app's: 64px for anything that records custody, a 16px
 * floor on anything a courier reads in a windscreen's glare.
 * ───────────────────────────────────────────────────────────────────────── */

import { useId, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { IconProps } from './Icons';

/** The app's ButtonTone, unchanged. See the notes beside toneStyles there. */
export type Tone = 'primary' | 'secondary' | 'quiet' | 'calm' | 'danger' | 'calmDanger';

const toneClass = (tone: Tone) => `izy-card-btn is-${tone}`;

/** A translucent pane. The default surface for anything grouped.
 *
 *  Extra props are spread so a caller can name it — MyRun's next stop
 *  carries `aria-label="Next stop"`, which is what its test finds it by and
 *  what a screen reader announces when jumping between regions. */
export function Panel({ children, strong = false, className, ...rest }: {
    children: ReactNode;
    /** Use on a surface that sits above content and must stay readable. */
    strong?: boolean;
    className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
    const classes = ['izy-pane', strong ? 'is-strong' : '', className ?? ''].filter(Boolean).join(' ');
    return <div className={classes} {...rest}>{children}</div>;
}

/**
 * The bottom sheet: everything a courier can DO, under the thumb.
 *
 * The shape the app borrowed from rideshare apps and this now borrows back.
 * On a phone it is pinned to the bottom of the viewport and scrolls inside
 * itself, so the context above it — where am I up to, what is next — cannot
 * be pushed off the top by a long list of stops. On a desktop it is just a
 * pane: there is no thumb to reach with, and a sheet welded to the bottom of
 * a 1400px window is a design borrowed past the point where it means
 * anything.
 */
export function Sheet({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={['izy-sheet', className ?? ''].filter(Boolean).join(' ')}>
            {/* The grabber. Decoration, and it is what makes the shape read
                as a sheet rather than as a footer. Hidden from the tree: it
                is not a control here and must not announce itself as one. */}
            <div className="izy-grabber" aria-hidden="true" />
            {children}
        </div>
    );
}

/**
 * The inside of a card button: the glyph, the action, the sentence under it.
 *
 * Exported because Directions.tsx has to render this face inside its own
 * element — it is a link on one installation and a button on another, and it
 * flips its own label to "Hide map" — and two copies of this markup would be
 * two copies to keep in step.
 */
export function CardFace({ Icon, title, detail, detailId }: {
    Icon?: ComponentType<IconProps>;
    title: ReactNode;
    detail?: ReactNode;
    /** Set by the wrappers below, which point aria-describedby at it. */
    detailId?: string;
}) {
    return (
        <>
            {Icon !== undefined && (
                <span className="izy-card-btn-icon" aria-hidden="true"><Icon size={24} strokeWidth={2} /></span>
            )}
            <span className="izy-card-btn-text">
                <span className="izy-card-btn-title">{title}</span>
                {detail !== undefined && (
                    <span className="izy-card-btn-detail" {...(detailId === undefined ? {} : { id: detailId })}>{detail}</span>
                )}
            </span>
        </>
    );
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE ACCESSIBLE NAME IS THE ACTION. THE DETAIL IS A DESCRIPTION.
 *
 * Left alone, a card's name is everything inside it: "Open the stop Stop 4
 * for Ines Vargas". That is a sentence nobody wants read out twice, and it
 * means no two cards on the screen share a name even when they are the same
 * action — a voice-control user asking for "Open the stop" matches nothing.
 *
 * So the name is pinned to the title and the detail is wired up as a
 * description, which a screen reader reads after the name and after a pause
 * rather than as part of it. Both are still announced; only the shape
 * changes. The visible title is the whole of the accessible name, which is
 * what WCAG 2.5.3 asks for.
 * ───────────────────────────────────────────────────────────────────────── */
function named(title: string, detail: ReactNode | undefined, id: string) {
    return detail === undefined
        ? { 'aria-label': title }
        : { 'aria-label': title, 'aria-describedby': id };
}

interface FaceProps {
    title: string;
    /** The sentence under the title, and the reason these are cards rather
     *  than pills: a courier deciding between "Collect from a pharmacy" and
     *  "Take undelivered back" is helped more by a line of explanation than
     *  by a tidier row of chips. */
    detail?: ReactNode;
    Icon?: ComponentType<IconProps>;
    tone?: Tone;
    /** A routine action rather than the point of the screen. Shorter, and
     *  still 56px tall: compact is about visual weight, never about being
     *  harder to hit with a thumb in a van. */
    compact?: boolean;
}

/** A card that does something here. */
export function CardButton({ title, detail, Icon, tone = 'primary', compact = false, onClick, disabled = false, busy = false }: FaceProps & {
    onClick: () => void;
    disabled?: boolean;
    busy?: boolean;
}) {
    const off = disabled || busy;
    const id = useId();
    return (
        <button
            type="button"
            className={[toneClass(tone), compact ? 'is-compact' : ''].filter(Boolean).join(' ')}
            onClick={onClick}
            disabled={off}
            aria-busy={busy}
            {...named(title, detail, id)}
        >
            <CardFace Icon={Icon} title={busy ? `${title}…` : title} detail={detail} detailId={id} />
        </button>
    );
}

/** A card that goes somewhere in this application. */
export function CardLink({ title, detail, Icon, tone = 'primary', compact = false, to }: FaceProps & { to: string }) {
    const id = useId();
    return (
        <Link
            to={to}
            className={[toneClass(tone), compact ? 'is-compact' : ''].filter(Boolean).join(' ')}
            {...named(title, detail, id)}
        >
            <CardFace Icon={Icon} title={title} detail={detail} detailId={id} />
        </Link>
    );
}

/**
 * A card that leaves the application: `tel:`, or a map in a new tab.
 *
 * Separate from CardLink because react-router's Link would treat `tel:` as a
 * path and push it onto the history stack, which on a phone is a dialler
 * that never opens and a back button that goes nowhere.
 */
export function CardAnchor({ title, detail, Icon, tone = 'quiet', compact = false, href, external = false }: FaceProps & {
    href: string;
    external?: boolean;
}) {
    const id = useId();
    return (
        <a
            href={href}
            className={[toneClass(tone), compact ? 'is-compact' : ''].filter(Boolean).join(' ')}
            {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
            {...named(title, detail, id)}
        >
            <CardFace Icon={Icon} title={title} detail={detail} detailId={id} />
        </a>
    );
}

/** A short label on a translucent chip. Never the only way something is said. */
export function Chip({ label, tone = 'neutral' }: { label: ReactNode; tone?: 'neutral' | 'warn' | 'bad' | 'good' }) {
    return <span className={`izy-chip is-${tone}`}>{label}</span>;
}

/**
 * The top of a driver's screen, drawn one way.
 *
 * The app's ui/Screen.tsx, and the note there is worth repeating: the thing
 * people notice is not one screen with its own heading size, it is the
 * heading MOVING when they change tab, which reads as two apps stitched
 * together. One app, two people carry it, one header.
 *
 * `right` is for a control belonging to this screen rather than to the
 * shell — on the phone that is a refresh; here it is sign out, because a
 * browser has no app to close.
 */
export function ScreenHeader({ title, subtitle, right }: {
    title: string;
    subtitle?: ReactNode;
    right?: ReactNode;
}) {
    return (
        <div className="izy-screen-head">
            <div className="izy-screen-head-row">
                <h1>{title}</h1>
                {right !== undefined && <div className="izy-screen-head-right">{right}</div>}
            </div>
            {subtitle !== undefined && <p className="izy-screen-sub">{subtitle}</p>}
        </div>
    );
}
