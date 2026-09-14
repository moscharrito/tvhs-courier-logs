# Dispatcher guide

For the person running the wave. Longer than the courier card because the job
is harder: you are the only one who sees the whole day.

Every screen name and button here is what the application actually says.

---

## The shape of the day

| When | What |
|---|---|
| Morning | Pharmacies send their lists. You import them. |
| Before the wave | Build runs: assign the pool to couriers. |
| Noon onward | Watch the board. Answer what goes wrong. |
| End of day | Returns confirmed, exceptions cleared, report read. |

---

## 1. Importing the daily list

**Daily list import**, from the project page.

1. **Pharmacy** — which site the list came from.
2. **Date** — the service date.
3. **File** — the spreadsheet or CSV they sent.

You get a **preview before anything is created**: Orders, Skipped, Problems,
and a **Columns** mapping.

**Read the preview.** It is the only cheap moment.

- **Problems** names the row and the column. A changed heading and a new
  pharmacy with no mapping yet are the two usual causes, and neither is an
  incident.
- **Skipped** is almost always a duplicate the pharmacy sent twice. That is
  the import doing its job.
- **Columns** shows what it thinks each column is. If a pharmacy renames a
  heading, fix the mapping here once and it is remembered.

The import refuses rather than guessing. A refused import is a five-minute
conversation with the pharmacy; a guessed one is a delivery to the wrong
address.

---

## 2. Building runs

**Dispatch board**. Two halves:

- **Unassigned** on the left, grouped by pharmacy, with a count.
- One **lane per courier** on the right.

To start: **Start a run**, then **Choose a courier**. If you see *"Every
courier on this project already has a run today"*, they all have one.

Put work on a run with **Assign to...** on an order. Move it between lanes the
same way. **Clear** takes it back to the pool.

**STAT** is flagged in red. Two hours from receipt, and also one hour from
pickup, so a STAT that sits at the pharmacy is already late even if you
dispatch it quickly.

### What to put where

Group by pharmacy first: a courier collecting at three counters spends the
morning driving between them. Then by zone. The app will sequence a run for
you within those limits.

---

## 3. Watching the wave

The board refreshes every 15 seconds. **Refresh** forces it.

**What just happened** is the live feed, newest first. It shows the courier's
own words on a failure, not the reason code, because the words are what you
need to act on.

### What you will actually see, and what to do

| What | Meaning | Do |
|---|---|---|
| An overdue stop | Past its window | Call the courier. Decide whether to move it. |
| *"That order is not assigned to you"* from a courier | You moved it while they were driving | Expected. Tell them to refresh. |
| A courier's stops stop updating | Their phone is queueing | Nothing, if they are in a basement. They will send when they surface. |
| **Not delivered** with a reason | A dry run | Check the reason. Wrong address means calling the pharmacy today, not tomorrow. |
| A courier says the app refused something | Read the message they read | The refusals are deliberate. The app is usually right. |

### Moving work mid-wave

You may. It is designed for. The courier who had it gets a clear refusal on
their next tap, and the courier who gets it has to collect it before they can
deliver it. If it is already picked up, moving it means a physical handover;
the system will not pretend otherwise.

---

## 4. Exceptions

**A failed delivery is not the end of the order.** It has to come back.

The courier records the failure with a reason per package and takes it back to
a pharmacy the same day. Your job is the part the app cannot do:

- **Address is wrong** — tell the pharmacy today. They have the patient's
  record; you do not.
- **Could not find the recipient** — worth a call before it is redelivered
  tomorrow at the same time to the same empty house.
- **Recipient refused it** — the pharmacy needs to know immediately.

**Do not "fix" a failure by recording a delivery.** The custody record is
append-only and an invented delivery is a false record in a regulated chain.
If something was genuinely delivered and recorded wrong, say so, in writing,
and it is corrected as a correction.

---

## 5. Orders by hand

**Search orders** finds anything. **Take an order** creates a STAT or ad hoc
order for a phone call: the ones that do not come in on a list.

Scheduled deliveries only ever arrive by import, so that the duplicate check
works. If a pharmacy telephones a scheduled delivery in, it belongs on their
list.

---

## 6. End of day

- Every courier has confirmed their returns. Nothing undelivered is still in a
  van overnight.
- Every failure has a reason and, where it needs one, a note.
- **Performance** shows Delivered, On time, Completion, Attempted, and the
  definition of each measure beside it. **Export to Excel** for anything that
  leaves the building.

Read the definitions once. Completion and on-time are different numbers, and
the contract's own formula for completion is ambiguous enough that the report
shows both readings rather than picking one.

---

## What you cannot do, and why

| | |
|---|---|
| Set a status directly | There is no such button anywhere. Every status change is an event with an actor and a time. A status you can edit is a status that drifts from the record meant to explain it. |
| Delete a delivery | Records are append-only. A mistake is corrected with a correction, which is visible. |
| See another project's work | Memberships are per project. |
| Read the price schedule as a dispatcher | You can. A client viewer cannot. |

---

## When something is wrong with the system

1. `/health` in a browser. If it does not say `ok`, it is the system, not you.
2. Tell whoever is on call (`docs/runbook.md` has the list, once it is filled in).
3. **Deliveries do not stop because a system does.** Fall back to telephone
   dispatch and paper. Scope 1.2.8 still wants a signature per delivery: take
   it on paper and enter it afterwards, marked for what it is.

The known failure modes, with what each looks like from outside, are in
`docs/runbook.md`. The most common is not a fault: everything is slow for the
first minute of the wave while every courier opens the app at once.
