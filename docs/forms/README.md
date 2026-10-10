# The paper forms

Two sheets, for the two handovers a package makes between a dispensary shelf and
a patient's door.

| | Between | Sheet |
|---|---|---|
| 1 | Pharmacy → site lead, once per pickup window | `collection-manifest.html` — pharmacy copy, site lead copy |
| 2 | Site lead → driver → patient, once per delivery | `courier-docket.html` — site lead, driver, patient |

**The pharmacy is not party to the second one.** Their record is the manifest plus
their own daily list, and the docket starts where the lead takes custody. That is
a change from how the incumbent works: today the pharmacy gets a copy of a form
per package, and one counter described it as *"one's for patient, one's for us,
and one's for driver"*. If they expect that on 1 November, the lead's part is the
one to hand over — it carries the same patient, Rx and handling.

**Signatures are taken once, in bulk, never per delivery.** The pharmacy signs the
manifest for the whole collection; the lead signs each driver out in the
manifest's driver table. Robert B. Green runs 241 deliveries inside an 11:00
window, and a signature per package there is a blur of initials or nothing at
all. The docket's first part records the join instead — which manifest it arrived
on and which driver took it — which is what traces one package from a counter to
a door.

Both are US Letter, blank, fillable, and `npm run make:docket -w server` builds
the PDFs from the HTML designs.

**They are printed blank and filled in by hand.** That is the decision as of
10 October 2026 and it is the right one for go-live: it needs no app on a
counter, no printer at a pharmacy, and nothing to go wrong at 11am on
1 November. What follows is how it would be automated later, written down now
while the reasoning is fresh.

---

## Why automating it is worth doing eventually

Every field on the docket except the signatures already exists in the database
before the courier arrives. A blank pad means a technician copies, by hand, data
the system could print — and every hand-copied field is a chance to write the
wrong gate code or miss a Medicare stamp.

The handwritten parts are the ones that **should** stay handwritten: a signature,
the time it happened, the ID that was seen, the reason it failed. Those are
captured at a door by a person, which is the whole point of the form.

## What is already in place

Nothing new has to be invented to generate it. The pieces exist:

| The docket needs | Where it already lives |
|---|---|
| Pharmacy, service date, zone | `orders` row, written at import |
| Patient, address, phone, Rx reference | `orders` row |
| Packages (the "3" in 1 of 3) | `packages.quantity`, summed per order |
| Refrigerated / Controlled / ID required / Medicare | `drizzle/0051`, on the `orders` row |
| "Alma Reyes must sign. Nobody else." | `signingInstruction()` in `modules/uh/handling.ts` |
| The chips: Fridge, Controlled, ID, Patient only | `handlingFlags()`, same module |
| Special instructions, gate code | `orders.delivery_notes` |
| PDF rendering, letterhead, page layout | `core/pdf/writer.ts`, used by `modules/uh/pod.ts` |

The wording matters more than it looks. `signingInstruction()` is what the courier
already sees on their phone and what the proof of delivery already prints. A
generated docket must use the same function, not its own phrasing, or the paper in
a courier's hand and the document the pharmacy reads afterwards will describe the
same delivery differently. That is the failure `handling.ts` exists to prevent, and
it is written up in its header.

## The shape it would take

A sibling of `modules/uh/pod.ts` — call it `docket.ts` — rendering the same three
parts through the existing PDF writer, plus a route:

```
GET /api/projects/:pid/uh/imports/:id/dockets.pdf   the whole day, one per page
GET /api/projects/:pid/uh/orders/:id/docket.pdf     one delivery
```

The day's version is the one that matters: a pharmacy confirms their list in the
portal, then prints one PDF and gets a stack of dockets already matching the
deliveries the courier is about to collect.

`courier-docket.html` stays as the layout's source of truth. It is easier to
iterate on a form in HTML than in the PDF writer's coordinate space, so the HTML
is the design and the PDF follows it.

## What would have to be decided first

1. **Who prints.** A pharmacy printing their own dockets needs a working printer at
   the counter on the morning of a wave. Izy printing them means they travel with
   the courier and are not available if the list changes after collection.
2. **A docket number.** Deliberately not printed on the blank pad, because the Rx
   reference ties the three parts together once they are cut apart. A generated
   docket could carry a real sequential number and a barcode or QR of the order id,
   which would let a scanned return be matched without typing anything.
3. **Whether the handling boxes stay tickable.** Printed ticked, they are accurate
   and nobody reads them. Printed empty against printed data, a technician has to
   look at each one, which is the check the counters described doing today. Worth
   asking a pharmacy rather than deciding from a desk.
4. **PHI on paper.** A pre-printed docket carries a patient's name and address on a
   sheet that leaves our premises. The blank pad does not until somebody writes on
   it. This needs to be in the privacy program's disposal section before it ships —
   see `docs/privacy-controls.md`.

## Where the content came from

The field list is Quick Courier's delivery ticket, the incumbent's form, which the
counters have been completing for years. The handling rules, the signature rules,
the returns cut-offs and the multi-box convention come from the onsite visits of
8 October 2026, written up in `docs/uh-onsite-visits-2026-10-08.md`.

What was deliberately dropped from the incumbent's ticket: weight, C.O.D.,
third-party billing, the service tiers (Quickie / 1 / 2 / 4 hour) and the charges
table, including its `1604` zone line. Izy bills per delivery against the zone
schedule, and a price list is commercial terms that no courier signed up to carry
to a patient's door.
