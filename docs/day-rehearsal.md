# Rehearsing a day on the pharmacy courier

A whole service day, four people, on a throwaway database. Import a
pharmacy's list, dispatch it, deliver it, fail one, take it back, review it,
bill it, and read it back as the client.

Ninety minutes the first time. Under thirty once you have done it.

**Why bother.** Every screen has tests behind it and they pass. What tests do
not tell you is whether the day *holds together*: whether the courier's stop
screen says the same time as the proof of delivery the pharmacy downloads,
whether a dispatcher can act on a refusal, whether the invoice adds up to what
the board showed. Three of the four defects found in September came out of
this, not out of the suite, and none of them was a wrong answer. They were the
application telling somebody something they could not act on.

**No real data.** Every name and address below is invented, and that is not a
formality: the working agreement says no University Health data, real or
sampled, enters any environment until the BAAs are filed. See
`docs/infra/accounts-and-baas.md`.

---

## 0. A database of your own

Never rehearse against anything you would mind losing.

**Do not put any of this in `server/.env`.** You probably already have one
with your real local configuration in it, and a rehearsal that overwrites it
and then deletes it in the teardown step has cost you something. Everything
below is set on the command line instead, which also means it is visible in
the command you ran when you come back to it tomorrow.

```bash
mkdir -p server/rehearsal
```

```bash
npm run build -w web
```

The server serves `web/dist`, so a stale build is a stale rehearsal.

Now start it. This is one long line on purpose: the variables belong to this
run and nothing else.

```bash
cd server && NODE_ENV=development PORT=3100 DB_FILE=rehearsal/day.db SESSION_SECRET=rehearsal-secret-not-a-real-one ADMIN_USER=rehearsal ADMIN_PASS=rehearsal-pass-0001 npx tsx src/index.ts
```

Two things in there earn their place:

- **`DB_FILE` is resolved relative to `server/`.** An absolute path is
  appended to the server directory rather than replacing it, and you get a
  `ConnectionFailed` naming a path made of two paths glued together. Use
  `TURSO_DATABASE_URL=file:/absolute/path` if you want an absolute one.
- **`NODE_ENV=development`** is a safety catch. If your `server/.env` has
  `TURSO_DATABASE_URL` set, the server refuses to start rather than quietly
  rehearsing against a real database, and says so.

Read the first log line before going further. It should say
`database=file:...rehearsal/day.db`. Then, in a second terminal:

```bash
curl -s http://127.0.0.1:3100/health
```

> **Do not run `npm run ci` while this is up.** The suite starts servers of its
> own, and with the rehearsal server and a browser also running, the machine
> loses. A full run during this walkthrough failed nine access-matrix cases
> with timeouts and 401s and passed cleanly the moment the rehearsal server
> was stopped. A red suite that means "your laptop was busy" is worse than no
> suite.

---

## 1. The people

Four, because a day needs four and because most of what goes wrong lives
between them.

Open `http://127.0.0.1:3100/` and sign in as `rehearsal` /
`rehearsal-pass-0001`. Username and password is the whole of signing in for
staff: the two-factor step that lived here between tickets 4.3 and 5.10 was
removed.

Now, from **Users**, create these four. The form takes a username, a full
name, an optional email, a temporary password and a platform role, and that
is all it does: **it does not grant project access**. Give everyone the same
password so you are not hunting for one mid-rehearsal.

| Username | Name | Platform role | UH project role |
|---|---|---|---|
| `rehearsal2` | Second Admin | admin | admin |
| `dee.dispatch` | Dee Dispatch | staff | dispatcher |
| `ana.courier` | Ana Ruiz | driver | courier |
| `pat.pharmacy` | Pat Ortega | staff | client viewer |

Then open each one from the directory and grant a membership on **UH Pharmacy
Courier** with the project role from the last column. A user with no
membership can sign in and see nothing, which is its own useful thing to look
at once.

Two things worth doing properly:

- **Actually create `rehearsal2`.** Nobody can reset the last administrator,
  because there is nobody left to do it, so one admin is a forgotten password
  away from a database change. The go-live check fails until there are two, on
  purpose, and you want to see it stop failing.
- **Scope `pat.pharmacy` to one pharmacy** in their membership settings.
  Robert B. Green. The whole point of the client viewer is that they see their
  own pharmacy and nothing else, and an unscoped one proves nothing.

---

## 2. Midday: the list arrives

Sign out, sign in as `dee.dispatch`.

Save a file called `green-daily.csv`. The header must match what the pharmacy
sends, because matching it is half of what the importer does:

