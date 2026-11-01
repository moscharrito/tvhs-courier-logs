/* A camera inside the page, because the phone's own camera came up black.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE REPORT THIS EXISTS FOR, AND WHY THE LAST TWO FIXES WERE NOT IT.
 *
 * 30 and 31 October, from a real handset: tapping the photo field, choosing
 * Take Photo, and getting a camera that opens — the shutter sound, the
 * controls, everything — over a black frame. Choosing from the photo library
 * worked throughout.
 *
 * Two real bugs were found on the way here and both are fixed: the upload
 * refused `image/jpg` (lib/photos.ts), and a cached four-hundred outlived
 * the bug that caused it (server idempotency). Neither was this one. This
 * one is EARLIER than any code of ours runs: `<input type="file">` hands the
 * whole business to the operating system, the OS opens its camera app, and
 * if that app comes up black there is no line of ours in the path to fix.
 *
 * So stop asking the OS. `getUserMedia` gives the page the frames directly,
 * draws them into a <video> we own, and a canvas turns one into a JPEG. The
 * difference that matters is not elegance, it is DIAGNOSIS: when this path
 * fails it fails with a name — NotReadableError when another app is holding
 * the camera, NotAllowedError when the permission needs granting again — and
 * a courier in a car park can be told which, instead of staring at a black
 * rectangle.
 *
 * A BLACK FRAME IS CAUGHT RATHER THAN SENT. If the picture comes back with
 * every pixel at zero the camera gave us nothing, and a black photograph
 * filed as proof of delivery is worse than no photograph: it looks like
 * evidence. So the frame is sampled and the courier is asked. Not refused —
 * a doorstep at 6pm in November is genuinely dark, and the courier is the
 * one who can see which it is — but never recorded silently.
 *
 * THE FILE INPUT STAYS. It is beside this, untouched, and it is the path
 * that has worked all along. This is an addition, not a replacement: if the
 * page cannot have a camera either, the library is still there and the round
 * still gets recorded.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cameraAdvice } from '../lib/browser';

/** A courier's photo is proof, not a portrait. 1600px on the long edge
 *  reads a signature and a door number perfectly and weighs a few hundred
 *  kilobytes, which matters on a pharmacy loading dock with one bar. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/** Above this on any channel, in any sampled pixel, something reached the
 *  sensor. Deliberately near the floor: a dark doorstep is not black, and
 *  the question costs the courier a tap they should not have to make. */
const BLACK_CEILING = 8;

/** How long to wait for a first frame before saying so. The stream resolves
 *  the moment the OS grants it, which is before the sensor has woken up. */
const WATCHDOG_MS = 4000;

type Trouble = { text: string; again: boolean };

/** What went wrong, in words a courier can act on at a door.
 *
 *  The names come from the Media Capture spec. NotReadableError is the one
 *  worth reading twice: it means the camera exists and is allowed and is
 *  BUSY, which is exactly what a black viewfinder in another app looks
 *  like from in here. */
