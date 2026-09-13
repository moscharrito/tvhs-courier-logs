# Security review: 2026-09-13

Ticket 4.2. What was examined, what was found, what was changed, and what is
still open. Written for a person, because the part University Health will ask
about is the reasoning, not the diff.

## What was found

Four defects. Three were holes in access control that no test had ever asked
about; one was a missing control that had been missing since the first commit.

| | Found | Severity | Now |
|---|---|---|---|
| 1 | `POST /api/login` had no rate limit at all | **High** | Throttled by username and by address |
| 2 | `POST /api/login/pin/setup` was a second, unthrottled password oracle | **High** | Throttled on the same allowance |
| 3 | A client viewer could read every University Health site: address, contact, the lot | Medium | Gated to staff and couriers |
| 4 | A client viewer could read the project's operating parameters, including our internal SLA goal | Low | Gated to staff and couriers |
| 5 | The manual event endpoint answered 404 before deciding who was asking | Low | Authorizes first |
| 6 | The legacy TVHS page loaded a script from a public CDN, no SRI, on a page holding a session | Medium | Served from our own origin |

Nothing here is evidence of a breach: there is no production deployment yet,
and the only data in the system is simulated. That is the point of doing this
before ticket 0.10 rather than after.

## 1 and 2: guessing a credential

`POST /api/login` answered an unlimited number of password guesses. The only
thing slowing an attacker down was bcrypt, which is a cost to us as much as to
them: answering ten thousand guesses with a deliberately slow hash is its own
denial of service.

`POST /api/login/pin/setup` takes a driver's password, and had no counter
either. Two doors, one credential, and a counter on neither.

`src/core/auth/throttle.ts` now holds one implementation, used by all four
credential endpoints: password sign-in, PIN sign-in, PIN setup and device
enrolment. The two copies that existed, one in `server.js` and one in
`core/auth/devices.ts`, are gone.

It counts two keys, not one. By username alone, an attacker sprays one guess
at a thousand accounts and is never counted. By address alone, an attacker
with a thousand addresses is never counted, and a pharmacy behind one NAT
locks itself out. The limits:

| Credential | Per account | Per address |
|---|---|---|
| Password | 10 in 15 minutes | 50 in 15 minutes |
| PIN | 5 in 10 minutes | 30 in 10 minutes |

Five for a PIN because a PIN is four digits, and five guesses is the most that
can be allowed while leaving ten thousand possibilities genuinely out of
reach. That limit is the only reason four digits is acceptable on a screen
showing PHI at all.

A refused caller gets 429, a `Retry-After`, and a message that reads the same
whether or not the account exists. A correct credential clears the account's
counter but not the address's: one person signing in correctly must not erase
the evidence of a spray from the same place. Every lockout writes
`auth.throttled` to the audit trail, which is how a spray becomes visible
rather than merely blocked.

**The counters are in memory.** On one Render instance that is the whole
picture. On two, an attacker gets each limit once per instance. Moving them
into the database is the fix and it is deliberately not done yet: a database
write per failed attempt, against a network database, hands the attacker a
lever. It is worth doing when there is a second instance, and the runbook
(ticket 4.5) should say so.

## 3, 4 and 5: the access control matrix

`server/test/access-matrix.test.mjs` is the specification and the proof: every
endpoint the application mounts, called by every kind of caller, with the
answer written down. 109 cases.

The callers are anonymous, a signed-in person who is not a member of the
project, and one account for each of the five project roles, plus the platform
administrator. The non-member is the seeded TVHS driver, so every University
Health row is also a cross-project check.

Two rules make it useful.

**Authorization is asserted and nothing else.** The ids are nonexistent and
the bodies are empty on purpose, so an allowed caller usually gets 400 or 404,
and that counts as a pass. What is being tested is the gate.

**A route must decide who is asking before it decides what exists.** A handler
that answers 404 to a caller who should have been refused has told them the id
is free. That is how defect 5 was found: the manual event endpoint loaded the
order first, so a client viewer could walk the id space and learn which orders
exist.

Defects 3 and 4 were the same shape as the hole found in ticket 3.1: routes
written before `client_viewer` existed, which had never been asked the
question out loud. Sites and project settings both passed any project member.

The test ends with a coverage guard that compares the table against the routes
actually mounted. A new endpoint fails the suite until somebody writes down
who may call it.

### The matrix, in summary

| Area | Who |
|---|---|
| Sign-in, health, project names | Anyone |
| My own sessions and devices | Any signed-in person |
| User directory, memberships, audit log | Platform administrator only |
| TVHS check-ins and logs | TVHS drivers; the admin screens, platform administrator |
| UH pharmacies, project settings | admin, ops_manager, dispatcher, courier |
| UH orders, runs, returns, the door, files | admin, ops_manager, dispatcher, courier |
| UH dispatch board, price schedule, imports, SLA reports | admin, ops_manager, dispatcher |
| UH invoices: reading | admin, ops_manager, dispatcher |
| UH invoices: issuing, adjusting, voiding | admin, ops_manager |
| The client portal | client_viewer, and staff |

A project role of `admin` is not the platform administrator. The account that
runs the University Health contract cannot read the user directory or the
audit log, and the matrix asserts it.

## 6 and the browser: headers and a content security policy