```
Rx #,Patient Name,Phone,Address 1,Apt/Unit,City,State,Zip Code,Qty,Medication,Delivery Type,Special Instructions,Signature
RX-77401,Marta Delgado,210-555-0142,331 W Cevallos St,,San Antonio,TX,78204,1,Oral solids,Scheduled,Leave with front desk if out,Yes
RX-77402,Owen Baptiste,210-555-0188,1015 N Flores St,Apt 3,San Antonio,TX,78212,2,Cold pack,Scheduled,,Yes
RX-77403,Rosa Villanueva,210-555-0155,210 Nolan St,,San Antonio,TX,78202,1,Oral solids,Scheduled,,No
```

On the project page, **Daily list import**: pharmacy `University Health Robert
B. Green Pharmacy`, choose the file, **Review the file**. The service date
already says today, in the project's timezone, so leave it.

**There are two screens after that, not one.**

First **Columns**, which says "Guessed from the header row. Check it before
importing." Every field is a dropdown onto a column of your file. With the
header above it guesses all thirteen correctly, so this is a read-and-continue
step, but it is the step that exists because pharmacies rename columns.
**Re-read with these columns** applies a change.

Then the preview: `3 of 3 rows will be imported`, `0 blocked, 0 duplicate, 0
out of area, 0 with warnings`, a zone and a due time per row. Read it rather
than clicking past it. Nothing exists until **Import 3 orders**.

**Worth trying once:** attach the same file again and review it. The preview
comes back with `This exact file was already imported as list 1`, `0 of 3
rows will be imported`, `3 duplicate`, and the button reads **Import 0
orders**. It is caught before anything is created, and it names the list it
was caught against. That is what stands between a pharmacy re-sending their
list and a patient getting two deliveries. **Cancel** out of it.

---

## 3. The wave

**Open the board.** Three orders, three unassigned, a due time on each.

1. Under **Start a run**, choose Ana Ruiz and start it.
2. Assign all three stops to her.
3. Click **Sequence by distance**. It refuses: the pharmacies have no
   coordinates, so there is no point to measure a route from. This is correct
   and will stay correct until address lookup is switched on.
4. Click **Sequence by deadline**. That works.

---

## 4. The round

Sign out. Sign in as `ana.courier` — and do it the courier's way: pick **UH
Pharmacy Courier**, then her name from the list, then her password. No
username typed at a pharmacy counter.

If her name is not on that list, she has no courier membership on the project.

She lands on a project picker with one project on it, which is a wasted tap at
a pharmacy counter and is on the record as such. Tap it, then **Today**. The first thing on it is **Collect first**: three stops are
still at the pharmacy and the app will not let her deliver what she has not
taken custody of.

**Pick up.** Count the packages: four, not three, because Owen's row is two
cold packs. Type the pharmacy staff member's printed name, sign the pad, take
custody.

> Try typing 3 first. The form answers immediately, without waiting for you
> to submit: **The list expects 4. Say why the count is different before you
> continue**, and a Reason field appears. A short handover nobody explained is
> an unexplained missing medication. Put it back to 4.

Then work the stops. Each one is **I have arrived** first, because arrival is
what the deadline is measured against, and it counts even when nobody answers.

- **Rosa Villanueva** — arrive, **Handed over**, printed name, signature.
- **Marta Delgado** — arrive, then look: **Left at the door** is not offered
  and the screen says why. Her row requires a signature. Hand over.
- **Owen Baptiste** — arrive, **Could not deliver**, reason *Could not find
  the recipient*. It becomes a dry run, billed per item.

Back on the run screen, **Take back undelivered**: hand Owen's two packs back
to the pharmacy against a second signature. The contract wants a signature on
every handover, not only at the door.

Finally, file a discrepancy from **Something not matching what you see?**.
Anything will do. A shadow week that finds nothing did not work.

> **No location was recorded** on the pickup and the return, because a desktop
> browser will not give one. On a phone it will. The app records the absence
> rather than inventing a position.

---

## 5. The evening

Back in as `rehearsal` or `dee.dispatch`.

**The board.** Two delivered, one failed, nothing overdue, and a feed naming
every event in order with who did it.

**Performance** (`/projects/uh/reports`). Completion 66.7 per cent, flagged as
below the 85 the contract requires. On-time 100 per cent, measured at arrival.
Read *What these numbers mean* once: it is where the inverted completion
formula in Scope 1.2.5 is written down as an open question.

**Discrepancies.** Resolve the one Ana filed: **Something was changed** opens
a field asking what was changed, and nothing closes without a sentence in it.
The summary above it then reads "Nothing is open. That is necessary and not
sufficient: somebody still has to decide," which is the panel refusing to look
like a sign-off.

