# Driver training

`driver-training.mp4` — 11m 34s, 1920x1080, 14 MB. Nine screens in the order
a driver meets them on a real day, with spoken narration.

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

### Two things that will bite whoever redoes this

**Use `-vf fps=15`, not `-r 15`.** The first cut used `-r` and came out 75
seconds longer than its own soundtrack: the concat demuxer's per-image
durations got retimed rather than resampled, so every slide drifted further
behind the voice. The `fps` filter keeps the timestamps the durations set.

**Let the slide be as tall as it wants, then scale it.** Pinning the section
to 1080px silently clips whatever does not fit, and what did not fit was the
step number off the top and the controlled-drugs warning off the bottom --
the two things on the slide a driver most needs. Measure, scale, centre.

## The voice

It is a synthetic voice, and it sounds like one. That was the trade: it is
reproducible, it costs nothing, and it can be regenerated the moment a step
in the app changes, which is the failure this whole thing exists to prevent.
`driver-voiceover-script.md` is the same words if anybody would rather read
them aloud and cut a human track over the same frames.

---

# Portal training

`portal-training.mp4` — 8m 09s, 1920x1080, 7.4 MB. Seventeen slides covering
the pharmacy portal, the site manager portal and the password reset, with the
real screens from `portal-screens/` on them.

Built the same way as the driver video and with the same two traps avoided
(`-vf fps=15`, and measure-then-scale rather than pinning to 1080). Two more
were added to the list by this one:

**Narration goes through a UTF-8 file, not through `-Command`.** Embedding the
words in the PowerShell command line worked until a sentence contained a curly
apostrophe, which the console encoding turned into a parse error. The slide it
died on was the one about spreadsheet columns, so the failure read like a deck
problem rather than an encoding one.

**`python3`, not `python`.** Only one of the two interpreters on this machine
has `imageio_ffmpeg`, and the one on `python` is not it.

## What is in it

Seventeen slides in three parts: what a pharmacy sees and cannot see, what a
site manager sees and cannot see, and how anybody resets their own password.
`portal-voiceover-script.md` is the same words to read aloud if a human track
is wanted over the same frames; `resetting-your-password.md` is the reset part
on its own, as a page to hand out.

## It says what does not work yet

The reset section ends by saying plainly that an account with no email address
cannot reset its password, that it will still be told a code is on its way,
and that the nine University Health counter logins have no address on them
today. That is in the video because somebody will try it in the first week,
and the alternative to saying so is nine phone calls.
