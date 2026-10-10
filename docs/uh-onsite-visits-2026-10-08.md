# The onsite visits, 8 October 2026

What each University Health pharmacy said when we walked their counter,
three weeks before go-live. Taken from the recordings of the day
(eleven voice notes, transcribed) plus one earlier TVHS call of 24 September
that is not about this contract.

This document exists because the recordings are not in the repository and
most of what follows is not written anywhere else. Where a row here drove a
code change, the commit is named.

> **These are operational facts, not a contract.** Where a time or a volume
> here disagrees with the signed performance work statement, the contract
> wins and this file is wrong. Several numbers were given as "about" by
> somebody standing in a dispensary.

---

## The rules every counter gave, in the same words

### Who may sign

| Rule | When | What the courier must do |
|---|---|---|
| **The patient, nobody else** | Medicare | Form says *Medicare signature required*. Not a caregiver, not a spouse, unless separately named. |
| **Anybody 18 or over** | IV protocol | "They have to be 18 or older to sign for the, if it's IV protocol." |
| **Anybody at the address** | Everything else | Still a signature. "We don't just drop it off at the door and leave it. We don't do Amazon." |

A **named caregiver** can be nominated in advance: the patient telephones the
pharmacy, the pharmacy highlights the name on the form, that person signs
*with ID*.

**Anybody not named does not get the package.** This was emphatic and
unprompted at more than one counter:

> "So if the secondary party is not home to sign and we call the patient and
> the patient is like, hey, just give it to my neighbor. That is not
> acceptable. ... Because we're still liable for everything inside that
> package."

→ `signature_rule`, `authorised_signers` (drizzle/0051).

### Identification

A stamp on the form. Controlled substances always need it, and the
controlled ones are stamped on the address too.

The convention the pharmacies rely on, and expect to continue:

> "They take a picture of the ID on the paper that they're signing. So if
> they don't come back and say, well, I didn't get my tramadol — I'm like,
> yes, you did, because you signed. ... That is our proof that they did."

This is the pharmacy's evidence in a dispute, not ours. `patient_id` photo
capture already exists alongside the signed `courier_form`
(`modules/uh/pod-photos.ts`).

→ `id_required` was parsed and silently never stored until `0cedc55`.

### Packages

One patient's prescription can be several boxes, labelled **1 of 3**, **2 of
3**, **3 of 3**, usually with one of them refrigerated and arriving in a
white box. **The paperwork is attached to exactly one box**; the others have
only labels.

> "You always want to match up the packages if it's a one of two or a one of
> three. So that would be on the driver to make sure that they are giving the
> patient the correct information."

→ feeds `packages.quantity`, which the pickup screen already counts against.

### Cold chain

Labelled on the box. Ice bricks are already inside; packouts are good for
**32 hours** (Discharge) or **36 hours or less** elsewhere. Couriers are
expected to carry a medical cooler and **must not unpack**.

There is a live complaint about the incumbent here:

> "There was complaints before about packages getting to patients that are
> maybe later in that delivery route that were warm."

→ `refrigerated` (drizzle/0051).

### Where it may be left

Delivered to the address on the package. **No hotels, no workplaces, no
businesses.** Apartments are sometimes left at the front desk, the office, or
in lockers. Gate codes arrive in the highlighted special instructions.

### Refusing an address

The **pharmacy** decides, not us, and they will back a driver who refuses:

- Repeated failed deliveries → the pharmacy may suspend a patient from the
  delivery service, sometimes for 30 days. Extenuating circumstances (the
  patient was in hospital) are excused.
- Dogs, aggressive patients, an address the driver judges unsafe → "if y'all
  say we don't want to deliver to this address anymore, we accommodate that."

→ **Not yet modelled.** There is no suspended-address concept.

---

## Per pharmacy

Volumes are **addresses per day** unless noted. One package is normally one
address is one patient.

| Pharmacy | Pickup | Delivery window | Volume | Closes | Returns |
|---|---|---|---|---|---|
| Discharge | 11:00 and 13:00 | — | — | doors 20:00, staff later | **Wants them back, same day**, called in |
| Robert B. Green (RBG) | — | — | — | **20:00** | Takes other sites' returns after hours |
| *78207 site* | 11:00 | — | 100–150 combined | 18:00 | To RBG; RBG returns them next morning |
| *site visited 14:33* | — | — | avg 70, max ~120, low 52 | 18:00, gates 18:30 | **18:15 cutoff**, then RBG (8 min away) |
| *site visited 15:49* | one pickup | 12:00–18:00 | 70–90, good day 100–130 | 17:00 | Same day if possible, else any open location |