**An order.** Open any delivery and read the chain of custody, then download
the proof of delivery. Both signatures, both times.

> **Check the times match.** The PDF prints America/Chicago. So does every
> screen. If your machine is in another zone and the two disagree, that is a
> bug and it is the one ticket 5.5 fixed; say so.

---

## 6. Billing, which is tomorrow's job

**Sign in as `rehearsal` or `rehearsal2` first.** Billing is an admin or ops
manager job; a dispatcher opening this screen gets `Requires project role:
admin or ops_manager` and no draft.

**Invoices**, open a draft. Try today's date first: it refuses with "That
period is not over yet. Bill up to yesterday at the latest," because a period
that is not over cannot be billed. That is the rule, not a limitation.

So the day you just worked cannot be invoiced until tomorrow. To see a priced
invoice now, do a second, shorter round dated yesterday and bill that: import
a list with yesterday's service date, run it, and open a draft from the first
of the month to yesterday.

What to check on the draft:

- Zone 1 deliveries at the contract rate.
- A dry run billed per item, plus the STAT surcharge if the order was STAT.
  **Whether that surcharge survives a dry run is an open question with
  University Health** (ticket 1.10). The app charges it. If they say otherwise,
  this is the line that changes.
- **No patient names anywhere.** Pharmacy reference only.

Then **Issue** it, and watch the totals freeze.

---

## 7. The client's view

Sign in as `pat.pharmacy`. This is what University Health sees.

- Robert B. Green only.
- Ana is "Ana". No surname.
- Patient names are not searchable, and the screen says why: a name typed into
  a search box ends up in browser history and server logs.
- **Proof** downloads the same PDF.
- No board, no invoices, no other pharmacy. Try a URL for one and you get a
  404, not a redirect.

---

## 8. What the checklist says

```bash
curl -s http://127.0.0.1:3100/api/projects/uh/uh/go-live
```

It never says ready. The most it says is that nothing automatic is in the way.
Expect it to fail on the deployment being a local file, and on the seven
attestations no program can check. If you skipped `rehearsal2`, expect
`admins.second` as well.

---

## A note on when you do this

Two things depend on the clock and neither is a fault.

**Rehearse in the evening and the numbers move.** Business hours are 08:00 to
20:00, so a list imported at 19:35 has deliveries due at 21:35, which is after
hours, and a delivery performed then carries the after-hours surcharge on the
invoice. The walkthrough this document was checked against ran at 19:35 and
saw exactly that.

**Staff sessions idle out after thirty minutes.** Leave the rehearsal half
done and come back, and you sign in again. That is the contract's setting, not
a bug, and watching it happen once is worth more than reading it here.

---

## 9. Put it away

Stop the server, and delete the database. Nothing else was touched: no
`server/.env`, no committed file, nothing outside `server/rehearsal/`, which is
gitignored.

```bash
npx kill-port 3100 && rm -rf server/rehearsal
```

---

## What to write down

Not "it worked". The useful output of a rehearsal is the list of moments you
had to stop and think, because each one is a moment somebody will have at a
pharmacy counter with a patient waiting. File them as discrepancies of kind
*The app itself*, or straight into `docs/build-backlog.md`.

**This document was written from two walkthroughs and then checked by doing it
a third time, start to finish, against a clean database.** That third pass
found six things, which is the honest advertisement for the exercise:

- `/users/pat.pharmacy` answered **404**. Every username here is first.last, and
  the shell's fallback skipped any path `path.extname()` called an extension,
  so every user detail page broke on a refresh or a pasted link. It had never
  shown up because clicking through from the directory never asks the server.
- The board said Ana Ruiz had **never signed in**, beside the run she had just
  finished. Signing out revokes the session, and the presence query skipped
  revoked ones. Never and not-any-more are different answers to a dispatcher
  deciding whether to ring somebody.
- Closing a discrepancy used **window.prompt**, which some browsers and most
  embedded webviews refuse outright. There the button threw and did nothing.
  It is a real field now.
- The discrepancy filed at 7:42 PM was dated **tomorrow**, the performance page
  opened on a range ending **tomorrow**, and the invoice issued at 8:05 PM was
  dated **tomorrow**. Three separate places still computing a date from
  `toISOString()`, which is UTC, five hours ahead of San Antonio in the
  evening. The last one prints on a document sent to University Health.
- Billing refuses a dispatcher, and this document did not say so.
- The import has a **column-mapping step** that this document walked straight
  past.

Four of those six are the application telling somebody something untrue. None
of them was caught by the test suite, because all of them are about what happens
when the pieces are used in order, by four different people, at eight in the
evening. The suite is 1,197 tests and it is not a rehearsal.
