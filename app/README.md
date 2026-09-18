# The driver app

Expo SDK 57, React Native 0.86, React 19, TypeScript. iOS and Android from
one codebase. Ticket 7.1, upgraded from SDK 52 when it turned out SDK 52
could not be installed on a current Expo Go and would not have passed a
Play Store target-API check.

```bash
cd app
npm install
npm run typecheck
npm test
npm start          # then scan the QR with Expo Go
```

`npm start` needs the server reachable from the phone, which means the
laptop's LAN address and not localhost:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.x:3000 npm start
```

## It is outside the root npm workspaces, on purpose

`package.json` at the repository root lists `server` and `web` and does not
list `app`. That is deliberate, and it is worth writing down because the
obvious thing to do is add it.

React Native pulls in about 900 packages, many of them platform-specific. In
the root workspace they would land in the lockfile that `npm run ci` and the
Render build resolve, and this repository has already been bitten once by
exactly that: regenerating the lockfile in ticket 5.9 silently dropped 74
`@esbuild/*` platform entries, which installed fine on Windows and would have
failed on Render's Linux builder.

So the app keeps its own `package-lock.json`. `npm run ci` at the root stays
the server and the web shell, unchanged in scope and speed, and the app is
checked with its own `npm run typecheck` and `npm test`. When there is a CI
pipeline that builds the app, it gets its own job.

## What is tested and what is not

**Tested, under vitest, on a laptop:** `src/lib/http.ts`. It imports nothing
from expo or react-native, which is why it is a separate file from
`api.ts`: URL joining, header construction, error shaping, and the one error
that means sign out.

**Not tested, and not claimed to be:** the screens and the Keychain. Testing
React Native components needs `jest-expo` and a renderer, and testing
`expo-secure-store` needs a device or an emulator. Neither exists here: this
is a Windows machine with no Android SDK and no way to build for iOS.

So the app in this ticket **has been typechecked and never run**. That is the
honest state of it, and it is the reason 7.1 stops where it does.

## What the SDK 57 upgrade could and could not verify here

"Typechecked and never run" hid a real defect for three tickets:
`app.config.ts` imported a TypeScript module, Expo's config loader can only
require plain JavaScript, and so **every build failed at startup** while
typecheck and 102 tests stayed green. Bundling is now part of checking this
app, not an afterthought.

**Verified on this machine, against SDK 57:**

- `npx expo export --platform android` bundles: 731 modules.
- `npx expo-doctor`: 21 of 21 checks pass.
- Typecheck under TypeScript 6, and all 102 tests.
- The release-build guard in `src/lib/apiUrl.cjs` refuses an unset URL, a
  localhost URL and a plain-HTTP URL against a real export, and builds with
  a good one.
- `npx expo prebuild --platform android` produces a manifest carrying
  `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_LOCATION`, and `expo-location` contributes the
  `LocationTaskService` with `foregroundServiceType="location"`.
- `targetSdkVersion` is 36, which is what a current Play Store submission
  needs.

**NOT verified here, and it needs saying:**

- **The iOS Info.plist.** `expo prebuild --platform ios` refuses to run on
  Windows, so nothing on this machine can show what permission strings
  actually land in the built app. The App Store reviewer reads those
  strings, so they matter.
  
  Mitigated rather than left to chance: the three `NSLocation*` values in
  `app.json`'s `infoPlist` and the three matching `expo-location` plugin
  props are now **byte-identical**, so whichever source Expo applies last,
  the text is the one in `docs/app-store-submission.md`. Check it on a Mac
  or on an EAS build before submitting anyway.

- **Anything on a device.** No emulator, no Mac. Background location, the
  Keychain and the signature pad have still never executed.

- **iOS Expo Go.** Not a gap in this project: Apple does not allow
  sideloading older versions, so only the current Expo Go installs, which is
  the reason the SDK had to move.

## What the app does

Apply to drive, sign in, see what onboarding is outstanding, pick a contract,
and then three tabs: today's run, work going, and what you asked for. That is
7.1, 7.2 and 7.3.

**Background location is the only reason this is native at all** (7.4).
Everything else the app does, the PWA already did: install to the home screen,
work offline, use the camera, read a position when asked. What a web app
cannot do on iOS, and will not be able to, is report a position while it is in
the background. That single requirement is what made this React Native rather
than a saved bookmark, and it is worth remembering when somebody asks why
there are two front ends.

Tracking starts and stops with the shift, on the same tap, and the screen says
which state it is in at all times. **It records nothing until somebody sets
`RETENTION_LOCATION_TRACE_DAYS` on the server**, because there is no agreed
period to keep it for; the app treats that answer as a permanent stop rather
than something to retry.

**No router, and that is a change of mind worth recording.** 7.1 said
expo-router would arrive in 7.3 once there was something to route. Having
built it, there is not: the three tabs have no history, no back stack, no deep
links and no parameters. A router would add a dependency, a directory move and
a build-time plugin to produce the same three taps, on an app nobody here can
run to find out what it broke. Ticket 7.4 is what earns it: a push
notification that opens one stop is a deep link, and deep links are what
routers are for.

**Document photographs are not part of it, and that is deliberate.** There is
nowhere to put one: file storage is off until the AWS BAA in ticket 0.10 is
filed, which is the same reason a doorstep photo is refused rather than
recorded without evidence. And even with a bucket, ticket 6.2 does not store
documents at all: the table records that a named person saw one, when, and
what it was called, because a background check report sitting in a courier
database is a second breach waiting for the first one.

What the app does instead is take a **reference** for each gate that is the
applicant's to supply, so staff verifying a training certificate have its
number without telephoning for it. Sending a reference **verifies nothing**;
a named member of staff still checks each one, and the screen says so rather
than turning a row green.

Since 7.5 a stop can be worked from the phone: arrive, hand over against a
signature, or record that it could not be delivered. It arrived in one piece
rather than a button at a time, because a courier who can mark a delivery but
cannot sign for it has broken the chain of custody this contract is built on.

**Everything goes through the offline queue, always**, not only when the phone
is offline. San Antonio has basements, lift shafts and loading docks, and a
courier standing in one of them has still made the delivery. The alternative,
try the network and fall back to a queue, has two code paths and only one of
them is exercised on a good day, which is how an offline path rots.

**Left at the door is not offered**, and it is not an oversight: a doorstep
delivery needs a photograph and file storage is off until the AWS BAA in ticket
0.10. The web shell refuses it for the same reason rather than recording an
unwitnessed drop.

Collecting from a pharmacy and handing undelivered packages back are still on
the web app.

## The credential

The web shell uses a cookie. This app uses a bearer token, and the server grew
an explicit path for it in ticket 7.1
(`server/src/core/auth/sessions.ts`, `NATIVE_CLIENT_HEADER`).

React Native's `fetch` does have a cookie jar on both platforms, so relying on
cookies would work on a good day. It is the wrong answer anyway: that jar is
shared process-wide, persists differently on iOS and Android, cannot be
inspected by the app, and cannot be put in the Keychain. An app that sends
`X-Izy-Client: app` on login gets the token in the response body and **no
cookie at all** — one credential per client, and the client says which it
wants. The token goes to `expo-secure-store`, which is the iOS Keychain and
the Android Keystore.

The session token is never given to a web caller, and there is a test
asserting the word does not appear in a web login response
(`server/test/auth-bearer.test.mjs`).

## Pointing it at a server

`app.json`, `expo.extra.apiBaseUrl`. It defaults to `http://127.0.0.1:3100`,
which is the rehearsal server from `docs/day-rehearsal.md`.

A simulator reaches the host differently from a physical phone: a real device
on the same network needs the machine's LAN address, not `127.0.0.1`. That is
the first thing to change when the app is run for the first time.
