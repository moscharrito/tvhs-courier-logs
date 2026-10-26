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
      **Half done, and the half that is left is not a code change.**
      `https://logs.izyglobalservices.com/privacy` is live and serves the real
      policy, written from the code. It used to also claim *"NOT YET
      PUBLISHED"*, which was false of a page that had been serving publicly
      all along and was the first thing a reviewer opening the URL would
      read; that half is corrected. Its first line still reads *"DRAFT. NOT
      YET REVIEWED BY AN ATTORNEY."*, which is true, so the fix is the review
      rather than deleting the sentence.
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

---

## The store listing copy

Written to be read by somebody deciding whether to install, and by a
reviewer checking the description against what the app does. Every claim
here is one the Data Safety table above also makes: a listing that promises
more than the form declares is a rejection, and a listing that promises more
than the code does is worse than a rejection.

**IT SAYS IT IS NOT A CONSUMER APP, TWICE AND EARLY.** Anyone who installs
this without an account sees a sign-in screen and nothing else. Said plainly
in the short description and again at the end, that is a listing doing its
job; left unsaid, it is a one-star review saying "doesn't work" and a
support call for the office.

### Short description (80 characters maximum)

> For Izy Global Services couriers. Today's run, proof of delivery, on shift.

75 characters. Two alternatives, if the tone is wrong:

> Delivery app for Izy Global Services couriers. An issued account is needed.

(75) — blunter about access, says less about the work.

> Pharmacy courier app: runs, collections, deliveries, proof. Staff only.

(71) — leads with the work, "Staff only" does the gatekeeping.

### Full description (4000 characters maximum)

> TAG Courier is the working app for couriers contracted to Izy Global
> Services LLC. It is not a consumer app. Accounts are issued by the office,
> and there is nothing to see without one.
>
> It carries two contracts, and a courier picks theirs on the first screen.
> On the University Health contract in San Antonio, couriers deliver
> prescription medication from hospital pharmacies to patients at home, and
> the app walks the run stop by stop. On the Tennessee Valley Healthcare
> System contract, the work is a daily log rather than a doorstep: route
> legs, times, tote counts and mileage, filed for the week. A courier only
> ever sees the contract they drive for.
>
> WHAT A COURIER SEES ON A PHARMACY RUN
>
> A courier signs in, goes on shift, and sees the day's run in the order it
> should be driven, with the current stop first and large enough to read at a
> glance. Each stop says what matters before the door opens: whether the
> medication is refrigerated, whether it is a controlled drug, whether
> identification has to be checked, and whether only the named patient may
> sign for it.
>
> THE PAPER IS THE RECORD. THE APP PHOTOGRAPHS IT.
>
> Every order travels with its own paper form, signed by hand at the pharmacy
> counter and again at the patient's door. The app does not replace those
> signatures. At the final delivery the courier photographs the completed
> form, and on controlled medication the app will not record the delivery
> without that photograph. Where the pharmacy has marked an order ID
> Required, a photograph of the recipient's identification is required too.
> Both are attached to the proof of delivery for that order, so the office can
> produce the signed paperwork for any delivery without going near a filing
> cabinet.
>
> WHAT A COURIER DOES WITH IT
>
> - Today's run, in driving order, the next stop first
> - Collection from a pharmacy, counted and signed for at the counter
> - Delivery recorded against a printed name, with the details shown to check
>   against the person at the door
> - A failed attempt recorded with a reason, when nobody is there
> - Directions handed to the phone's own maps app
> - A shift the courier starts and ends themselves
>
> LOCATION, AND ONLY ON SHIFT
>
> Dispatch has to know roughly where a courier is while they are working, to
> tell whether a delivery is going to meet its deadline and to move it to
> somebody else if it is not. Location is collected only between the moment a
> courier starts a shift in the app and the moment they end it. Outside that
> window the app sends nothing, and the server refuses anything sent outside
> it. The app shows its tracking state in plain words whenever it is open and
> runs a visible notification for as long as it is running. Location is never
> used for advertising or analytics.
>
> NO SIGNAL, NO PROBLEM
>
> Pharmacies have basements and so do apartment blocks. A delivery recorded
> without signal is held on the phone and sent, in the order it happened, as
> soon as there is a bar again. Nothing is lost and nothing has to be redone.
>
> PRIVACY
>
> There is no advertising in this app and no third-party analytics. It
> collects what the work requires and nothing else: the courier's own account
> details, their position while they are on shift, and photographs of the
> signed paperwork. The full policy is at
> https://logs.izyglobalservices.com/privacy
>
> ACCESS
>
> Accounts are issued by Izy Global Services LLC to its own contracted
> couriers. If you are not one, this app will not do anything for you.

