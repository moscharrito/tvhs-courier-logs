# Control inventory

Ticket 4.7. What the application and its hosting actually do, mapped onto the
headings a privacy and security program uses, with the file that implements
each control and the test that proves it.

## The ticket cannot be completed as written, and this is the half that can

Ticket 4.7 asks to "confirm every control named in the written privacy and
security program exists in the app and hosting". **There is no written privacy
and security program yet.** It is on the contract action list alongside the
Workers' Comp certificate and the clarification email to University Health,
and no amount of engineering produces it.

So this document is the inverse, and it is the useful half: an inventory of
what exists, organised so that when the program is written it can be checked
against reality in a single pass rather than a fortnight of archaeology. The
gaps are listed too, because a program that names a control we do not have is
worse than no program, and the gaps are visible now rather than during an
audit.

**This is an engineering inventory and not a legal assessment.** It says what
the software does. Which safeguards are required of Izy Global Services as a
business associate, and whether these satisfy them, is for counsel. The
section headings borrow from the HIPAA Security Rule because that is the
framework the program will use, not because this document interprets it.

## How to use it

When the program is written, for each control it names:

1. Find the row here. If there is no row, the program names something that
   does not exist: either build it or take it out of the program.
2. Read the evidence column. Every file path and test name in this document is
   checked by `server/test/privacy-controls.test.mjs`, which fails if a cited
   file stops existing, so this document cannot quietly rot into fiction.
3. Check the numbers. The ones a program is likely to quote are asserted
   against the code by the same test, so a session timeout cannot be changed
   in one place and stay true in the other.

---

## Technical safeguards

### Access control

| Control | Where | Proof |
|---|---|---|
| Unique user identification. No shared accounts; every actor is a named user with their own password. | `server/src/core/users/routes.ts` | `server/test/users.test.mjs` |
| Role-based access, per project. Five project roles plus a platform administrator, each endpoint gated. | `server/src/core/projects/middleware.ts` | `server/test/access-matrix.test.mjs` |
| Every endpoint's access is written down and tested, including who is refused. | `server/test/access-matrix.test.mjs` | 119 cases, with a coverage guard that fails when an endpoint is added without a row |
| Minimum necessary: a courier sees only their own assigned work. | `server/src/modules/uh/orders.ts`, `runs.ts` | `server/test/uh-orders.test.mjs` |
| Minimum necessary: a pharmacy contact sees only their own sites, and an unscoped one sees nothing. | `server/src/modules/uh/client-portal.ts` | `server/test/uh-client-portal.test.mjs` |
| Automatic logoff. Staff: 30 minutes idle, 12 hours absolute. Couriers: 12 hours idle, 30 days absolute. | `server/src/core/auth/sessions.ts` | `server/test/sessions.test.mjs` |
| Sessions are server-side and revocable; the cookie holds only a random token and the row is keyed by its SHA-256. | `server/src/core/auth/sessions.ts` | `server/test/sessions.test.mjs` |
| A disabled account loses every session on its next request, not on a sweep. | `server/src/core/auth/sessions.ts` | `server/test/sessions.test.mjs` |

**Emergency access procedure.** Partial, and the weakest control here. An
administrator can reset another person's second factor and revoke their
sessions. If the last administrator loses both their phone and their recovery
codes there is no route in through the application, and the way back is a
documented database change that leaves no audit row. See `docs/runbook.md`.
The mitigation is organisational: a second enrolled administrator, with
recovery codes stored separately. **Nobody has done that yet.**

### Audit controls

| Control | Where | Proof |
|---|---|---|
| Every write and every read of one person's data records who, what, when and from where. | `server/src/core/audit/audit.ts` | `server/test/audit.test.mjs` |
| The audit trail is append-only in the database, enforced by triggers rather than by convention. | `server/drizzle/0004_audit.sql` | `server/test/audit.test.mjs` |
| A failed audit write fails the request. A request never completes unrecorded. | `server/src/core/audit/audit.ts` | `server/test/audit.test.mjs` |
| Audit detail carries ids, counts, field names and outcomes. Never PHI, never secrets, never free text from a request body. | `server/src/core/audit/audit.ts` | `server/test/audit.test.mjs` |
| Reading the audit log is itself audited. | `server/src/core/audit/routes.ts` | `server/test/audit.test.mjs` |
| Authentication events: sign-in, failure, lockout, second-factor challenge, enrolment, reset. | `server/server.js`, `server/src/core/auth/mfa.ts` | `server/test/auth-throttle.test.mjs`, `server/test/mfa.test.mjs` |
| Retention sweeps and purges are recorded, with the request written before the delete. | `server/src/core/retention/routes.ts` | `server/test/retention.test.mjs` |