function why(e: unknown): Trouble {
    const name = e !== null && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
    switch (name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
        case 'SecurityError':
            /* THE ADVICE HAS TO MATCH THE DEVICE IN THEIR HAND.
               This said "tap the padlock beside the address" to everybody,
               which is Chrome-on-a-desktop language. A courier on an iPhone
               went looking for a padlock, found nothing, and concluded the
               app was broken -- see the report quoted in lib/browser.ts. */
            return { text: cameraAdvice() ?? 'This browser is not letting the page use the camera. Tap the padlock beside the address, allow Camera, then try again.', again: true };
        case 'NotReadableError':
        case 'TrackStartError':
        case 'AbortError':
            return {
                text: 'Another app is holding the camera. Close the camera app, and any other tab using it, then try again.',
                again: true,
            };
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return { text: 'This device is not offering a camera to the browser. Use Choose photo instead.', again: false };
        default:
            return {
                text: `The camera would not start${name === '' ? '' : ` (${name})`}. Use Choose photo instead.`,
                again: name !== '',
            };
    }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** True when nothing in the frame reached the sensor. Read off a 16×16
 *  downscale so this is a kilobyte of pixels rather than ten megabytes. */
function looksBlack(source: HTMLCanvasElement): boolean {
    try {
        const tiny = document.createElement('canvas');
        tiny.width = 16;
        tiny.height = 16;
        const ctx = tiny.getContext('2d');
        if (ctx === null) return false;
        ctx.drawImage(source, 0, 0, 16, 16);
        const { data } = ctx.getImageData(0, 0, 16, 16);
        for (let i = 0; i < data.length; i += 4) {
            if ((data[i] ?? 0) > BLACK_CEILING) return false;
            if ((data[i + 1] ?? 0) > BLACK_CEILING) return false;
            if ((data[i + 2] ?? 0) > BLACK_CEILING) return false;
        }
        return true;
    } catch {
        /* A browser that will not let us read the pixels is not a reason to
           block the photograph. Let it through and say nothing. */
        return false;
    }
}

/**
 * The camera itself: a full-screen sheet over the form, a live frame, and
 * one shutter big enough to hit with a gloved thumb.
 */
function CameraSheet({ name, onPhoto, onClose }: {
    name: string;
    onPhoto: (file: File) => void;
    onClose: () => void;
}) {
    const video = useRef<HTMLVideoElement | null>(null);
    const stream = useRef<MediaStream | null>(null);
    const [trouble, setTrouble] = useState<Trouble | null>(null);
    const [dim, setDim] = useState(false);
    /** The track is live but the system is withholding frames. See below. */
    const [held, setHeld] = useState(false);
    const [dark, setDark] = useState<File | null>(null);
    const [attempt, setAttempt] = useState(0);

    const drop = useCallback(() => {
        /* Release the camera the moment we are done with it. A stream left
           running is the thing that makes the NEXT app's viewfinder black,
           and we are not going to be that app. */
        for (const track of stream.current?.getTracks() ?? []) track.stop();
        stream.current = null;
    }, []);

    useEffect(() => {
        let cancelled = false;
        setTrouble(null);
        setDim(false);
        setHeld(false);

        const start = async () => {
            const media = navigator.mediaDevices;
            if (media === undefined || typeof media.getUserMedia !== 'function') {
                setTrouble({ text: 'This browser will not give the page a camera. Use Choose photo instead.', again: false });
                return;
            }

            let got: MediaStream;
            try {
                got = await media.getUserMedia({
                    /* `ideal`, never `exact`: a device with only a front
                       camera should give us that rather than nothing. */
                    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
                    audio: false,
                });
            } catch (first) {
                try {
                    /* Any camera at all, in case the constraints were the
                       problem rather than the camera. */
                    got = await media.getUserMedia({ video: true, audio: false });
                } catch {
                    if (!cancelled) setTrouble(why(first));
                    return;
                }
            }

            if (cancelled) {
                for (const track of got.getTracks()) track.stop();
                return;
            }

            stream.current = got;

            /* THE STATE THAT LOOKS EXACTLY LIKE SUCCESS AND IS NOT.
             *
             * A track can be `live` and `muted` at the same time, and the
             * two words do not mean what they look like. `muted` here is
             * not a user setting and has no control anywhere in the browser:
             * it means THE SOURCE IS NOT PRODUCING FRAMES. The operating
             * system has the camera and is not handing it over -- another
             * app holds it, a privacy switch is off, a work profile forbids
             * it, or the hardware did not come up.
             *
             * getUserMedia RESOLVES. There is no exception, no error name,
             * nothing in the console. The video element sits at its black
             * background with videoWidth 0 for as long as anyone cares to
             * look at it. This is the black screen, and nothing in the three
             * fixes before this one could have seen it, because by every
             * check they made the camera was working.
             *
             * So: watch the flag, and watch it change. A courier who closes
             * the app that was holding the camera gets `unmute` and the
             * picture appears; saying so is the difference between a fault
             * they can clear and a phone they think is broken. */
            const track = got.getVideoTracks()[0];
            if (track !== undefined) {
                const look = () => {
                    if (cancelled) return;
                    setHeld(track.muted);
                    if (!track.muted) setDim(false);
                };
                track.addEventListener('mute', look);
                track.addEventListener('unmute', look);
                /* Ended without us stopping it: the camera was taken away
                   mid-session, which a phone does when another app asks. */
                track.addEventListener('ended', () => {
                    if (!cancelled) setTrouble({ text: 'The camera was taken away while it was open. Something else on the phone asked for it.', again: true });
                });
                look();
            }

            const element = video.current;
            if (element !== null) {
                element.srcObject = got;
                try {
                    await element.play();
                } catch {
                    /* Autoplay refused. The frame may still appear; the
                       watchdog below will say so if it does not. */
                }
            }
        };

        void start();

        /* The stream resolving is not the same as a picture arriving. If
           nothing has a width after four seconds, say so -- that is the
           black frame, reported honestly rather than left to be stared at. */
        const watch = window.setTimeout(() => {
            if (!cancelled && (video.current?.videoWidth ?? 0) === 0) setDim(true);
        }, WATCHDOG_MS);

        return () => {
            cancelled = true;
            window.clearTimeout(watch);
            drop();
        };
    }, [attempt, drop]);

    const accept = useCallback((file: File) => {
        drop();
        onPhoto(file);
        onClose();
    }, [drop, onPhoto, onClose]);

    const shoot = () => {
        const element = video.current;
        const w = element?.videoWidth ?? 0;
        const h = element?.videoHeight ?? 0;
        if (element === null || w === 0 || h === 0) {
            setDim(true);
            return;
        }

        const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
            setTrouble({ text: 'This browser could not turn the frame into a photo. Use Choose photo instead.', again: false });
            return;
        }
        ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
        const black = looksBlack(canvas);

        canvas.toBlob((blob) => {
            if (blob === null) {
                setTrouble({ text: 'This browser could not turn the frame into a photo. Use Choose photo instead.', again: false });
                return;
            }
            /* A name and a type, because lib/photos.ts is about to ask for
               both and a canvas blob carries neither. */
            const file = new File([blob], `${name}-${stamp()}.jpg`, { type: 'image/jpeg' });
            if (black) setDark(file);
            else accept(file);
        }, 'image/jpeg', JPEG_QUALITY);
    };

    return (
        <div className="izy-cam" role="dialog" aria-modal="true" aria-label="Camera">
            <div className="izy-cam-stage">
                <video ref={video} className="izy-cam-view" playsInline muted autoPlay />
                {trouble !== null && (
                    <div className="izy-cam-say" role="alert">
                        <p>{trouble.text}</p>
                        {trouble.again && (
                            <button type="button" className="izy-card-btn is-secondary is-compact" onClick={() => setAttempt((n) => n + 1)}>
                                <span className="izy-card-btn-title">Try the camera again</span>
                            </button>
                        )}
                    </div>
                )}
                {trouble === null && (held || dim) && dark === null && (
                    <div className="izy-cam-say" role="status">
                        {held ? (
                            <>
                                {/* Said as a fact, not a guess: the track
                                    itself reports that the system is holding
                                    the frames back. */}
                                <p>
                                    The phone is not letting the camera send any picture. That is the system doing
                                    it, not this app &mdash; something else has the camera, or camera access is
                                    switched off for this browser.
                                </p>
                                <p>
                                    Close any app that uses the camera, then tap below. If it stays black, check the
                                    phone&rsquo;s settings for camera access, and use Choose photo meanwhile.
                                </p>
                                <button type="button" className="izy-card-btn is-secondary is-compact" onClick={() => setAttempt((n) => n + 1)}>
                                    <span className="izy-card-btn-title">Try the camera again</span>
                                </button>
                            </>
                        ) : (
                            <p>
                                The camera is open but no picture is coming through. Another app may be holding it.
                                Take the shot anyway if you can see something, or close this and choose a photo instead.
                            </p>
                        )}
                    </div>
                )}
                {dark !== null && (
                    <div className="izy-cam-say" role="alert">
                        <p>
                            That came out completely black, so the camera gave no picture. A black photograph on a
                            delivery record looks like proof and is not. Take it again — or if the doorstep really is
                            that dark, use it.
                        </p>
                        <button type="button" className="izy-card-btn is-secondary is-compact" onClick={() => setDark(null)}>
                            <span className="izy-card-btn-title">Take it again</span>
                        </button>
                        <button type="button" className="izy-card-btn is-quiet is-compact" onClick={() => { accept(dark); }}>
                            <span className="izy-card-btn-title">Use it anyway</span>
                        </button>
                    </div>
                )}
            </div>
            <div className="izy-cam-bar">
                <button
                    type="button"
                    className="izy-cam-shutter"
                    onClick={shoot}
                    disabled={trouble !== null || dark !== null}
                    aria-label="Take the photo"
                >
                    <span aria-hidden="true" />
                </button>
                <button type="button" className="izy-card-btn is-quiet is-compact" onClick={() => { drop(); onClose(); }}>
                    <span className="izy-card-btn-title">Close the camera</span>
                </button>
            </div>
        </div>
    );
}

/**
 * The button that opens it. Sits beside a file input, never instead of one.
 *
 * `name` becomes the start of the file name, so a photograph that reaches
 * the bucket says what it was taken for: `courier-form-2026-10-31T18-04-11`.
 */
export function CameraButton({ name, onPhoto, disabled = false }: {
    name: string;
    onPhoto: (file: File) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                className="izy-card-btn is-secondary is-compact"
                onClick={() => setOpen(true)}
                disabled={disabled}
            >
                <span className="izy-card-btn-title">Take a picture</span>
            </button>
            {/* THROUGH A PORTAL, AND NOT FOR TIDINESS.
                `position: fixed` is measured against the nearest ancestor
                with a backdrop-filter rather than against the viewport, and
                the driver's bottom sheet has one -- it is the surface the
                real glass was built for. Rendered in place, a full-screen
                camera came out as a box inside the sheet with the page
                header above it and the tab bar below. See the screenshot
                this comment was written from: 31 October. */}
            {open && createPortal(
                <CameraSheet name={name} onPhoto={onPhoto} onClose={() => setOpen(false)} />,
                document.body,
            )}
        </>
    );
}
