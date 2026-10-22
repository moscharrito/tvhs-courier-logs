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

## Internal testing: the testers list

Testing -> Internal testing -> Testers -> Create email list. Named
`Izy drivers — internal`.

    smallgajiadams@gmail.com
    moscharito@gmail.com
    contracts@izymovers.com

**EVERY ADDRESS HAS TO BE A GOOGLE ACCOUNT.** A Gmail address always is. One
on our own domain is only a Google account if it is a Workspace mailbox or
somebody registered it as one. Play takes a non-Google address into the list
without complaining and that person then never gets access: no error, no
bounce, nothing to diagnose. `contracts@izymovers.com` is the one to check.

**THE OPT-IN LINK IS NOT OPTIONAL.** Copy it from the Testers tab and send it
to all three. Each person opens it and taps "Become a tester" before Play
will show them anything. Until they do, the Play Store says "item not found",
which reads as a broken build rather than as a step nobody took.

**The account on the phone has to be the account in the list.** A tester whose
Play Store is signed in as their personal account will not see a build
listed against their work address.

### Versions uploaded

| versionCode | What happened |
|---|---|
| 1 | Never uploaded. It was Expo's default, not a decision. |
| 2 | Never uploaded. Built, verified, superseded. |
| 3 | **Uploaded to internal testing.** Spent; Play will not take it again. |
| 4 | Current in `app.json`. The next build. |

A versionCode is consumed by any track, internal testing included, so the
bump happens after an upload rather than before the next one.

## Still missing

- **The background-location screen recording**, which is the item that gates
  every track including internal testing. It is a video, not a screenshot,
  and it has to show the disclosure, the system permission prompt and
  tracking running, in one take, off a real build. Until it is approved the
  testers above can be listed, can accept the opt-in, and still cannot
  install.

## Warnings the Console shows, and which to ignore

**"There is no deobfuscation file associated with this App Bundle."**
Ignore it. `android.enableMinifyInReleaseBuilds` defaults to false, nothing
sets it, and no mapping directory is produced -- R8 never runs, so nothing
is obfuscated and there is nothing to deobfuscate. Crash traces arrive
readable already. Google shows this on every bundle without a mapping file
whether or not minification is on.

The same warning suggests R8 would reduce app size, which is true and still
the wrong trade before go-live: it is a new failure mode in a build that has
been verified end to end on a device, to save maybe a tenth of a 53 MB
download. After 1 November, not before.
