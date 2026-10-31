/* The camera, and what it says when there is no picture in it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THESE TESTS ARE ACTUALLY FOR.
 *
 * jsdom has no camera, no video decoder and no canvas, so none of this can
 * prove a photograph comes out. What it CAN prove is the half that the black
 * screen was really about: that a camera which does not work says which way
 * it did not work, in a sentence a courier can act on, instead of showing a
 * black rectangle and nothing else.
 *
 * NotReadableError is the case worth reading twice. It means the camera
 * exists, is permitted, and is held by something else -- which from behind
 * the glass looks exactly like the black viewfinder reported from a real
 * handset on 30 and 31 October. Before this component there was no way for
 * that sentence to reach anybody, because the camera belonged to the
 * operating system and we never heard why it failed.
 *
 * And the last one in the file is the one that keeps a bad record out of the
 * chain of custody: with no frame to photograph, the shutter must refuse
 * rather than hand up a black JPEG that looks like proof of a delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { CameraButton } from './Camera';

type Track = { stop: ReturnType<typeof vi.fn> };

function fakeStream() {
    const track: Track = { stop: vi.fn() };
    return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

/** Install a mediaDevices jsdom does not have. */
function withCamera(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>) {
    const fn = vi.fn(getUserMedia);
    Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: fn },
        configurable: true,
        writable: true,
    });
    return fn;
}

const named = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => {
    /* jsdom's play() logs "not implemented" and resolves nothing. */
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('opening the camera', () => {
    it('does not touch the camera until the courier asks for it', async () => {
        const getUserMedia = withCamera(async () => fakeStream().stream);
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Take a picture' })).toBeInTheDocument();
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('asks for the rear camera, because a form is in front of the courier', async () => {
        const getUserMedia = withCamera(async () => fakeStream().stream);
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));

        await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
        const asked = getUserMedia.mock.calls[0]?.[0] as { video: { facingMode: unknown } };
        /* `ideal`, not `exact`: a device with only a front camera has to give
           us that rather than nothing at all. */
        expect(asked.video.facingMode).toEqual({ ideal: 'environment' });
    });

    it('settles for any camera when the constraints are the problem', async () => {
        let call = 0;
        const getUserMedia = withCamera(async () => {
            call += 1;
            if (call === 1) throw named('OverconstrainedError');
            return fakeStream().stream;
        });
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));

        await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
        expect(getUserMedia.mock.calls[1]?.[0]).toEqual({ video: true, audio: false });
        /* The fallback worked, so nothing is said. */
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

describe('what the courier is told when there is no picture', () => {
    it('names the app holding the camera, which is what a black frame usually is', async () => {
        withCamera(async () => { throw named('NotReadableError'); });
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));

        const said = await screen.findByRole('alert');
        expect(said).toHaveTextContent(/another app is holding the camera/i);
        /* Closing the other app is something the courier can do standing
           there, so the retry has to be in reach. */
        expect(screen.getByRole('button', { name: /try the camera again/i })).toBeInTheDocument();
    });

    it('points at the permission when the browser is the one refusing', async () => {
        withCamera(async () => { throw named('NotAllowedError'); });
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/padlock/i);
    });

    it('offers no retry when there is no camera to retry, and sends them to the library', async () => {
        withCamera(async () => { throw named('NotFoundError'); });
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));

        const said = await screen.findByRole('alert');
        expect(said).toHaveTextContent(/choose photo/i);
        expect(screen.queryByRole('button', { name: /try the camera again/i })).not.toBeInTheDocument();
    });

    it('says so when this browser has no camera API at all', async () => {
        /* No mediaDevices: an insecure origin, or an old WebView. */
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/will not give the page a camera/i);
    });

    it('speaks up when the stream opens but no frame ever arrives', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            withCamera(async () => fakeStream().stream);
            render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

            fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));
            await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

            /* THE BLACK SCREEN, EXACTLY. getUserMedia resolved, so by every
               check the camera is fine; videoWidth is still zero, so there is
               no picture. Four seconds, then say it out loud. */
            await act(async () => { await vi.advanceTimersByTimeAsync(4100); });

            expect(await screen.findByRole('status')).toHaveTextContent(/no picture is coming through/i);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('letting go of the camera', () => {
    it('stops every track on the way out, so the next app is not the one with a black frame', async () => {
        const { track, stream } = fakeStream();
        withCamera(async () => stream);
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));
        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /close the camera/i }));

        await waitFor(() => expect(track.stop).toHaveBeenCalled());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('hands nothing to the form when the courier closes it', async () => {
        const onPhoto = vi.fn();
        withCamera(async () => fakeStream().stream);
        render(<CameraButton name="courier-form" onPhoto={onPhoto} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));
        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /close the camera/i }));

        expect(onPhoto).not.toHaveBeenCalled();
    });
});

describe('the shutter', () => {
    it('refuses rather than producing a photograph of nothing', async () => {
        /* jsdom reports videoWidth 0 for every video, which is the same thing
           the real black frame reports. A delivery recorded against an empty
           JPEG looks like proof and is not, so the shutter must come back
           empty-handed and say why. */
        const onPhoto = vi.fn();
        withCamera(async () => fakeStream().stream);
        render(<CameraButton name="courier-form" onPhoto={onPhoto} />);

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));
        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Take the photo' }));

        expect(onPhoto).not.toHaveBeenCalled();
        expect(await screen.findByRole('status')).toHaveTextContent(/no picture is coming through/i);
    });
});

describe('the button beside the file input', () => {
    it('goes quiet while the screen is busy recording, like every other control', async () => {
        withCamera(async () => fakeStream().stream);
        render(<CameraButton name="courier-form" onPhoto={vi.fn()} disabled />);

        expect(screen.getByRole('button', { name: 'Take a picture' })).toBeDisabled();
    });
});

describe('where the camera is rendered', () => {
    it('goes to the body, because a fixed box inside the sheet is not full screen', async () => {
        /* THE BUG THIS PINS. `position: fixed` is measured against the
           nearest ancestor carrying a backdrop-filter, not against the
           viewport, and the driver's bottom sheet has one. Rendered in
           place, the camera came out as a box inside the sheet with the page
           header above it and the tab bar below -- a camera a courier cannot
           aim. Only a portal out of that stacking context fixes it, so the
           portal is the thing worth a test. */
        withCamera(async () => fakeStream().stream);
        const { container } = render(
            <div className="izy-sheet"><CameraButton name="courier-form" onPhoto={vi.fn()} /></div>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Take a picture' }));
        await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

        expect(container.querySelector('.izy-cam')).toBeNull();
        expect(document.body.querySelector('.izy-cam')).not.toBeNull();
    });
});
