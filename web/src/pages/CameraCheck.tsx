/* What the camera on THIS handset actually does, written down.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A PAGE, AND WHY NOW.
 *
 * A courier reported a black camera on 30 October. Three fixes shipped
 * after it, all three were real bugs, and none of them was the one being
 * reported:
 *
 *   - the upload refused `image/jpg`, which cameras emit and libraries
 *     do not (lib/photos.ts);
 *   - a cached four-hundred outlived the bug that caused it, so the fix
 *     looked deployed and broken (server idempotency);
 *   - the page had no camera of its own, only the operating system's
 *     (app/Camera.tsx).
 *
 * Three in a row is not bad luck, it is a method problem: every one of
 * those was diagnosed by reading code and reasoning about what a phone
 * PROBABLY does, against a symptom -- "black screen" -- that is the same
 * four words whatever the cause. Nobody could see the handset, so nobody
 * could tell a withheld camera from a denied permission from a device with
 * no camera exposed at all.
 *
 * This page replaces the reasoning with a reading. A courier opens it,
 * taps once, and gets a report that says which of those it is. It is dull
 * on purpose: no layout to speak of, large text, and a copy button,
 * because it will be read off a phone in a car park and pasted into a
 * message.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIELD THAT MATTERS MOST IS `muted`.
 *
 * A track can be `live` and `muted` together, and `muted` is not a user
 * setting -- there is no control for it anywhere in any browser. It means
 * THE SOURCE IS SENDING NO FRAMES: another app holds the camera, a privacy
 * switch is off, a managed profile forbids it, or the hardware never woke.
 *
 * getUserMedia resolves. No exception, no error name, nothing in the
 * console. The picture is black and everything reports success. That is
 * the shape of this bug, and it is invisible to every check made before
 * this page existed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT COLLECTS NOTHING AND SENDS NOTHING. Everything here is read in the
 * browser and shown on the screen. No request leaves the page, which is
 * also why it is reachable without signing in: a courier who cannot get a
 * photograph to work is often the same courier who is about to give up on
 * the app entirely, and making them authenticate first to find out why is
 * a way of not finding out.
 */

import { useCallback, useRef, useState } from 'react';

type Line = { label: string; value: string; bad?: boolean };

const yes = (b: boolean) => (b ? 'yes' : 'no');

/** The browser's own name for what went wrong, kept verbatim. */
function errorLine(e: unknown): string {
    if (e === null || typeof e !== 'object') return String(e);
    const name = 'name' in e ? String((e as { name: unknown }).name) : 'Error';
    const message = 'message' in e ? String((e as { message: unknown }).message) : '';
    return message === '' ? name : `${name}: ${message}`;
}

