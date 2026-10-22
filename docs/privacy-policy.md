# Privacy Policy: TAG Courier

**Izy Global Services LLC**

Last updated: 22 October 2026. Applies to the TAG Courier mobile application
(package `com.izyglobalservices.courier`, shown in earlier builds as Izy
Courier) and the Izy Global Services operations portal.

---

## Who this is for, and who it is not for

TAG Courier is used by **couriers employed or contracted by Izy Global
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
| Photograph of the signed courier form | At the door, on handover | The form carries both signatures. It is the proof of a controlled-substance handover, and the app will not record one of those without it |
| Photograph of a patient's identification | At the door, **only where the pharmacy marked the order ID Required** | To evidence that the medication went to the named patient |
| Photograph of a doorstep | At a doorstep, optional | Proof that a delivery was made |
| Signatures | Historic records only | Captured on screen before the move to paper forms; kept because a handover recorded with one still means what it meant |
| Device and session records | While signed in | So an administrator can see and revoke access to a lost phone |

### Location, specifically

This is the part worth reading closely, and the part both app stores examine.

- Location is collected **only between the moment a courier starts a shift in
  the app and the moment they end it.** Outside that window the app sends
  nothing, and the server refuses anything sent outside it. This is enforced
  on the server, not only in the app.
- **During a shift, location is collected in the background**, including when
  the app is closed or the screen is locked, so dispatch can follow a delivery
  while the courier drives. Before the phone asks for location permission, the
  app shows a screen explaining this, and a courier who declines can still
  work.
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

- **A courier's phone does not type patient details into anything.** The app
  *displays* a patient's name and address to the courier assigned to that
  delivery, and sends neither anywhere except back to our own server. The pool
  of unassigned work carries neither.
- **It does, however, photograph two documents that concern the patient**, and
  those images come back to our server:
  - the **signed courier form**, which carries the patient's name and both
    signatures, on every controlled-substance handover;
  - the patient's **identification**, on the orders a pharmacy marked ID
    Required.

  These are handled as patient information: stored encrypted, covered by the
  Business Associate Agreements below, and never used for anything but
  evidencing the handover they belong to.
- No contacts, no photo library, no microphone, no health data, no motion
  data. The app opens the camera for those photographs and never opens the
  photo library, because a picture chosen from a gallery is not evidence that
  somebody stood at a door.
- No advertising identifier.

---

## Who else sees it

We use a small number of service providers, each under contract and, where
they touch health information, under a Business Associate Agreement:

- **Hosting and database.** Application hosting and the operational database.
- **File storage.** Photographs of signed courier forms and of patient
  identification, doorstep photographs, and historic signature images. Under a
  Business Associate Agreement, because these carry patient information.
- **Email and SMS.** Notifications to staff, and delivery notices to patients
  where the healthcare organisation has asked for them.
- **Maps and geocoding.** Used for **facility addresses only.** The system
  refuses to send a patient address to a geocoding provider, in code rather
  than by policy.

We do not sell personal information. We do not share it for advertising. We
disclose it otherwise only where the law requires it.

---

## How long it is kept

- **Courier location traces: 7 days**, then deleted automatically. A trail of
  an identified employee has almost no operational value the day after a
  shift, so it is not kept longer.
- **Replies held for a phone that is retrying a request: 7 days**, then
  deleted automatically.
- **Audit records: kept indefinitely.** These record who did what and never
  contain patient information.
- **Delivery records, photographs of signed forms and of patient
  identification, doorstep photographs, signatures and invoices:** kept for as
  long as our contracts with the healthcare organisations we deliver for, and
  the law governing controlled-substance and medical deliveries, require us to
  keep evidence of a handover, and then deleted.

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

TAG Courier is a tool for working couriers and healthcare staff. It is not
directed to children and we do not knowingly collect information from anyone
under 18.

---

## Changes

Material changes will be notified in the app before they take effect.

## Contact

Questions about this policy, or a request to see, correct or delete what we
hold about you:

```
Izy Global Services LLC
Houston, TX 77045
contracts@izyglobalservices.com
+1 (832) 715 8986
```
