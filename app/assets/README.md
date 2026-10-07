# App artwork

Drop two files in this directory and the builds pick them up. Nothing else to
change.

```
assets/icon.png             1024 x 1024    iOS, and both store listings
assets/adaptive-icon.png    1024 x 1024    Android foreground layer
```

Until both are here:

- a **`production`** build **stops**, naming what is missing. That is the only
  profile a store ever sees, and Expo substitutes its own icon when none is
  configured, so without this a store build does not fail: it succeeds and
  produces an app wearing somebody else's logo.
- a **`preview`** build **warns and carries on.** It is
  `distribution: internal`, so it reaches our own drivers by link rather than
  a store, and blocking it would mean nobody can put a build on a phone until
  somebody has drawn a logo.
- a **development** build says nothing.

See `src/lib/appIcons.cjs`.

> An earlier version of this stopped `preview` too, with an
> `IZY_ALLOW_DEFAULT_ICON=1` escape hatch. That hatch could not work: the
> config is read on an EAS worker for a cloud build, which never sees a local
> shell, so setting the variable before the build command did nothing and the
> build failed anyway. Do not reintroduce it.

---

## icon.png

The square Apple masks, and the one both store listings show.

- **1024 x 1024**, PNG, exactly square.
- **No transparency.** An alpha channel is rejected at submission. Fill the
  whole square, edge to edge.
- **No rounded corners.** iOS rounds them itself; corners rounded in the
  artwork get rounded twice and look wrong.
- No text smaller than the mark itself. This is rendered at 60 points on a
  home screen, and a legible wordmark at 1024 is a smudge at 60.

## adaptive-icon.png

Android 8 and later composites a foreground layer over a background colour and
masks the result to whatever shape the launcher uses, which may be a circle, a
squircle or a rounded square depending on the phone.

- **1024 x 1024**, PNG, **transparent** background.
- **Keep the mark inside the middle 66 percent**, a 676 x 676 box centred in
  the square. Anything outside that can be cut off by the mask.
- The background colour is set in code, not here:
  `ADAPTIVE_BACKGROUND` in `src/lib/appIcons.cjs`, currently `#14532d`, the
  same green as `icon.png` and the splash wordmark. Change it there if the
  brand green moves, and change `icon.svg` with it or the app wears two
  different greens depending on the phone.

One file cannot serve both. iOS wants the artwork filling the square with no
alpha; Android wants it padded with alpha around it. Supplying the same image
twice gives either a cropped Android icon or a rejected iOS build.

---

## Checking it before you build

```bash
cd app
EAS_BUILD_PROFILE=preview npx expo config --type public --json
```

With both files present the output carries `icon` and
`android.adaptiveIcon`. With either missing the command fails and says which.

To see the Android icon as a launcher will mask it, build the preview profile
and install it; the masking is done by the device, so no preview on a desktop
is authoritative.

---

---

## What is here now, and how it was made

`icon.svg` and `adaptive-icon.svg` are the source; the PNGs beside them are
what the build reads. Keeping the vector in the repository means the next
change is a text diff rather than a lost design file.

They are a typographic mark: the TAG wordmark in white on the brand green,
with the same rule the splash screen draws. That is a deliberate choice rather
than a placeholder, for the reason at the top of this file, but it is not a
designed brand identity either. If a designer produces one, replace the two
PNGs and nothing else has to change.

**`scripts/strip-alpha.mjs` exists because a canvas always emits RGBA.** Apple
rejects an icon carrying an alpha channel even when every pixel in it is
opaque, so the iOS square is re-encoded to colour type 2 after rasterising.
The Android layer keeps its alpha, which it needs. Run it again if icon.png is
ever regenerated from a browser, a screenshot or most design tools:

```bash
node scripts/strip-alpha.mjs assets/icon.png
```

It refuses anything that is not 8-bit RGBA non-interlaced rather than guessing,
because a tool that silently mangled an icon would be worse than no tool.

---

## Not here yet

**A splash screen.** Expo SDK 52 moved it out of `app.json` and into the
`expo-splash-screen` config plugin, which is not installed. Neither store
requires a splash image, so this is not blocking submission, and adding a
dependency was out of scope for the icon work. When it is wanted, install the
plugin and extend `resolveIcons` the same way.

**A notification icon.** Android draws push notification icons as a white
silhouette on a transparent background, so the app icon cannot be reused. Only
needed when push notifications ship (ticket 7.4).