### Integrity

| Control | Where | Proof |
|---|---|---|
| The chain of custody is append-only in the database. A custody event cannot be edited or deleted by the application. | `server/drizzle/0009_custody.sql` | `server/test/uh-orders.test.mjs`, `server/test/retention.test.mjs` |
| There is no endpoint that sets a status directly. Every status change goes through the transition table. | `server/src/modules/uh/lifecycle.ts` | `server/test/uh-orders.test.mjs` |
| A retry from a phone that lost signal is answered, not applied twice. | `server/src/core/http/idempotency.ts` | `server/test/idempotency.test.mjs`, `server/test/concurrency.test.mjs` |
| Concurrent writes cannot produce a duplicate custody event or lose one. | `server/test/concurrency.test.mjs` | 7 cases |
| An issued invoice is frozen; a correction carries a reason and a void is never a delete. | `server/src/modules/uh/invoices.ts` | `server/test/uh-invoices.test.mjs` |
| Invoice arithmetic is checked by an independent re-derivation that shares no code with the pricing module. | `server/src/modules/uh/reconcile.ts` | `server/test/uh-reconcile.test.mjs`, `docs/reconciliation-2026-07.md` |

### Person or entity authentication

| Control | Where | Proof |
|---|---|---|
| Passwords are hashed with bcrypt at cost 10. | `server/src/core/users/routes.ts` | `server/test/users.test.mjs` |
| Failed attempts are throttled by account and by address: 10 password attempts per account and 50 per address in 15 minutes, 5 PIN attempts per account in 10. | `server/src/core/auth/throttle.ts` | `server/test/auth-throttle.test.mjs` |
| A lockout is written to the audit trail, so a spray across many accounts is visible and not merely blocked. | `server/src/core/auth/throttle.ts` | `server/test/auth-throttle.test.mjs` |
| Second factor for admin, ops manager and dispatcher: TOTP, 6 digits, 30-second period, one step of tolerance either side. | `server/src/core/auth/totp.ts` | `server/test/totp.test.mjs`, against RFC 6238's own vectors |
| A used code is never accepted again, so one seen over a shoulder is dead rather than good for another 90 seconds. | `server/src/core/auth/totp.ts` | `server/test/mfa.test.mjs` |
| Ten single-use recovery codes, stored as SHA-256, shown once. | `server/src/core/auth/mfa.ts` | `server/test/mfa.test.mjs` |
| Enforcement is a middleware ahead of every route: a staff session without a second factor reaches the enrolment endpoints and nothing else. | `server/src/core/auth/mfa.ts` | `server/test/mfa-enforcement.test.mjs` |
| Couriers authenticate with a PIN that works only from a device enrolled with the full password. | `server/src/core/auth/devices.ts` | `server/test/devices.test.mjs` |
| A lost phone is revoked, and revoking it revokes its live sessions. | `server/src/core/auth/devices.ts` | `server/test/devices.test.mjs` |

### Transmission security

| Control | Where | Proof |
|---|---|---|
| HSTS for two years, subdomains included, production only. | `server/src/core/http/security.ts` | `server/test/security-headers.test.mjs` |
| Session and device cookies are HttpOnly, SameSite=Lax, and Secure in production. | `server/src/core/auth/sessions.ts` | `server/test/sessions.test.mjs` |
| Content security policy: `default-src 'self'`, no inline script, no CDN. | `server/src/core/http/security.ts` | `server/test/security-headers.test.mjs` |
| No third-party script on any page that carries a session. The one that existed was moved to our own origin. | `server/public/vendor/flatpickr/` | `docs/security-review-2026-09-13.md` |
| The service worker never caches anything under `/api`. The test runs the real worker in a sandbox and hands it requests, rather than asserting on the file's text. | `web/public/sw.js` | `server/test/uh-courier-app.test.mjs` |
| Signed URLs are short-lived: 5 minutes to read, 15 to write, 60 seconds to delete. | `server/src/core/files/storage.ts` | `server/test/files.test.mjs` |
| Uploads must be server-side encrypted: the encryption headers are inside the signature, so an unencrypted write is impossible rather than discouraged. | `server/src/core/files/storage.ts` | `server/test/files.test.mjs` |