3,431 characters, inside the 4,000 limit. The second contract is now in
it: TVHS is a weekly log of route legs, times, totes and mileage rather
than a doorstep, and a listing that described only the pharmacy work
would read as the wrong app to a reviewer who opened the contract
picker and saw two.

---

## The Play background location declaration

**THE TEXT ABOVE IS APPLE'S.** App Store Connect asks one open question about
`UIBackgroundModes: location` and takes an essay. Google asks several narrow
ones in separate boxes, each with its own limit, and a reviewer reads them as
answers rather than as prose. Pasting the Apple paragraph into Google's form
answers a question it did not ask.

Policy -> App content -> Location permissions. Four answers and a video.

### Which feature requires background location?

> Driver shift tracking. While a courier is on shift, dispatch sees their
> position on the delivery board so it can tell whether each prescription
> delivery will meet its contractual deadline, and reassign it to another
> courier if it will not. Deliveries carry two-hour and one-hour deadlines
> set by the healthcare contract.

### Why can the feature not use foreground location?

> A courier drives between stops with the phone in a pocket or a cradle and
> the screen off, and carries packages to a door with the app closed. Those
> are exactly the minutes dispatch needs the position for. Foreground-only
> location would update while the courier is looking at the app -- standing
> still, reading their next stop -- and stop updating as soon as they drive,
> which inverts when the data is useful. A position that is last known from
> the previous doorstep cannot tell dispatch whether the next delivery is
> going to be late.

### Is background location core to the app's functionality?

> Yes for the dispatch feature, no for the courier's own work. A courier can
> complete every delivery with the permission declined: collections,
> deliveries, photographs and proof of delivery all work. What is lost is
> dispatch's ability to see the run in progress and move work before a
> deadline is missed.

### How is the user told, and how is it limited?

> The app shows a prominent in-app disclosure explaining background
> collection and why, BEFORE the system permission prompt, the first time a
> courier goes on shift. Declining opens the shift untracked and the courier
> keeps working.
>
> Collection runs only between the courier explicitly starting a shift and
> explicitly ending it. Outside that window the app sends nothing and the
> server rejects anything sent outside it. While it runs, Android shows a
> foreground-service notification for the whole duration and the app's own
> banner states the tracking state in plain words whenever it is open.
>
> Location is never used for advertising or analytics, and is never shared
> with a third party. These are couriers employed under contract, tracked
> only during their paid shift.

### The video

Required, and the thing most likely to send this back. One take, no cuts,
off the release build:

1. Open the app, signed out or on the contract picker.
2. Sign in and reach the run.
3. Tap **Go on shift**. Let the DISCLOSURE sit on screen long enough to read
   -- this is the frame the reviewer is looking for.
4. Accept the system permission prompt, including "Allow all the time" if
   Android asks a second time.
5. Show the banner changing to the on-shift tracking state.
6. Pull down the notification shade and show the foreground-service
   notification.
7. Back in the app, record something against a stop.

Upload it, or put it somewhere with a public link that does not expire.
An unlisted YouTube video is what most submissions use.

**Why this is the likeliest rejection.** Two things reduce the odds and both
are true of the app rather than claims in a form: the permission is requested
when the courier goes on shift rather than at launch (`lib/shift.ts` orders
`disclose` before `askPermission`), and the tracking state is on screen the
whole time. Budget for one round anyway.

---

## The Play Data Safety answers

Policy -> App content -> Data safety. Answered in the order the Console
asks, and checked against the code rather than against what the app feels
like it does. Google requires the form to match the app; a reviewer can
decline the location prompt, watch the network, and find out.