There were no security headers of any kind. There are now, in
`src/core/http/security.ts`, written by hand rather than taken from helmet, for
the same reason as the PDF writer and the SigV4 signer: the requirement is a
fixed set of values this application has to decide anyway, and a dependency in
the path of every response is one more thing to patch and to explain.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'; frame-src 'none'; worker-src 'self'; manifest-src 'self'
```

plus `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a
`Permissions-Policy` that asks for the camera and position and nothing else,
`Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`, and HSTS for
two years in production only. `X-Powered-By` is off.

**`script-src 'self'` is what forced defect 6 into the open.** The legacy TVHS
page loaded flatpickr from cdnjs at runtime, with no subresource integrity, on
a page carrying a signed-in session. A CDN compromise would have been our
breach to report. The file is now served from `server/public/vendor/flatpickr`,
byte-identical to cdnjs flatpickr 4.6.13:

```
flatpickr.min.js   sha384-5JqMv4L/Xa0hfvtF06qboNdhvuYXUku9ZrhZh3bSk8VXF0A/RuSLHpLsSV9Zqhl6
flatpickr.min.css  sha384-RkASv+6KfBMW9eknReJIJ6b3UnjKOKC5bOUaNgIY778NFbQ8MtWq9Lr/khUgqtTt
```

`style-src` keeps `'unsafe-inline'`, and it is the one relaxed directive.
React components set style attributes in about fifty places and `index.html`
carries the boot styles that paint the loading state before the bundle
arrives. Style injection cannot execute code; the cost of the relaxation is
that a successful HTML injection could restyle a page, and the price of
removing it is threading a nonce through the whole render path.

The policy was verified in a browser, not only in tests: the shell, the
dispatch board and the legacy TVHS screen all load with no violation, and
`window.flatpickr` is defined from the local copy.

## Trusting the proxy

`trust proxy` was not set. Behind Render, every audit row would have recorded
Render's address rather than the courier's, and the new per-address throttle
would have counted the entire internet as one caller.

It is now a number from the environment, defaulting to one hop in production
and none elsewhere. Not `true`: that trusts an `X-Forwarded-For` header from
anyone, which would let a caller choose the address that lands in the audit
trail and in the throttle's bucket.

## Dependencies

`npm run audit` checks production dependencies at the high threshold. It is
deliberately not part of `npm run ci`, which must run offline.

**One high, fixed.** `drizzle-orm` below 0.45.2 (GHSA-gpj5-g38j-94v9, SQL
injection via improperly escaped identifiers), upgraded to 0.45.2. Exposure
here was nil either way: drizzle is used for schema definitions and migrations
only, and every runtime query in this application goes through
`client.execute({ sql, args })` with bound parameters. The upgrade is on
principle, not on evidence.

**Four moderate, assessed and left.** Each was traced to the calling code
rather than accepted or dismissed on its severity label:

- `uuid` below 11.1.1, missing bounds check when a `buf` argument is given.
  Reached through `exceljs`, which calls `uuidv4()` with no arguments in one
  file. Not reachable. The advisory's fix is `exceljs@3.4.0`, a downgrade
  across a major version, for a bug this code cannot hit.
- `react-router` open redirect via a backslash in `<Link>` and `useNavigate`.
  Every `navigate()` call in `web/src` takes a literal path; there is no
  `?redirect=` parameter anywhere in the application. Not reachable. The fix
  is react-router 7, a rewrite of the routing API.
- The same advisory's `deserializeErrors()` item applies to server-side
  rendering. This app does not server-side render.
- `esbuild`, `vitest` and `drizzle-kit` advisories are development-only and
  are not shipped.

These four should be revisited at each dependency refresh, and the react-router
7 migration wants a ticket of its own rather than a rushed upgrade before
go-live.

## Checked and clean

- **SQL injection.** Every query uses bound parameters. The handful of
  template literals in SQL interpolate a generated run of `?` placeholders or
  a hard-coded table name in a migration, never a caller's value.
- **Secrets.** None in the repository: `.env` is ignored and was never
  committed, and `.env.example` holds placeholders. `SESSION_SECRET` is
  required, and must be at least 32 characters in production. Turso is
  required in production, because a local file would be lost on redeploy.
  `describeConfig` is the only thing that prints configuration and a test
  asserts it carries no secret. The one AWS-looking key in the tree is
  `AKIAIOSFODNN7EXAMPLE`, the example key from AWS's own SigV4 test vectors.
- **Session fixation.** Signing in always mints a fresh random token and
  replaces the cookie, so a session id supplied by an attacker is never
  adopted.
- **Cookies.** `httpOnly`, `SameSite=Lax`, and `Secure` in production, for
  both the session and the device cookie.
- **Cross-site request forgery.** `SameSite=Lax` stops a cross-site POST from
  carrying the session cookie, and no state-changing endpoint is a GET.
- **Error responses.** The central handler hides detail in production; a test
  exercises it on a real request.

## Still open

- **MFA for staff** is ticket 4.3, not this one. Today a platform
  administrator is protected by a password alone.
- **The throttle is per process.** See above.
- **Everything here was tested against a local server.** TLS, HSTS in a real
  browser, and the proxy hop count are properties of the deployment, and the
  deployment does not exist until ticket 0.10.
- **No penetration test.** This is a review by the person who wrote the code,
  which finds missing gates and does not find what that person does not think
  to look for.
- **Dependency advisories** listed above, to be revisited at each refresh.
