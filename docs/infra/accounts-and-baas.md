# Accounts and business associate agreements

Ticket 0.10. The keystone: eight other tickets are waiting on it, and none of
it is engineering.

**Nothing in this document can be done by whoever is writing the code.** It
needs a company card, a person authorised to sign agreements on behalf of Izy
Global Services LLC, and in one case a conversation with a vendor's sales team.
What follows is the order to do it in, what to ask for, what to check
afterwards, and the two places where a "no" from a vendor is an architecture
problem rather than a procurement one.

## Ask before you buy

**Do not upgrade any plan until all three vendors have confirmed in writing
that they will sign a BAA covering the services this system uses.** The order
matters because a refusal is not a small problem:

| Vendor | Holds | If they will not sign |
|---|---|---|
| **Turso** | Every patient name and address in the contract | **The database choice is wrong.** Rework, not a purchase: the application talks libSQL through one client module, but moving to a managed Postgres under the AWS BAA would mean a new adapter, a migration path, and re-running everything in Phase 4. Find this out first. |
| **Render** | The application process and its logs | Serious but smaller. The logs avoid PHI by construction (`core/http/logger.ts`), but the process holds it in memory and that is enough to need the agreement. Another host is a redeploy, not a rewrite. |
| **AWS** | Doorstep photographs, and possibly geocoding | Photographs stay off and doorstep delivery keeps refusing, which is survivable. Geocoding patient addresses (ticket 1.9) stays impossible, which is already the case. |

Ask all three in the same week. The answers decide what is bought.

### What to ask for, precisely

Not "do you support HIPAA". Vendors answer that with marketing. Ask:

> Will you execute a Business Associate Agreement with Izy Global Services LLC
> covering [the specific service], and which of your plans is that available
> on? Please send the agreement for review.

And then, when the agreement arrives, check the **covered services list**. Every
vendor's BAA covers some of their products and not others. That list is the
whole document as far as this system is concerned.

- **AWS**: confirm S3 and KMS are on the current HIPAA-eligible services list.
  If ticket 1.9 is ever going to use AWS Location Service for geocoding patient
  addresses, confirm that one too, because it is the reason to prefer AWS over
  a separate geocoding vendor.
- **Google Maps Platform**: already answered, and the answer is no. Google's
  BAA does not cover the Maps APIs and their terms exclude protected health
  information. The application refuses to send a patient address to it in code
  (`server/src/core/geo/provider.ts`). Do not ask again hoping for a different
  answer; ask AWS instead.

## Then, in this order

### 1. AWS account, bucket, and the BAA

The AWS BAA is normally self-service through AWS Artifact rather than a sales
conversation, which is why it is first: it is the one that can be finished in
an afternoon.

1. Create the AWS account for Izy Global Services LLC. **Not a personal
   account**, and not the one used for anything else.
2. Accept the BAA in AWS Artifact, as the account's management user.
3. Turn on MFA for the root user before anything else. Then stop using it.
4. Build the bucket exactly as `docs/infra/s3-bucket.md` specifies: public
   access blocked, SSE-KMS as the default and everything else refused,
   **versioning on before the first object is written**, the lifecycle rules,
   the CORS rule, and the least-privilege IAM user.
5. Keep the access key out of the repository. It goes in Render's environment
   and nowhere else.

**File the BAA.** See "Where the documents live" below.

### 2. Turso

1. Confirm the BAA, and which plan it requires.
2. Create **two** databases: one for staging, one for production. Never one
   shared. A staging process pointed at production is one environment variable
   away at all times, and the only thing that makes it survivable is that they
   are different databases.
3. Confirm what point-in-time restore the plan actually includes, and how far
   back. **Ticket 4.4 has never taken a real snapshot**, and the first time
   anybody does it should not be during an incident.
4. Mint a token per environment. Not one token used twice.

### 3. Render

1. Confirm the BAA and the plan it needs. Get it in writing before upgrading.
2. Create the **staging** service first, from `render.yaml`. The blueprint
   already carries `NODE_ENV=production`, `TRUST_PROXY=1`, `MFA_ENFORCED=true`
   and `FILES_ENABLED=false`; turn files on once the bucket exists.
3. Point staging at the staging Turso database and the bucket.
4. Only then create production.

**Staging is production-shaped on purpose.** `NODE_ENV=production` there too:
the application refuses to start against a Turso database without it, and a
staging environment with the security controls relaxed tests something other
than what will run.

## Check each one

Everything below exists today and can be run the moment an environment does.

**The server refuses to start if the environment is wrong**, so a deploy that
fails the health check is the first check passing, not a setback. The
configuration guard names every problem at once.

```bash
# The service is up and the database answers
curl -s https://<service>.onrender.com/health

# The restored, or brand new, database is sound
ALLOW_TURSO_OUTSIDE_PRODUCTION=true TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  npm run restore:check -w server

# What is still in the way of go-live
curl -s https://<service>.onrender.com/api/projects/uh/uh/go-live
```

The bucket has its own check in `docs/infra/s3-bucket.md` section 6: try to
write an unencrypted object and confirm it is refused.

**Then do the restore drill for real** (ticket 4.4). Take a snapshot of
staging, restore it into a third database, run `restore:check` against the
restored copy, and time it. That is the number that matters during an incident
and nobody has it.

## Where the documents live

Three signed agreements, and they are the evidence for the entire privacy
program (`docs/privacy-controls.md`, which currently lists all three as
missing).

**Not in this repository.** They are commercial agreements with signatures on
them, and a git repository is the wrong place: it is cloned onto laptops, and
its access control is not the one that should govern a contract. Put them
wherever the signed University Health documents live, and record in
`docs/privacy-controls.md` that they exist, when they were signed, and what
each one covers.

Somebody should also know the renewal dates. A BAA that lapses is a BAA that
did not exist for the period it lapsed in.

## The first deploy, once all of this is done

There is an order to this one too, and it cannot be changed, because
two-factor authentication is enforced (ticket 4.3):

1. `ADMIN_USER` / `ADMIN_PASS` create the first administrator on first boot.
   They are ignored on every later boot.
2. Sign in as that administrator. The only thing the account can reach is the
   two-factor setup screen.
3. Enrol. Scan the QR, type the code, **write down the ten recovery codes.**
4. **Create the second administrator and enrol it too**, with its recovery
   codes kept somewhere else entirely. This is five minutes of work and it is
   the difference between a lost phone being an inconvenience and being a
   database surgery: nobody can reset the last administrator, by design.
5. Now create everybody else and grant project memberships.

The go-live check fails until there are two enrolled administrators, on
purpose.

## One honest word about the estimate

The backlog says one day. The **work** is a day. Getting three vendors to
execute agreements is not, and it is not something that can be compressed by
starting earlier on the parts that follow it, because every one of them needs
the agreement to exist first.

Start the three conversations today, in parallel, before anything else on this
page.
