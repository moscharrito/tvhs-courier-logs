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

---

## 1. The people

Four, because a day needs four and because most of what goes wrong lives
between them.

Open `http://127.0.0.1:3100/` and sign in as `rehearsal` /
`rehearsal-pass-0001`. Username and password is the whole of signing in for
staff: the two-factor step that lived here between tickets 4.3 and 5.10 was
removed.

Now, from **Users**, create these and grant each a membership on the UH
project. Give everyone the same password so you are not hunting for one
mid-rehearsal.

| Username | Name | Platform role | UH project role |
|---|---|---|---|
| `rehearsal2` | Second Admin | admin | admin |
| `dee.dispatch` | Dee Dispatch | staff | dispatcher |
| `ana.courier` | Ana Ruiz | driver | courier |
| `pat.pharmacy` | Pat Ortega | staff | client viewer |

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
B. Green Pharmacy`, today's date, choose the file, **Review the file**.

Read the preview rather than clicking past it. It tells you the zone each row
priced into, which rows would be skipped as duplicates, and which are blocked
and why. Nothing exists yet. Then confirm.

**Worth trying once:** import the same file twice. The second one is refused
with every row named as a duplicate. That refusal is the thing standing
between a pharmacy re-sending their list and a patient getting two deliveries.

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

Open the run. The first thing on it is **Collect first**: three stops are
still at the pharmacy and the app will not let her deliver what she has not
taken custody of.

**Pick up.** Count the packages: four, not three, because Owen's row is two
cold packs. Type the pharmacy staff member's printed name, sign the pad, take
custody.

> Try typing the wrong count with no note. It is refused. A short handover
> nobody explained is an unexplained missing medication.

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

**Discrepancies.** Resolve the one Ana filed. Nothing closes without a
sentence saying what changed, or why nothing needed to.

**An order.** Open any delivery and read the chain of custody, then download
the proof of delivery. Both signatures, both times.

> **Check the times match.** The PDF prints America/Chicago. So does every
> screen. If your machine is in another zone and the two disagree, that is a
> bug and it is the one ticket 5.5 fixed; say so.

---

## 6. Billing, which is tomorrow's job

**Invoices**, open a draft. Try today's date first: it refuses, because a
period that is not over cannot be billed. That is the rule, not a limitation.

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

The four found in September were all of that shape: a courier told there was
no dispatch number by the one person who could not set one, a dispatcher told
to `POST /uh/geocode/sites`, a page advertising features that shipped two
phases earlier, and a devices screen that left a dead page behind after doing
exactly what it said it would.
