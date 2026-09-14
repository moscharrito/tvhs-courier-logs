# The shadow week

Ticket 5.2. Five days with the system running beside the manual process, on
real lists, with real couriers, before anything is retired.

## It cannot start yet, and this is what it is waiting for

**Nothing in this plan can begin until ticket 0.10 is done.** The working
agreement in the backlog says no University Health data, real or sample with
real names, enters any environment until the BAAs are filed. A shadow week is
by definition real lists and real patients, so the blockers are the same ones
as everywhere else:

| | |
|---|---|
| BAAs with Render and Turso | Not signed |
| A production environment on a paid plan | Does not exist |
| An administrator with a second factor, and a second one | Not created |
| The restore procedure run once by somebody who did not write it | Not done |
| The on-call list in `docs/runbook.md` | Empty |

What **is** ready: the log the week produces, which is the rest of this
document, and the go-live question it has to answer.

## The bargain

The manual process stays in charge for the whole week. Every delivery is
recorded in it as it is today. The system runs alongside, and **is not trusted
for anything that leaves the building**: no invoice is issued from it, and no
SLA report goes to University Health from it. If the two disagree, the manual
process is right for operational purposes and the disagreement is a
discrepancy.

The point of the week is to produce disagreements, not to avoid them. A week
with none means nobody was looking.

## Who does what

| | Each day |
|---|---|
| **Dispatcher** | Imports the real list into the system in the morning, having sent it to the manual process first. Builds runs in both. Watches the board during the wave. Files a discrepancy the moment the two disagree. |
| **Couriers** | Do the round as they do today, and **also** record it in the app. Yes, twice. That is the cost of the week, and it is the only way to compare. File a discrepancy when the app says something they know to be wrong. |
| **Ops manager** | Reviews the log at the end of each day. Resolves or accepts every open item before the next morning. |
| **Whoever maintains the system** | Fixes what needs fixing that day. A defect found on Monday and fixed on Friday has not been tested. |

## What counts as a discrepancy

Anything where the system and reality disagree. When in doubt, file it: a
duplicate costs a minute and a missed one costs the go-live decision.

| Kind | Examples |
|---|---|
| `import` | A row the pharmacy sent that did not become an order, or became the wrong one. A duplicate the import skipped that was not a duplicate. |
| `assignment` | The board says one courier has it; another one does. |
| `delivery` | The app records delivered and it was not, or the reverse. A signature against the wrong name. A dry run with the wrong reason. |
| `timing` | An arrival time that does not match, or an SLA answer that disagrees with the manual count. |
| `billing` | What the system would charge against what the manual process charged. **Do not issue anything from the system this week**; compare the numbers on paper. |
| `system` | It was slow, it refused something it should have allowed, it allowed something it should have refused, a screen was confusing at the door. |

### Severity, which decides whether Friday is a yes

| | Means | Effect |
|---|---|---|
| **critical** | A delivery record is wrong or missing. | Blocks go-live on its own, however small it looks. |
| **major** | Wrong, and caught and correctable within the day. | Must be resolved or accepted before Friday. |
| **minor** | Awkward, slow, or confusing. Nothing was recorded wrongly. | Must be written down. May be accepted rather than fixed. |

A `critical` is about the record, not about the inconvenience. A courier
waiting ninety seconds for a screen is `minor`. A delivery that happened and is
not in the system is `critical` even if nobody was harmed, because the record
is the product.

## Filing one

In the app, on the project, **Discrepancies**. Or:

```
POST /api/projects/uh/uh/discrepancies
{
  "serviceDate": "2026-11-24",
  "kind": "delivery",
  "severity": "critical",
  "orderId": 4182,
  "expected": "The board showed it as still on the way at 14:30.",
  "actual": "The pharmacy had it back by 13:45 and had signed for it."
}
```

Couriers can file. Dispatchers, ops managers and administrators can file and
close.

**Point at a delivery with `orderId`, never by typing a patient's name.** The
two text fields are treated as protected health information because somebody
will type one anyway, so they are kept out of logs and out of the audit trail,
but the right way to identify a delivery is its id.

## Closing one

```
PATCH /api/projects/uh/uh/discrepancies/4
{ "status": "resolved", "resolution": "The return was recorded an hour late. Shown the courier where the button is." }
```

Two ways to close, and the difference matters on Friday:

- **resolved**: something was changed. The code, the data, the process, or what
  somebody was taught.
- **accepted**: nothing needs changing, and here is why. Often the old process
  was the one that was wrong.

Neither can be closed without a sentence. "Fixed" on its own is the shape of a
week that looked fine and taught nobody anything.

## Each evening

1. `GET /api/projects/uh/uh/discrepancies?status=open` and work through it.
2. Anything `critical` gets dealt with tonight, not tomorrow.
3. Compare the day's numbers: deliveries recorded in the system against the
   manual count, and on-time against the manual count. A difference that is not
   already a discrepancy is a discrepancy nobody noticed, which is worse.
4. Tell the couriers what was found. The week only works if the people filing
   see that filing changes something.

## Friday: the go-live question

```
GET /api/projects/uh/uh/discrepancies/summary
```

It answers in numbers, per day and in total, and it deliberately does not
recommend anything:

- **Any `critical` still open: not ready.** No judgement required.
- **Anything at all still open: not ready**, because the rule is that every
  discrepancy is resolved or accepted, and an open item is neither.
- **Nothing open: necessary and not sufficient.** A clean board is not a
  decision. A person decides, and these are the questions worth asking first:
  - Did the week actually stress the system, or was it quiet? A holiday week
    proves nothing.
  - Did the couriers file anything at all? Silence from the people at the door
    means the reporting path did not work, not that nothing went wrong.
  - Was every `critical` a one-off, or the same shape three times?
  - Did the numbers agree on the last day better than on the first?

If the answer is no, the week extends. That is cheaper than the alternative,
and it is a decision the contract can absorb; a wrong delivery record is not.

## What this week is not

It is not a load test. That is ticket 4.1 and it has been done, on a laptop,
which is not the same as production.

It is not a security review. That is ticket 4.2.

It is not the restore drill. That is ticket 4.4, and **the half of it that
involves a real snapshot has still never been run**. Doing it for the first
time during a live contract would be a poor plan.
