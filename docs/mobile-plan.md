# The driver app: a courier network, not a dispatch screen

Decided 16 September 2026. Three choices were made against three alternatives,
and the alternatives are written down here too, because the reason a decision
was taken is the thing that is worth having in six months.

| | Chosen | Instead of |
|---|---|---|
| Platform | React Native (Expo), driver app only | A PWA with no background tracking, or two native codebases |
| Assignment | Drivers request, dispatch approves, unclaimed work auto-assigns | Pure pull, or keeping push only |
| Sequencing | Go live on the web system, drivers cut over in phase two | Holding the contract start date for an App Store review |

---

## What is actually changing

Almost none of the server. Orders, runs, the custody chain, pricing,
invoicing, imports, zones, the SLA clock, discrepancies and the audit trail
are the contract expressed as code, and they do not care what is drawing the
screen. That is roughly 1,020 server tests that carry over untouched.

What is new is a **courier network**: people who apply, are vetted, are
trained, come on shift, choose work, are tracked while they carry it, and go
off shift. None of that exists today, because today there are two couriers and
a dispatcher who knows both of them.

```
                     EXISTS                        NEW
  Pharmacy staff     web portal                    unchanged
  Dispatch           web board, import, invoices   approval queue, live map
  Drivers            web PWA, run screen           React Native app,
                                                   onboarding, requests,
                                                   shift tracking
```

**Dispatch stays on the web, deliberately.** A dispatcher works a board with
filters, drag-to-assign, an approval queue and a map across a wide screen.
That job gets worse on a phone. Pharmacy staff stay on the web for the same
reason and because they already asked to.

---

## The three things that make this harder than it looks

### 1. There is no surge pricing, so a pull model does not clear

Uber's request-and-accept model works because when nobody wants a ride, the
price rises until somebody does. **Our rates are fixed by the BAFO schedule.**
There is no lever.

So the stops nobody claims are predictable: zone 5 out to Boerne, anything
flagged out of area, the three-item cold pack with a visible dry-run risk. And
Izy is contractually answerable for **85% completion** and **two-hour STATs**
whatever drivers felt like claiming.

Hence the hybrid. A request is an expression of interest, not an assignment.
Dispatch approves. Anything still unclaimed at a deadline auto-assigns to an
on-shift courier, and dispatch can always override. The driver experience is
the one that was asked for; the accountability does not move.

**An unclaimed STAT must never be nobody's problem.** That is the single
sentence this whole design has to keep true.

### 2. Twenty self-onboarding drivers is a compliance problem before it is a feature

Everyone who sees a patient's address is Izy's workforce under the BAA. Each
one needs HIPAA training, a signed confidentiality agreement, and almost
certainly a background check, because this is controlled substances and
University Health will ask.

So signup is an **application**, never an approval. The app collects it; a
human grants it. Until onboarding is complete and verified, the account exists
and can see nothing: no board, no addresses, no names. That gate is a server
rule, not a screen that declines to draw.

**The DoorDash shape, decided 16 September.** An applicant creates their own
password at signup and can sign in immediately, exactly as a Dasher can. The
security property is therefore **no membership, no data** rather than "no
account", which this codebase already enforced everywhere: every
project-scoped route goes through `requireProject`, and somebody who belongs
to no project is refused all of them. The cost is real and is stated rather
than hidden: there are credentialed accounts for unvetted people, so signup is
throttled, a rejection disables the account, and the access matrix carries an
`applicant` principal so that every row in it also answers "can a stranger who
filled in a form reach this".

This also raises worker classification, which is a question for an attorney
and not for this document. It is flagged because self-signup plus
choose-your-own-work is the fact pattern that raises it.

### 3. Continuous tracking is a new class of data

Today the code is careful here, and the comment in `modules/uh/board.ts` says
why: a position is **a fact about a moment, not about now**, captured at a
custody event and always shown with its age.

A continuous track is different in kind. It is a movement history of an
identified employee which, joined to orders, says which patients' homes were
visited and when. It needs:

- **A retention limit.** Days, not years. The custody event keeps the point
  that matters for proof of delivery; the breadcrumb trail between stops does
  not need to outlive the shift by much.
- **An access rule.** Dispatch sees an on-shift courier. Nobody browses last
  month's movements without a reason and an audit row.
- **A hard shift boundary.** Tracking starts when a courier goes on shift and
  stops when they go off. Tracking somebody off-shift is its own legal
  problem, and the app has to say plainly when it is on.

---

## Phase 6: the courier network (server first)

Built in this order on purpose. Every ticket below is server-side and
finishable before a line of React Native exists, because go-live is on the web
and the API is what both front ends consume. The web app gets these features
first; the phone app is a second client of the same endpoints.

| # | Ticket | What it is |
|---|---|---|
| 6.1 | Driver applications | Public signup creates the account with the applicant's own password, plus an application with a status. The account can sign in and reach nothing. Rejections are recorded with a reason and disable the account. |
| 6.2 | Onboarding gates | Training, confidentiality agreement, background check and licence each a recorded artifact with who verified it and when. **No membership is granted, and no address is readable, until every gate is green.** |
| 6.3 | Shifts | On shift and off shift as explicit events. Everything else in this phase hangs off them: who may be auto-assigned, who is tracked, who appears as available. |
| 6.4 | Delivery requests | A courier requests one or more stops. Dispatch approves or denies with a reason. Approval is what creates the assignment, so it goes through the existing custody transition and nothing new can put work in a van without a recorded event. |
| 6.5 | The unclaimed deadline | Per service type. A STAT unclaimed for N minutes auto-assigns to the nearest on-shift courier and tells dispatch it happened. This is the ticket that keeps 6.4 from costing us the contract. |
| 6.6 | Shift tracking | Position ingest while on shift, retention limit, access rule, audit on any read that is not the live board. |
| 6.7 | The live board | Dispatch sees on-shift couriers moving, with the age of each fix. Replaces "last seen at a custody event" for couriers who are on shift, and keeps it for those who are not. |
| 6.8 | Push | Approvals, denials, auto-assignments and new work. Needed by the app, useful on the web first. |

## Phase 7: the app itself

| # | Ticket | What it is |
|---|---|---|
| 7.1 | Expo shell | One codebase, both stores. Sign in, project pick, the run screen. |
| 7.2 | Signup and onboarding | 6.1 and 6.2 through the phone, including document capture. |
| 7.3 | The board, in hand | Browse available work, request it, see the decision. |
| 7.4 | Background location | The reason this is native at all. Shift-scoped, with a visible indicator. |
| 7.5 | Offline parity | The web app already queues events offline and the phone must not be worse. |
| 7.6 | Store submission | **Apple rejects background location routinely on first submission.** Budget a rejection and a resubmission, and write the justification before building the feature, not after. |

---

## What this does not change

The refusals. They are the reason the system is worth anything:

- Sequencing by distance still refuses without coordinates rather than guessing.
- A doorstep delivery still refuses without a photo rather than recording an unwitnessed drop.
- An invoice still refuses a period that is not over.
- A courier still cannot read an order that is not theirs, and it is a 403 on
  the server rather than a screen that declines to draw.

A driver choosing their own work changes who picks the stop. It does not
change what the system will and will not claim happened.
