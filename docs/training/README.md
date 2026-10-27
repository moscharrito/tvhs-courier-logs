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
