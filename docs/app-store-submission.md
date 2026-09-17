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
   `REPLACE-ME.example.com` on purpose so that nobody ships the placeholder
   by accident. `src/lib/apiUrl.ts` **refuses the build** if a release profile
   is left unset, points at localhost, or uses plain HTTP.
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
| Other user content | Yes | Yes | No | Signatures captured at a doorstep |

**"Used for tracking" is No, and that answer has to stay No.** In both stores
it means following a user across other companies' apps and websites for
advertising. Nothing here does that, there is no third-party SDK in the app,
and adding an analytics library later would change this answer and the
submission with it.

**Patient data is not in this table because the app does not collect it.** It
displays a patient's name and address to the assigned courier and sends
neither anywhere except back to our own server. The claimable board carries
neither, by design (ticket 6.4).

---

## Before the first submission

Things that are done:

- [x] Permission strings that say what the feature does, not "to improve your
      experience" (`app.json`, and the `expo-location` plugin)
- [x] Background modes declared for iOS, foreground service for Android
- [x] A release build refuses to point at localhost or plain HTTP (ticket 7.6)
- [x] Tracking scoped to a shift, enforced on the server, not only in the app
- [x] The app says plainly when it is recording location

Things that are not, and are not code:

- [ ] **Apple and Google accounts.** Start the D-U-N-S number now.
- [ ] **An app icon and a splash screen.** Required by both stores. There is
      no placeholder in the repository on purpose: a green square that ships
      by accident is worse than a build that stops.
- [ ] **A privacy policy at a public URL.** Both stores require one, and it
      has to describe the location collection above in the same terms.
- [ ] **A demo account and a reachable server.** See above.
- [ ] **Support contact details** that reach a person.

Things blocked on decisions that are open elsewhere:

- [ ] **`RETENTION_LOCATION_TRACE_DAYS`.** Until it is set the server records
      no location at all, so the app's main feature does nothing and a
      reviewer would be looking at a banner saying so. This must be decided
      before the first submission, not after.
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