### Encryption at rest

**Partial, and not verified by us.** The database is Turso and the object
store will be S3. S3 objects are written with SSE-KMS because the header is
signed. What Turso encrypts at rest, and under whose key, is a property of the
provider and of the plan, and **nobody has confirmed it against the paid plan
or the BAA**. It belongs in ticket 0.10 and then in the program, as a
statement about the provider rather than about this code.

---

## Administrative safeguards

| Control | Status |
|---|---|
| Security management: a risk analysis | **Partial.** `docs/security-review-2026-09-13.md` is a review of this application by the person who wrote it. It found six defects and fixed them. It is not a formal risk analysis of the organisation, and it is not a penetration test. |
| Security management: risk remediation | Implemented as ordinary work. Every finding in the review was fixed in the same ticket; the record is the commit history and the review document. |
| Information system activity review | **Partial.** The audit trail exists and is queryable (`GET /api/audit`), the retention sweep records itself, and `docs/runbook.md` names the queries for reviewing sign-in failures and lockouts. Nobody is rostered to actually review them on a schedule. |
| Assigned security responsibility | **Gap.** No named security official. Organisational, not code. |
| Workforce security: authorisation and supervision | Implemented. Project memberships grant roles; only a platform administrator may grant them; every grant is audited. |
| Workforce security: termination procedures | Implemented in the application (`PATCH /api/users/:username {status: disabled}`, session revocation, device revocation, MFA reset) and written up in `docs/runbook.md`. The organisational procedure that says who does it and when is a **gap**. |
| Workforce clearance | **Gap.** Background checks and the like. Organisational. |
| Information access management: minimum necessary | Implemented; see Access control above. |
| Security awareness and training | **Gap.** Organisational, and the one most likely to be asked about first. |
| Security incident procedures | **Gap.** See Breach notification below. |
| Contingency: data backup | **Blocked on ticket 0.10.** Turso point-in-time restore is a paid feature and the service is on the free plan. |
| Contingency: disaster recovery | **Partial.** The restore procedure is written (`docs/runbook.md`) and **has never been executed**. That is ticket 4.4, blocked on the same thing. |
| Contingency: emergency mode operation | **Gap.** The runbook asks who decides to fall back to telephone dispatch and where the paper fallback lives; nobody has answered. Deliveries do not stop because a system does, and Scope 1.2.8 still wants a signature. |
| Contingency: testing and revision | **Gap.** Nothing has been exercised, because there is nothing to exercise it against yet. |
| Evaluation | **Partial.** `npm run ci`, `npm run audit`, the access matrix and the load test are run every deploy or every quarter (`docs/runbook.md`). Periodic evaluation of the whole program is organisational. |

---

## Physical safeguards

Mostly not ours: the servers belong to Render and Turso, and their physical
controls are theirs to attest to under a BAA.

| Control | Status |
|---|---|
| Facility access | Provider's. Needs the BAA (ticket 0.10). |
| Workstation use and security | **Gap.** Organisational: what a dispatcher's screen may show in a shared office. |
| Device and media controls: a courier's phone | Implemented in part. The phone holds an enrolled device token and an offline queue; the queue is emptied on sign-out because it holds names and addresses on a device that may be personal, and revoking the device revokes its sessions. `web/src/lib/outbox.ts` |
| Device and media controls: disposal | See Retention below. |
| Device and media controls: media re-use | **Gap.** A personal phone leaving the workforce is the real case; revoking the device is the technical half, and the policy half is organisational. |

---

## Retention and disposal