### Overview

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** -- HTTPS only; `src/lib/apiUrl.cjs` refuses to build a release pointed at plain HTTP |
| Do you provide a way for users to request that their data is deleted? | **Yes** -- a courier asks the office; see the policy's rights section. Delivery evidence is exempt under contract and the policy says so |

### Location -> Precise location

Collected **yes**, shared **no**, processed ephemerally **no**, **required**,
purpose **App functionality** only.

**Precise, not Approximate.** `lib/tracking.ts` uses
`Location.Accuracy.Balanced`, which is roughly a hundred metres. That is
coarser than a navigation fix and still far inside Google's threshold for
Precise, which is any area under three square kilometres. Declaring
Approximate because the app does not ask for the finest available fix would
be wrong.

### Personal info -> Name

Collected **yes**, shared **no**, **required**, **App functionality** and
**Account management**.

Two names, and the second is the one that gets forgotten: the courier's own
name on their account, AND the printed name of whoever took the delivery,
typed at the door (`screens/Stop.tsx`, `signedName`). The second is a third
party's name captured on the device and sent to our server.

### Personal info -> Email address

Collected **yes**, shared **no**, **required**, **Account management**.

### Personal info -> Phone number

Collected **yes**, shared **no**, **required**, **App functionality**.

The courier's own number, for dispatch to call them. A patient's number is
displayed to the assigned courier but travels from the server to the phone,
not from the phone to us, so it is not collected in this form's sense.

### Personal info -> User IDs

Collected **yes**, shared **no**, **required**, **Account management**.

The username a courier signs in with.

### Photos and videos -> Photos

Collected **yes**, shared **no**, processed ephemerally **no**,
**required**, **App functionality**.

Three kinds, from `lib/pod.ts`: `'doorstep' | 'courier_form' | 'patient_id'`.
The signed courier form on every controlled handover, a photograph of the
patient's identification where the pharmacy marked the order ID Required,
and an optional doorstep photograph. The camera is the only source; the
photo library is never opened.

### Everything else: not collected

Ticking nothing is also an answer, and these are the ones worth being able
to defend:

- **Device or other IDs: NO.** There is no advertising ID, no Android ID and
  no hardware identifier anywhere in the app. Device enrolment stores a
  label and the user agent string (`core/auth/devices.ts`), and the row's id
  is a hash of the session token. Nothing that follows a handset.
- **Health and fitness: NO.** The app carries prescriptions; it records no
  health measurements about the person using it.
- **Financial info: NO.** Courier pay is calculated on the server from
  completed work. The app shows no money and collects none.
- **Messages, Contacts, Calendar, Audio, Files, Web browsing: NO.**
- **App activity / App info and performance: NO.** There is no analytics
  SDK and no crash reporter in the app.

### The two answers that must stay No

**"Shared with third parties" is No on every row.** Shared has a specific
meaning here: transferred to another company. Our hosting, storage and SMS
providers are service providers under contract and under BAAs, which Google
does not count as sharing.

**"Used for tracking" / advertising purposes: No on every row.** It means
following a user across other companies' apps for advertising. Nothing here
does that, and there is no third-party SDK in the app. Adding an analytics
library later changes this form and the submission with it.

---

## Content rating, target audience, health apps

Three more cards under Policy -> App content. None is hard; two have a
question that reads wrong for this app and gets answered wrong by reflex.

### Content rating (the IARC questionnaire)

Category: **Utility, Productivity, Communication or Other**.

| Question, in substance | Answer |
|---|---|
| Violence, blood, sexual content, crude humour, horror | No to all |
| Gambling, simulated gambling, contests | No |
| **References to or depictions of illegal drugs** | **No** |
| Promotes alcohol, tobacco, or drug use | No |
| Profanity | No |
| Allows users to interact or communicate with each other | **No** |
| Allows users to share their location with other users | **No** |
| Allows users to exchange user-generated content | **No** |
| Shares the user's location with third parties | No |
| Allows purchases | No |

