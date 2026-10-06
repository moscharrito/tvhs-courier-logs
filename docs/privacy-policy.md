# Privacy Policy: Izy Courier

**Izy Global Services LLC**

**DRAFT. NOT YET REVIEWED BY AN ATTORNEY, AND NOT YET PUBLISHED.**

Every factual claim below was written from the code that implements it, and
the file is named beside each one so a reviewer can check rather than trust.
Where the code does not yet decide something, this says so rather than
inventing a number. Those gaps are listed at the end and have to be closed
before this is published, because a privacy policy that overstates what the
software does is worse than none.

Last updated: 6 October 2026. Applies to the Izy Courier mobile application
and the Izy Global Services operations portal.

---

## Who this is for, and who it is not for

Izy Courier is used by **couriers employed or contracted by Izy Global
Services**, and by **staff at the healthcare organisations we deliver for**.

**If you are a patient receiving a delivery, this policy is not the one that
governs your information.** Izy Global Services handles your details as a
business associate of your healthcare provider, under a Business Associate
Agreement with them and under HIPAA. Your provider's own notice of privacy
practices governs. We do not sell, share or use your information for anything
other than making and proving your delivery.

---

## What the app collects from a courier

| What | When | Why |
|---|---|---|
| Name, email, phone | At sign-up | The account, dispatch contact, and the name recorded against a handover |
| Precise location | **Only while on shift** | So dispatch can tell whether a delivery will meet its deadline |
| Photographs | At a doorstep, when taken | Proof that a delivery was made |
| Signatures | At a doorstep, when captured | Proof of who received a delivery |
| Device and session records | While signed in | So an administrator can see and revoke access to a lost phone |

### Location, specifically

This is the part worth reading closely, and the part both app stores examine.

- Location is collected **only between the moment a courier starts a shift in
  the app and the moment they end it.** Outside that window the app sends
  nothing, and the server refuses anything sent outside it. This is enforced
  on the server, not only in the app.
- The app **says on screen, whenever it is open, whether it is recording.**
- On Android a visible notification runs for the whole time tracking is
  active.
- Location is **never** used for advertising, for analytics, for measuring a
  courier's productivity, or for anything other than dispatching that
  courier's own deliveries.
- There is **no third-party analytics or advertising code in the app at all.**
  Nothing about a courier is sent to any company other than the service
  providers listed below.

**"Used for tracking", in the sense both app stores mean it, is No**, and that
answer is a commitment. It means following a person across other companies'
apps and websites. Nothing here does that, and adding anything that did would
change this policy first.

---

## What the app does not collect

- **No patient information is collected by the app from a courier.** The app
  *displays* a patient's name and address to the courier assigned to that
  delivery, and sends neither anywhere except back to our own server. The
  pool of unassigned work carries neither.
- No contacts, no photo library, no microphone, no health data, no motion
  data. The app asks the camera for a doorstep photograph and never opens the
  photo library, because a picture chosen from a gallery is not evidence that
  somebody stood at a door.
- No advertising identifier.

---

## Who else sees it

We use a small number of service providers, each under contract and, where
they touch health information, under a Business Associate Agreement:

- **Hosting and database.** Application hosting and the operational database.
- **File storage.** Doorstep photographs and signature images.
- **Email and SMS.** Notifications to staff, and delivery notices to patients
  where the healthcare organisation has asked for them.
- **Maps and geocoding.** Used for **facility addresses only.** The system
  refuses to send a patient address to a geocoding provider, in code rather
  than by policy.

We do not sell personal information. We do not share it for advertising. We
disclose it otherwise only where the law requires it.

---

## How long it is kept

**This section is incomplete and must be completed before publication.**

The software distinguishes periods that a person with authority has decided
from periods that nobody has. Of seven categories of record, **one has been
decided**:

- **Replies held for a retrying phone: 7 days.** Decided.
- **Audit records: kept indefinitely.** Decided. These record who did what and
  never contain patient information.
- **Delivery records, proof-of-delivery photographs, signatures, invoices:
  undecided.** The code carries a seven-year placeholder that is explicitly
  marked undecided, and the purge refuses to act on it. Nothing is being
  deleted on that basis.
- **Courier location traces: undecided, and nothing is collected until it is
  decided.** The system refuses to store a single position until a retention
  period is set. This is deliberate: a trail of an identified employee has
  almost no operational value the day after a shift, and every day it is kept
  is a day it can be subpoenaed or breached. The intended answer is days, not
  years.

A published policy must state real periods. These numbers are a decision for
Izy Global Services with its counsel, not a default a developer picked.

---

## A courier's rights over their own record

A courier may ask us for a copy of what we hold about them, ask for a
correction, and ask for deletion of anything we are not required to keep as a
delivery record. Delivery records, signatures and proof-of-delivery images are
evidence of a controlled-substance handover and are kept under our contract
with the healthcare organisation; those cannot be deleted on request.

Sessions and devices can be revoked at any time, by the courier from their own
account or by an administrator.

Texas residents and residents of other states with applicable privacy laws
have additional rights; contact us using the details below.

---

## Security

- Everything travels over HTTPS. The app refuses to build against a plain
  HTTP address.
- Passwords are stored hashed, never in plain text.
- Access is scoped by role: a courier sees only their own assigned work, a
  pharmacy lead sees only their own pharmacy, and pricing and invoices are
  withheld from couriers at the server rather than hidden in the interface.
- Records of custody and of administrative actions are append-only, enforced
  by the database, so they cannot be altered after the fact.
- Every read of a patient record is recorded.

---

## Children

Izy Courier is a tool for working couriers and healthcare staff. It is not
directed to children and we do not knowingly collect information from anyone
under 18.

---

## Changes

Material changes will be notified in the app before they take effect.

## Contact

**TO BE COMPLETED.** Both stores require contact details that reach a person.

```
Izy Global Services LLC
[postal address]
[privacy contact email]
[telephone]
```

---

# Before this is published

| | |
|---|---|
| **Retention periods** | Six of seven categories undecided. Needs a decision from Izy with counsel. |
| **Contact details** | Address, email and telephone that reach a person. |
| **Attorney review** | This is a draft written from the code by an engineer. HIPAA, Texas law and state privacy laws all bear on it. |
| **Service provider names** | Left generic deliberately. Naming vendors is a decision about disclosure; some organisations name them, some do not. Decide, then be consistent with the Data Safety and privacy nutrition label answers. |
| **A public URL** | Both stores require one that is reachable without signing in. It must stay reachable for as long as the app is listed. |

The claims in this draft match the code as of 6 October 2026. If the app
gains an analytics library, a crash reporter, an advertising identifier, or
starts collecting location outside a shift, this policy is wrong and must
change in the same commit.