| Control | Where | Proof |
|---|---|---|
| A scheduled sweep counts what is past retention and records that it ran, whether or not it found anything. | `server/src/core/retention/sweep.ts` | `server/test/retention.test.mjs` |
| Nothing is purged without an approval naming an exact count. | `server/src/core/retention/routes.ts` | `server/test/retention.test.mjs` |
| The audit trail is never purged. | `server/src/core/retention/policy.ts` | `server/test/retention.test.mjs` |
| Purging a delivery record removes its custody events, with the append-only trigger dropped and recreated visibly. | `server/src/core/retention/sweep.ts` | `server/test/retention.test.mjs` |
| Idempotency replies, which can contain a patient name, are kept 7 days and swept automatically. | `server/src/core/http/idempotency.ts` | `server/test/idempotency.test.mjs` |

**The retention periods themselves are undecided**, deliberately, and the
purge refuses any category in that state. That decision belongs in the program
and has to be made in two places at once: here and in the disabled bucket
lifecycle rule in `docs/infra/s3-bucket.md`.

---

## Business associate agreements

**All blocked on ticket 0.10, and this is the largest single gap.**

| Subcontractor | What they would hold | BAA |
|---|---|---|
| Render | The application process, its logs | Not signed. Free plan; the paid organisation plan is what offers one. |
| Turso | Every patient name and address in the contract | Not signed. |
| AWS (S3 + KMS) | Doorstep photographs | No account yet. |

Until these exist, **no real patient data may be put into this system**, which
is why every environment so far has been simulated. The file service refuses
rather than degrades for exactly this reason: with no bucket under a BAA, a
doorstep delivery is refused instead of recording a photograph somewhere
unblessed.

---

## Breach notification

**Gap, and it is a procedure rather than code.** What exists: an audit trail
that can answer who saw what and when, sign-in failure and lockout queries,
and `docs/runbook.md` sections for revoking access quickly.

What does not exist: the decision tree for whether an event is a reportable
breach, who makes it, the clock, who tells University Health, who tells
affected individuals, and the template. The runbook's on-call section is
empty for the same reason.

---

## Documentation

| Requirement | Where |
|---|---|
| Policies and procedures | **The program itself: the gap this ticket exists to close.** |
| Operational procedures | `docs/runbook.md` |
| Control inventory | This document |
| Security review | `docs/security-review-2026-09-13.md` |
| Performance evidence | `docs/load-test-2026-09-13.md` |
| Billing accuracy evidence | `docs/reconciliation-2026-07.md` |
| Infrastructure specification | `docs/infra/s3-bucket.md`, `render.yaml` |
| Retention decisions | `server/src/core/retention/policy.ts`, and undecided |
| Six-year retention of the documentation itself | **Gap.** Organisational. |

---

## The gaps, collected

For the program to be written and then be true, these have to be closed.
Nothing here is code that can be written to close them except where noted.

**Blocked on ticket 0.10 (accounts and BAAs):**

1. BAAs with Render, Turso and AWS.
2. Encryption at rest, confirmed rather than assumed.
3. Data backup, and a restore that has actually been run (ticket 4.4).
4. Doorstep photographs, and with them the file retention decision.

**Decisions somebody has to make:**

5. Retention periods for delivery records, signatures, photographs and
   invoices. One decision, two places.
6. On-call: who is called, after how long, and who tells University Health.
7. Emergency mode: who declares telephone dispatch, and where the paper runs.
8. A named security official.
9. A second enrolled administrator, with recovery codes stored apart. This one
   is five minutes of work and removes a single point of failure that
   currently has no route back through the application.

**Documents to write:**

10. The privacy and security program itself.
11. Breach notification procedure.
12. Workforce training, sanctions policy, clearance.
13. A formal risk analysis, and a penetration test by somebody who did not
    write this code.

---

## What must be true before real patient data arrives

Not a summary of the above: a shorter list, and a harder one.

1. **BAAs signed.** Until then this is a system that must only ever hold
   simulated data, and it has been.
2. **A second administrator, enrolled.** The cheapest item on any of these
   lists and the one with the worst failure mode.
3. **Retention decided**, or at least decided enough that nothing is deleted
   by accident. The current state is safe in that direction: the purge
   refuses.
4. **The restore drill run once**, against staging, by somebody following the
   runbook rather than the person who wrote it.
5. **The program written**, so that this document has something to be checked
   against and 4.7 can actually be completed.
