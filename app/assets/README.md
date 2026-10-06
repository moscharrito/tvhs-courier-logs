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
  `ADAPTIVE_BACKGROUND` in `src/lib/appIcons.cjs`, currently `#0B6E4F`.
  Change it there if the brand green moves.

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

## Not here yet

**A splash screen.** Expo SDK 52 moved it out of `app.json` and into the
`expo-splash-screen` config plugin, which is not installed. Neither store
requires a splash image, so this is not blocking submission, and adding a
dependency was out of scope for the icon work. When it is wanted, install the
plugin and extend `resolveIcons` the same way.

**A notification icon.** Android draws push notification icons as a white
silhouette on a transparent background, so the app icon cannot be reused. Only
needed when push notifications ship (ticket 7.4).