**THE DRUGS QUESTION IS THE ONE THAT GETS ANSWERED WRONG.** The app is for
couriers carrying controlled substances, and the honest reflex is to tick
yes. IARC means depiction, reference or glamorisation of ILLEGAL drug use --
the thing that raises an age rating. Prescription medication logistics is
not that, and answering yes rates the app 17+ for no reason and invites
questions that have nothing to do with it.

**USER INTERACTION IS NO, AND THAT WAS CHECKED.** There is no chat, no
thread, no compose box and no way for one courier to send anything to
another anywhere in the app -- `app/src/screens/` has no messaging surface.
The web portal has staff threads; the phone app does not, and this
questionnaire is about this app.

**LOCATION SHARING WITH OTHER USERS IS ALSO NO**, which is a different
question from the Data Safety one and worth reading twice. A courier posts
their own position and cannot read anybody's: `modules/uh/tracking.ts` has
`POST /` for couriers and `GET /live` for staff only. Dispatch is the
employer, not another user. Yes here would imply couriers can see each
other, which they cannot.

Expect a rating of **Everyone / PEGI 3** or equivalent. An app for employees
with no content in it rates low, which is correct and not a mistake.

### Target audience and content

Age groups: **18 and over** only.

Nothing else ticked. Selecting any under-18 band pulls the app into the
Families policy, which brings a different ads and content regime and a
second review, for an app only contracted couriers can sign into.

"Could your app be unintentionally appealing to children?" -- **No**.

### Health apps

Expect this card, and do not try to duck it. The app carries prescription
medication for a healthcare system.

| Question, in substance | Answer |
|---|---|
| Is this a health app? | **Yes** |
| Does it handle Protected Health Information? | **Yes** -- patient names, addresses, photographs of signed forms and of identification |
| Is it a medical device, or does it make diagnostic or treatment claims? | **No**. It is logistics: it moves a package and records who took it |
| Does it provide medical advice? | **No** |
| Clinical trials, research, or health measurements from the user | **No** |

**Answering "not a health app" would be false and checkable.** The listing
says prescription medication, the privacy policy says Business Associate
Agreements, and the Data Safety form declares photographs of patient
identification. A reviewer who reads two of those and then sees "no" on
this card has found an inconsistency, and inconsistency is what gets an app
pulled rather than rejected.

Have the BAA position straight before filing this one. Google may ask what
legal basis covers the health information, and "the BAAs are not filed yet"
is an answer with consequences.

---

## Keeping the source map for a release that shipped

**A Hermes build's JavaScript crashes come back as bytecode offsets.** The
only thing that turns one into a stack trace anybody can read is the source
map produced by the build that shipped — and Gradle writes that into
`app/android/app/build/`, which the next build overwrites.

So the map survives exactly until somebody rebuilds. After that a crash
report from a courier's phone is unreadable for ever. **Archive it at the
moment a build goes to Play**, not later, because later is already too late.

The archive lives outside this repository:

```
..\tag-release-archive\android-<versionCode>\
    index.android.bundle          the bytecode that shipped
    index.android.bundle.map      what makes a crash readable
    MANIFEST.txt                  versionCode, hashes, the commit, what changed
```

Outside the repo deliberately: it is megabytes per build, it is an output
rather than a source, and this repository is public. The `.aab` is not
copied there either — Play holds it, App Bundle Explorer hands it back, and
the SHA-256 in MANIFEST.txt is what proves a copy found later is the one
that shipped.

**Nothing consumes the map yet.** Reading a crash with it means
`npx metro-symbolicate index.android.bundle.map < stack.txt`, or wiring a
crash reporter that understands Hermes. That is a real piece of work and
it is not done.

### It is NOT the deobfuscation file Play asks for

Play Console warns on every upload that no deobfuscation file is attached.
That warning is conditional on using R8, and this app does not:
`android.enableMinifyInReleaseBuilds` is unset, `minifyEnabled` is false,
and no `mapping/` directory is produced. Java and Kotlin frames are already
unobfuscated, so there is nothing to upload and the warning can be ignored.

**Do not switch minification on to silence it.** React Native relies on
reflection in places that need Proguard keep-rules, and getting those wrong
produces crashes that appear only in release builds — on couriers' phones,
not in testing.