/** Is there anything in the frame? Read off a 16×16 downscale. */
function frameBrightness(video: HTMLVideoElement): number | null {
    try {
        const tiny = document.createElement('canvas');
        tiny.width = 16;
        tiny.height = 16;
        const ctx = tiny.getContext('2d');
        if (ctx === null) return null;
        ctx.drawImage(video, 0, 0, 16, 16);
        const { data } = ctx.getImageData(0, 0, 16, 16);
        let peak = 0;
        for (let i = 0; i < data.length; i += 4) {
            peak = Math.max(peak, data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
        }
        return peak;
    } catch {
        return null;
    }
}

export function CameraCheck() {
    const video = useRef<HTMLVideoElement | null>(null);
    const stream = useRef<MediaStream | null>(null);
    const [lines, setLines] = useState<Line[] | null>(null);
    const [running, setRunning] = useState(false);
    const [copied, setCopied] = useState(false);

    const stop = useCallback(() => {
        for (const t of stream.current?.getTracks() ?? []) t.stop();
        stream.current = null;
    }, []);

    const check = useCallback(async () => {
        setRunning(true);
        setCopied(false);
        stop();
        const out: Line[] = [];
        const add = (label: string, value: string, bad = false) => out.push({ label, value, ...(bad ? { bad } : {}) });

        /* A CSP that forbids what the page plays would black the picture out
           with no error anywhere else. Listen before anything is played. */
        const violations: string[] = [];
        const onViolation = (e: Event) => {
            const v = e as SecurityPolicyViolationEvent;
            violations.push(`${v.violatedDirective} blocked ${v.blockedURI || '(inline)'}`);
        };
        document.addEventListener('securitypolicyviolation', onViolation);

        try {
            add('Page', window.location.origin);
            add('Secure context', yes(window.isSecureContext), !window.isSecureContext);
            const standalone = window.matchMedia('(display-mode: standalone)').matches;
            add('Installed to home screen', yes(standalone));
            add('Browser', navigator.userAgent);

            const media = navigator.mediaDevices;
            add('Camera API present', yes(media !== undefined && typeof media.getUserMedia === 'function'),
                media === undefined || typeof media.getUserMedia !== 'function');

            /* Asked before the prompt, because the answer is the difference
               between "never asked" and "asked and refused". */
            try {
                const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
                if (perms?.query !== undefined) {
                    const status = await perms.query({ name: 'camera' as PermissionName });
                    add('Camera permission', status.state, status.state === 'denied');
                } else {
                    add('Camera permission', 'this browser will not say');
                }
            } catch {
                add('Camera permission', 'this browser will not say');
            }

            if (media === undefined || typeof media.getUserMedia !== 'function') {
                setLines(out);
                return;
            }

            /* Before permission, labels are blank and that is itself a
               reading: a device list with no labels means nothing has been
               granted yet. Count first, count again afterwards. */
            try {
                const before = await media.enumerateDevices();
                const cams = before.filter((d) => d.kind === 'videoinput');
                add('Cameras the browser can see', String(cams.length), cams.length === 0);
            } catch (e) {
                add('Cameras the browser can see', errorLine(e), true);
            }

            let got: MediaStream | null = null;
            try {
                got = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
                add('Camera opened', 'yes');
            } catch (first) {
                add('Rear camera', errorLine(first), true);
                try {
                    got = await media.getUserMedia({ video: true, audio: false });
                    add('Camera opened', 'yes, but only without asking for the rear one');
                } catch (second) {
                    add('Camera opened', errorLine(second), true);
                }
            }

            if (got !== null) {
                stream.current = got;
                const track = got.getVideoTracks()[0];
                if (track === undefined) {
                    add('Video track', 'the camera opened with no video track', true);
                } else {
                    add('Camera in use', track.label === '' ? '(no name given)' : track.label);
                    add('Track state', track.readyState, track.readyState !== 'live');
                    /* THE ONE. See the header. */
                    add('Sending frames', track.muted ? 'NO - the system is holding the camera back' : 'yes', track.muted);
                    const s = track.getSettings();
                    add('Requested size', `${s.width ?? '?'} x ${s.height ?? '?'}`);
                    add('Facing', String(s.facingMode ?? '(not said)'));
                }

                const element = video.current;
                if (element !== null) {
                    element.srcObject = got;
                    try { await element.play(); add('Video playing', 'yes'); }
                    catch (e) { add('Video playing', errorLine(e), true); }

                    /* Sampled over four seconds, because a camera that is
                       waking up reports zero for the first second or so and
                       a single reading would libel a working phone. */
                    const sizes: string[] = [];
                    let peak: number | null = null;
                    for (let i = 0; i < 4; i += 1) {
                        await new Promise((r) => { window.setTimeout(r, 500); });
                        sizes.push(`${element.videoWidth}x${element.videoHeight}`);
                        const b = frameBrightness(element);
                        if (b !== null) peak = Math.max(peak ?? 0, b);
                    }
                    add('Picture size, every half second', sizes.join(', '), element.videoWidth === 0);
                    add('Brightest pixel seen', peak === null ? 'could not read the frame' : `${peak} of 255`,
                        peak !== null && peak <= 8);
                }
            }

            try {
                const after = await navigator.mediaDevices.enumerateDevices();
                const named = after.filter((d) => d.kind === 'videoinput' && d.label !== '').length;
                add('Cameras with a name after asking', String(named), named === 0);
            } catch { /* already reported above */ }

            add('Blocked by the page policy', violations.length === 0 ? 'nothing' : violations.join(' | '), violations.length > 0);
            setLines(out);
        } finally {
            document.removeEventListener('securitypolicyviolation', onViolation);
            setRunning(false);
        }
    }, [stop]);

    const report = (lines ?? []).map((l) => `${l.label}: ${l.value}`).join('\n');

    return (
        <div className="izy-card" style={{ maxWidth: 720 }}>
            <h1>Camera check</h1>
            <p className="izy-muted">
                This finds out what the camera on this phone is doing. It sends nothing anywhere &mdash; everything
                below is read here and shown to you. Tap the button, allow the camera if you are asked, and wait a
                few seconds.
            </p>

            <button type="button" className="izy-card-btn is-primary" onClick={() => { void check(); }} disabled={running}>
                <span className="izy-card-btn-title">{running ? 'Checking the camera…' : 'Check the camera'}</span>
            </button>

            {/* Shown always, so a courier can SEE whether a picture arrives
                as well as read whether one should have. */}
            <video
                ref={video}
                playsInline
                muted
                autoPlay
                style={{ width: '100%', maxHeight: 240, background: '#000', borderRadius: 12, display: 'block', marginBottom: 16 }}
            />

            {lines !== null && (
                <>
                    {/* NOT `.izy-table`, deliberately. That class carries a
                        560px floor on a narrow screen so a dispatcher's data
                        table scrolls sideways rather than crushing its
                        columns, which is right for a dispatcher and wrong
                        here: this is a report whose entire job is to be read
                        on a 375px phone and then photographed. Label above
                        value, nothing off the right edge. */}
                    <dl className="izy-report">
                        {lines.map((l) => (
                            <div key={l.label}>
                                <dt>{l.label}</dt>
                                <dd className={l.bad === true ? 'is-bad' : undefined}>{l.value}</dd>
                            </div>
                        ))}
                    </dl>
                    <button
                        type="button"
                        className="izy-card-btn is-secondary is-compact"
                        onClick={() => {
                            navigator.clipboard?.writeText(report).then(() => setCopied(true), () => setCopied(false));
                        }}
                    >
                        <span className="izy-card-btn-title">{copied ? 'Copied' : 'Copy this report'}</span>
                    </button>
                    <button type="button" className="izy-card-btn is-quiet is-compact" onClick={stop}>
                        <span className="izy-card-btn-title">Let the camera go</span>
                    </button>
                </>
            )}
        </div>
    );
}
