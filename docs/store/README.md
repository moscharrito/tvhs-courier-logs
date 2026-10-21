# Play Store listing assets

Uploaded in the Play Console, not built into the app, which is why none of
this is in `app/`. The copy that goes in the text boxes is in
`docs/app-store-submission.md`.

## Phone screenshots

All 1080x1920. Play takes 2 at minimum and 8 at most; these five are in the
order they should be uploaded, because read down they are a working day.

| File | What it shows |
|---|---|
| `1-contract-picker.png` | The first screen: UH and TVHS, a courier picks theirs |
| `2-todays-run.png` | The run, next stop first, with its deadline and zone |
| `3-stop-detail.png` | A stop flagged `Controlled` and `ID` |
| `4-pharmacy-collection.png` | Counting packages out of a pharmacy, signed for |
| `5-proof-of-delivery.png` | Both required photographs at the door |

**Every name and address in them is invented.** They were captured against
production with the mock list from `server/scripts/mock-list.mjs`: Test
Patient Bravo at 11 Rehearsal Way. No University Health data, real or
sampled, is in any of these images, and none may ever be: a store listing is
public, permanent and indexed.

Captured on an emulator running the signed **release** build at versionCode
2, with the display forced to 1080x1920 so the aspect ratio is a clean 9:16
rather than the 9:20 of the native Pixel profile.

### If these are recaptured

The due badge on `2-todays-run.png` is amber, because the two-hour clock
started when the list was uploaded and the capture happened after it. It is
honest, and it is also a late delivery in a shop window. Uploading the list
and capturing within the hour gives a green one.

## Feature graphic

`feature-graphic-1024x500.png`, drawn by `make-feature-graphic.ps1` rather
than screenshotted: a feature graphic is a banner and no device produces
one. Colours are the app's own, from `app/src/theme.ts`, so the listing and
the product match.

Everything load-bearing sits middle-left. Play crops this on some surfaces
and lays an install button over others, so nothing important goes near an
edge and no text sits in the lower right.

**The typeface is Segoe UI**, which is the Windows system font and not a
brand font. It is legible and it is not yours. This is the largest piece of
brand surface in the whole listing, so it is worth redoing in a design tool
if there is ever a house face.

## App icon

`app-icon-512.png`, downscaled from `app/assets/icon.png` (1024x1024) with
high-quality bicubic resampling rather than redrawn, so the store icon and
the one on the phone are the same mark.

Saved as 32-bit PNG because that is what Play asks for, and every pixel is
opaque -- including the corners -- so it also satisfies the iOS rule in
`app/assets/README.md` that the square is filled edge to edge with no alpha
channel. 12 KB against a 1 MB limit.

The vector is `app/assets/icon.svg` if it ever needs changing; edit that and
re-export rather than touching the PNG, which is the whole reason the SVG is
in the repository.

## Still missing

- **The background-location screen recording**, which is the item that gates
  every track including internal testing. It is a video, not a screenshot,
  and it has to show the disclosure, the system permission prompt and
  tracking running, in one take, off a real build.
