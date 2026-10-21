# Submitting the driver app

Ticket 7.6. Written before the first build rather than after the first
rejection, because the thing most likely to decide that review is a paragraph
somebody types into a text box at the end of a long day.

**Nothing here has been submitted.** There are no developer accounts yet, this
machine cannot build for either platform, and several items below are blocked
on things that are not code. This is the package, the checklist, and an honest
list of what is in the way.

---

## What I cannot do, and you can

| | |
|---|---|
| **Apple Developer Program** | 99 USD a year. Needs a D-U-N-S number for an organisation account, which takes days to a couple of weeks if Izy does not have one. Get this started first: it is the longest lead time in the list. |
| **Google Play Console** | 25 USD, once. Google requires most new personal accounts to run a closed test before production; an **organisation** account is the one to open. |
| **Building** | Needs macOS for iOS. EAS Build does it in the cloud, which is why `eas.json` is here. |
| **The server the app points at** | A reviewer in California must be able to sign in. See below: this is the item most likely to fail the review. |

---

## The background location justification

Apple asks, in App Store Connect, why the app needs `UIBackgroundModes:
location`. This is the answer to paste. It is written to be read by somebody
who has forty of these to get through.

> Izy Global Services is a contracted medical courier for University Health in
> San Antonio, Texas. Drivers carry prescription medication, including
> controlled substances, from hospital pharmacies to patients at home under
> deadlines set by that contract: two hours for an urgent delivery, one hour
> from collection.
>
> Dispatch must be able to see where a driver is while they are working, in
> order to tell whether a delivery is going to make its deadline and to
> reassign it to another driver if it is not. A driver is holding a package
> and driving; they cannot keep the app in the foreground, and a position that
> stops updating when the screen locks is a position that is wrong exactly
> when it matters.
>
> Location is collected **only while the driver is on shift.** The driver
> starts a shift explicitly in the app and ends it explicitly. Outside that
> window the app sends nothing, and the server refuses anything sent outside
> it. The app displays its tracking state in plain words at all times, and on
> Android runs a visible foreground-service notification for the duration.
>
> Location is not used for advertising, analytics, or any purpose other than
> dispatching the driver's own deliveries.

**Why this is the likeliest rejection.** Background location is reviewed
closely and rejections for it are common. Two things reduce the odds, and both
are already true of the app rather than claims in a form: the permission is
requested when the driver goes on shift rather than at launch, and the
tracking state is on screen whenever the app is open.

If it is rejected, the resubmission is the same text plus a screen recording
of the shift being started and the banner changing. Budget for that round.

---

## Google gates background location on EVERY track, closed tests included

Checked 15 October 2026, because the plan was to publish to Play while Apple
enrolment finished and this decides whether that is a week or a month.

`app.json` requests `ACCESS_BACKGROUND_LOCATION`. Google's own page on the
permission instructs developers who do not need it to remove it "for all APKs
across all tracks (including closed and open tracks)" — naming closed tracks
explicitly. So the **permission declaration has to be on file before a closed
test, not just before production.** There is no quick internal Play track that
skips it for an app that requests this permission.

What the declaration needs beyond the text already written above for Apple:

- Google asks for a **screen recording** showing the in-app disclosure, the
  permission prompt, and the feature working. The prompt appears when the
  driver goes on shift, which is the thing worth filming.
- The in-app disclosure must appear **before** the system prompt and must say
  who collects the data and why. The shift screen does this; confirm the
  wording matches the declaration before filing, because a mismatch between
  the two is a documented rejection reason.

**A separate deadline, close enough to matter.** Google is making a precise
location (`ACCESS_FINE_LOCATION`) declaration mandatory from **28 October
2026** for apps targeting **API level 37 or later**. This app targets 36, so
it is not caught today — but that is four days before go-live, and an Expo SDK
bump that moves targetSdk to 37 would walk into it. Check the Policy Deadlines
page in the Console before any SDK upgrade.

**Therefore the Play Store is not the way to get the app onto 18 phones for
testing.** The `preview` profile in `eas.json` is already internal
distribution pointing at production: it installs by link or QR code with no
Console, no review and no declaration. Play runs in parallel on its own clock.

## The reviewer has to be able to sign in

**This is the item most likely to waste a cycle, and it is not about
location.**

A reviewer runs the app on a device in California. If the build points at
`127.0.0.1`, or at a server on a private network, or at one that is only up
during business hours, they tap Sign in, nothing answers, and the app is
rejected as broken.

Three things have to be true before the first submission:

1. **A reachable server over HTTPS.** `eas.json` carries
   `EXPO_PUBLIC_API_URL` per profile, and both release profiles say
   `https://logs.izyglobalservices.com`, which is live and answering.
   `src/lib/apiUrl.cjs` **refuses the build** if a release profile is left
   unset, points at localhost, or uses plain HTTP. (Both profiles used to say
   `REPLACE-ME.example.com` so the placeholder could not ship by accident;
   that is no longer the state, and the guard is what still enforces it.)
2. **A demo account, supplied in App Store Connect.** A courier account on a
   project with a run on it. Apple requires the credentials; Google asks for
   them when a login wall exists.
3. **Work on the demo account's board.** An app that signs in to an empty
   screen reads as broken. Seed the demo project with a few stops, the way
   `npm run rehearse:two -w server` does.

**The demo account is a real account on a real server.** It must not have any
University Health data on it, real or sampled. `docs/day-rehearsal.md` and the
rehearsal scripts already generate invented names and addresses; use those.

---

## What the app collects, in the terms both stores ask

Apple calls these privacy nutrition labels; Google calls it the Data Safety
form. They must match what the app does, and what the app does is in the
code: `modules/uh/tracking.ts` and `core/onboarding/routes.ts`.

