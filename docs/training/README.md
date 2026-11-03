# Driver training

`driver-training-nov-2026.mp4` — 12m 56s, 1920x1080, 15 MB, sixteen slides.
The current one. What a driver sees from signing in to going off shift, in the
order they meet it, with spoken narration and real screens from the app.

**It is not in this repository.** Six of its slides carry recipient names and
street addresses, captured from a live driver account, so it falls under the
same rule as `portal-training.mp4` — see the block in `.gitignore`. It is
handed to drivers directly.

`driver-training.mp4` — 11m 34s, 14 MB, nine screens. The October cut, kept
for reference and now out of date: it still shows Collect from Pharmacy and
the custody step, both of which have since been removed from the app.

## What the November cut covers that the October one did not

The app changed underneath the old video, which is the whole reason this one
exists. Specifically:

- **Collect from Pharmacy is gone.** There is no collection step, no screen
  and no button. Custody is recorded for you when you first act on a stop.
- **Take Picture is gone.** One control chooses or takes a photo, which is
  what every phone does anyway.
- **Could not deliver has a slide of its own**, slide 11, with the screen
  behind the button: one reason per item, the six reasons, the note that
  "Something else" asks for, and why *Record the attempt* stays greyed out
  until every item is answered. The October cut named the button and never
  showed what it opens, which left the one outcome a driver is most hesitant
  to pick as the only one they had not been shown.
- **Assignment is manual.** Nothing is auto-assigned; stops appear when
  dispatch gives them to you.
- **The shift toggle moved** and the redundant cards are gone, so the Today
  screen in the video is the Today screen on the phone.

## How it was made, so it can be remade

Nothing here was hand-assembled; four commands rebuild the whole thing from
the deck, which is the point. The deck is the source and the video is output.

1. **Slides** come from the Artifact deck "TAG Courier — Driver Training".
   Each slide's `<aside>` is its narration -- the words are stored beside the
   picture they belong to, so the two cannot drift apart.
2. **Narration** is Windows' own speech synthesis (`System.Speech`, Microsoft
   Zira, rate -1). No service, no key, no upload: the script never leaves the
   machine, which matters because it describes handling patient medication.
3. **Frames** are rendered by headless Edge at exactly 1920x1080. The browser
   pane caps screenshots at its own width, so it cannot be used for this.
4. **Assembly** is ffmpeg, the copy that ships inside the installed
   `imageio-ffmpeg` Python package.

### Four things that will bite whoever redoes this

**Use `-vf fps=15`, not `-r 15`.** The first cut used `-r` and came out 75
seconds longer than its own soundtrack: the concat demuxer's per-image
durations got retimed rather than resampled, so every slide drifted further
behind the voice. The `fps` filter keeps the timestamps the durations set.

**Let the slide be as tall as it wants, then scale it.** Pinning the section
to 1080px silently clips whatever does not fit, and what did not fit was the
step number off the top and the controlled-drugs warning off the bottom --
the two things on the slide a driver most needs. Measure, scale, centre.

**The beat between slides goes into both tracks or neither.** This cut holds
each slide for its narration plus six tenths of a second, so one slide does
not begin on the last syllable of the one before. Adding that to the image
durations alone is `-r 15` by another name: the picture ran steadily ahead of
the voice and slide sixteen arrived nine seconds after it had started being
read. Each slide's audio is padded with the same silence.

**The duplicated last image needs `-shortest`.** The concat demuxer ignores
the final entry's duration, so the last frame is named twice — and that
duplicate is then held for the whole of the previous duration. Without
`-shortest` the video ended with forty-one seconds of a frozen summary slide.

## The voice

It is a synthetic voice, and it sounds like one. That was the trade: it is
reproducible, it costs nothing, and it can be regenerated the moment a step
in the app changes, which is the failure this whole thing exists to prevent.
`driver-voiceover-script-nov-2026.md` is the same words if anybody would
rather read them aloud and cut a human track over the same frames;
`driver-voiceover-script.md` is the October one beside it.

---

# Client portal training

`portal-training.mp4` — 7m 21s, 1920x1080, 8.3 MB. Fifteen slides for
UNIVERSITY HEALTH: what their contract manager sees, what a pharmacy counter
sees, what each does daily, weekly and monthly, and how to get back in when
somebody is locked out.

## Whose portals this is about

The client has two: the contract manager, and the eight counters. **The
dispatch board, the roster and the drivers record are Izy Global's tools and
are not in this deck.** The first cut put the board at the centre and it was
wrong — it taught a client screens they will never open. It now appears once,
in a slide called "What happens on our side", so that a pharmacy understands
what becomes of a list after they press send.

## Built the same way as the driver video

Four traps are on the list now, two inherited and two added by this one.

**`-vf fps=15`, never `-r 15`.** The concat demuxer retimes per-image
durations with `-r` and the picture drifts behind the voice.

**Measure, scale, centre.** Pinning a slide to 1080px clips whatever does not
fit, silently.

**Narration goes through a UTF-8 file, not through `-Command`.** Embedding the
words in the PowerShell command line worked until a sentence contained a curly
apostrophe, which the console encoding turned into a parse error — on the
slide about spreadsheet columns, so it read like a deck problem.

**Resample the audio to 44100 stereo.** The speech synthesiser produced
22050 Hz mono this time, which several players decline to play at all. The
symptom is "the video has no audio", the levels measure fine, and nothing in
the pipeline looks wrong. The driver video happened to come out at 44100.
It is forced now rather than inherited from whatever the voice wrote.

And: **`python3`, not `python`.** Only one of the two interpreters on this
machine has `imageio_ffmpeg`.

## What else is here

`portal-voiceover-script.md` is the same words to read aloud if a human track
is wanted over the same frames. `resetting-your-password.md` is the
getting-back-in part on its own, as a page to hand to a counter.

## It says what does not work yet

The deck says plainly that the eight counter logins have no email address on
them, that a counter trying the email reset will be told a code is on its way
and nothing will be sent, and that until that is fixed the contract manager
sets counter passwords directly — which is faster anyway. Somebody will try it
in the first week; the alternative to saying so is eight phone calls.