The recordings do not always name the pharmacy, so three rows above are
identified by the time of the recording. **Confirm which counter each is
before relying on a cutoff time.**

### Common to all

- **List cutoff 10:00**, list sent **by noon at the latest**.
- **Monday to Friday only.** No weekends.
- The list is **locked once collected**. Additions happen before pickup, never
  after; there is no second delivery wave.
- Pharmacies want to tell us when they will be late ("we'll be 45 minutes
  behind") and expect flexibility. The incumbent was good at this and it is
  named as a reason they liked them.
- One **site lead collects everything** and distributes to drivers. Drivers
  bring their own wagons, park in visitor parking, and sign in. One counter
  allows **only two people inside at a time**.
- The pharmacy keeps a **signed copy at pickup** — the driver signs for each
  one on collection. Three forms per package: patient, pharmacy, driver.

---

## BC3 — not a pharmacy

BC3 is a **drop-off point**, fed only from **Discharge and Pavilion**. We
never collect prescriptions from it.

- About **300 people in each** of the business centres; three buildings.
- Volume **~16 a day**, under 20, growing from 3–4.
- Meds reach the sites by **17:00 the day before**; BC3's own cutoff is
  **17:00 the day before**.
- Window **12:00–13:00**, ideally a little earlier.
- **The courier telephones the employees** to say their medication has
  arrived and is ready to collect. The incumbent does this from about 12:00.
- Uncollected by 13:00 (sometimes held longer) → **returned to the
  originating site**.
- **A locker system arrives mid-November.** After that we hand 20–30 packages
  to a named member of staff who loads the lockers; we do not load them. For
  the first two weeks from 1 November it stays a hand-to-each-person
  delivery.
- Address: 6200 North West Parkway.

---

## The incumbent, Quick Courier

Two of their documents are on file.

**The delivery ticket** is a multi-part carbonless form: pre-printed ticket
number, date, pickup and delivery time, driver name and number, shipper and
recipient blocks, service level (Quickie / 1 / 2 / 4 hour / round trip),
**# of pieces**, description, weight, special instructions, C.O.D., and two
signature lines — *Received in good order* and *Return*. The charges table
bills **`1604` as its own line**, alongside after-hours and round trip.

**The zone map** is Bexar County with Loop 1604 drawn on it. Inside is
standard; outside, about 25 ZIP codes carry a surcharge from **$17 to $40**
(78108 is the dearest at $40; 78223 and 78214 the cheapest at $17). It
carries a promise in print:

> "Our team will advise you immediately of all outlying territory locations
> that create additional charges, for your approval or removal from the
> delivery list. **We will never proceed without pharmacy approval, on any
> location that would create an unusual service charge.**"

We have out-of-area authorisation (drizzle/0045). That sentence is the
standard we will be held to.

One counter noted they already deliver outside 1604 to a few patients south
of the city and **expect that to continue**.

---

## What they complained about, which is the contract to win

Returns. Not software — operations — and it came up at nearly every counter.

Returned packages are left "across the street" rather than brought back, the
pharmacy is not told, and they do not arrive for **a day or two**, including
refrigerated ones:

> "Sometimes they're ice. There's refrigerated ice. They're not even checking
> them 24 hours. ... They don't even call to say, hey."
>
> "Monday ... we had 10 of them. ... They left them over there. Nobody told
> us. And we're calling because the patient's like, where's my package?"

What they want instead: the package back at **their** counter the same day,
or at RBG after hours, **with a telephone call**, so they can ring the
patient and re-deliver.

---

## Open questions, not ours to answer

1. **One spreadsheet row per patient, or one per box?** If a pharmacy sends
   "1 of 3", "2 of 3", "3 of 3" as three rows for one patient, the duplicate
   check will flag them. Nobody was asked.
2. **Which counter is which** for the three cutoff times above.
3. **Does the list move to the portal, or stay email?** Every pharmacy emails
   it today. Portal upload is built and switched off.
4. **The ID photograph.** Photographing a government ID is the convention
   they rely on, and it is a significant PHI decision that should be written
   into the BAA position rather than inherited from the incumbent by default.
5. Suspended addresses: who records a ban, and does it expire by itself?