| Data | Collected | Linked to the user | Used for tracking | Why |
|---|---|---|---|---|
| Precise location | Yes | Yes | **No** | Dispatch, while on shift only |
| Name | Yes | Yes | No | The driver's own account and their signature on a handover |
| Email | Yes | Yes | No | Sign-in identity |
| Phone | Yes | Yes | No | Dispatch calls drivers |
| **Photos** | **Yes** | **Yes** | **No** | The signed courier form on every controlled handover; a patient's identification where the pharmacy marked the order ID Required; an optional doorstep photograph |
| Other user content | Yes | Yes | No | Historic signature strokes, captured before the move to paper forms |

**"Used for tracking" is No on every row, Photos included, and that answer has
to stay No.** In both stores
it means following a user across other companies' apps and websites for
advertising. Nothing here does that, there is no third-party SDK in the app,
and adding an analytics library later would change this answer and the
submission with it.

**PHOTOS IS WHERE PATIENT DATA ENTERS THIS TABLE, AND IT HAS TO BE DECLARED.**

This table said "Other user content: signatures captured at a doorstep" and
then that the app collects no patient data. Both were true when written and
neither survived the move to paper: `lib/pod.ts` now declares
`PhotoKind = 'doorstep' | 'courier_form' | 'patient_id'`, the manifest declares
CAMERA, and `modules/uh/stop.ts` refuses a controlled delivery without the form
photograph.

So the app photographs a form carrying the patient's name and both signatures,
and on ID Required orders it photographs the patient's identification. That is
patient data collected and transmitted, not displayed. Declaring Photos and
saying what is in them is the accurate answer; the earlier wording would have
been a false statement about a third party's sensitive data on a form Google
requires to match the app.

What remains true: the app never types patient details anywhere, sends nothing
except to our own server, and the claimable board carries neither name nor
address, by design (ticket 6.4).

---

## Before the first submission

Things that are done:

- [x] Permission strings that say what the feature does, not "to improve your
      experience" (`app.json`, and the `expo-location` plugin). **The two
      sources are now byte-identical on purpose:** `infoPlist` and the plugin
      props both set the three `NSLocation*` keys, they disagreed in wording,
      and `expo prebuild --platform ios` cannot run on Windows so nothing here
      can prove which one wins. Confirm the built Info.plist on a Mac or from
      an EAS build before submitting
- [x] Expo SDK 57, `targetSdkVersion` 36. **This was not on the list and
      should have been.** The app was on SDK 52, from November 2024: too old
      to install on a current Expo Go, and below the Play Store's rolling
      target-API requirement, so it could not have been submitted at all.
      Verified by `expo prebuild` rather than assumed
- [x] `NSMotionUsageDescription` is deliberately omitted
      (`motionUsagePermission: false`). The plugin adds it by default, and a
      permission string for motion data would have contradicted the table
      above, which says we do not collect it
- [x] Background modes declared for iOS, foreground service for Android
- [x] A release build refuses to point at localhost or plain HTTP (ticket 7.6)
- [x] Tracking scoped to a shift, enforced on the server, not only in the app
- [x] The app says plainly when it is recording location

Things that are not, and are not code:

- [ ] **Apple and Google accounts.** Start the D-U-N-S number now.
- [x] **The app icon.** `assets/icon.png` and `assets/adaptive-icon.png`, and
      they are wired up in `app.config.ts` rather than `app.json` for a
      reason: Expo substitutes its own icon when none is configured, so static
      config cannot say "stop". `src/lib/appIcons.cjs` **throws on a
      production build with no artwork** and warns on a preview one.
- [ ] **The store listing artwork, which is not the app icon.** Google wants a
      1024x500 feature graphic and at least two phone screenshots; neither is
      in the repository. These are uploaded in the Console, not built into the
      app, which is why the icon being done does not cover them.
- [ ] **A privacy policy at a public URL.** Both stores require one, and it
      has to describe the location collection above in the same terms.
      **Half done, and the half that is left is the one a reviewer sees.**
      `https://logs.izyglobalservices.com/privacy` is live and serves the real
      policy, written from the code. Its own first line still reads *"DRAFT.
      NOT YET REVIEWED BY AN ATTORNEY, AND NOT YET PUBLISHED."* That is the
      URL that goes in the Play Console, a reviewer opens it, and the page
      says it is not published. The banner is accurate, so the fix is the
      attorney review rather than deleting the sentence.
- [ ] **A demo account and a reachable server.** See above.
- [ ] **Support contact details** that reach a person.

Things blocked on decisions that are open elsewhere:

- [x] **`RETENTION_LOCATION_TRACE_DAYS`.** Seven days, declared in
      `render.yaml` rather than left to somebody to type into the Render
      dashboard. It sat on this list as an open item for weeks because it was
      a variable nobody owned; in the blueprint it is a commit, with the
      argument for the number beside it. Production collects tracks and purges
      them after a week, so a reviewer sees the feature working rather than a
      banner saying it is off.
- [ ] **The BAAs (ticket 0.10).** The app handles PHI. Submitting a medical
      courier app before the business associate agreements exist puts the
      contract, not the review, at risk.
- [ ] **Worker classification.** Flagged when the DoorDash model was chosen
      and still open. It changes what the app records about a driver, and it
      is an attorney's question.

---

## One thing worth deciding early

Both stores treat an app that is only usable by approved drivers as a
**business or enterprise** app, and both have asked such apps to explain why
they are on a public store at all rather than distributed internally.

There is a good answer here and it is worth having ready: drivers apply
through the app (ticket 7.2), so it is genuinely public-facing software with a
public signup, not an internal tool. If that changes, and driver onboarding
moves off the app, the distribution question changes with it: Apple Business
Manager and Google's managed distribution exist for exactly that case and
avoid public review entirely.
