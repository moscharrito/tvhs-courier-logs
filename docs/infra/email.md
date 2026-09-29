# Notification email

What has to be true before `MAIL_ENABLED=true` is turned on. Like the bucket,
none of it can be done from the application.

## What is sent, and what is deliberately not

Two notifications leave the company: a delivery was completed, and a delivery
could not be completed. They are addressed to the pharmacy that sent the work,
and they carry **an order number, a pharmacy name, a time and a link**.

No patient name. No address. No medication. Not in the subject, not in the
body, not in a log line about a send that failed.

This is a decision about where PHI is allowed to go, not a limitation of SES.
An email stops being ours the moment it is sent: it sits on a hospital mail
server, gets forwarded, syncs to a phone, and lands in backups nobody here
controls. A signed agreement with the service that **sends** it says nothing
about any of that. Keeping the body empty of patient data means a misaddressed
notification is an annoyance rather than a reportable breach, and anyone who
needs to know who a delivery was for opens the portal, where reading it is
authenticated, scoped to their own pharmacy, and audited.

`assertNoPatientData` in `server/src/core/notify/ses.ts` enforces it and
**throws rather than trimming**, because a caller that tried to put a patient
in an email should fail loudly rather than send a shortened version.

## 1. Verify the sending domain

Not a single address. A verified domain lets the from address change without
another verification round, and DKIM is what stops a hospital's filter
treating these as spam.

```bash
aws sesv2 create-email-identity --email-identity izyglobalservices.com --region "$REGION"
aws sesv2 get-email-identity --email-identity izyglobalservices.com --region "$REGION" \
  --query 'DkimAttributes.Tokens'
```

Publish the three CNAME records those tokens give you, then wait for
`DkimAttributes.Status` to read `SUCCESS`. Add SPF and a DMARC record while
you are in the DNS.

## 2. Leave the sandbox

**A new SES account can only send to addresses you have verified, and is
capped at 200 messages a day.** This is the step people miss: everything looks
configured, the first email to a real pharmacist is rejected, and the rejection
is a retry loop rather than an error anybody sees.

Request production access in the SES console under Account dashboard. It is a
short form asking what you send and how you handle bounces. Answer it honestly:
transactional delivery notifications to a known list of hospital staff, no
marketing, no purchased addresses. Approval is usually within a day.

Until it is approved, verify each tester's address individually:

```bash
aws sesv2 create-email-identity --email-identity pharmacist@example.org --region "$REGION"
```

## 3. The IAM user

Its own user, separate from the file store's. The file user may write objects
and the mail user may send mail, and a leaked key should not be able to do the
other's job.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendFromThisIdentityOnly",
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": "arn:aws:ses:REGION:ACCOUNT_ID:identity/izyglobalservices.com"
    }
  ]
}
```

Scoped to the identity on purpose. `"Resource": "*"` would let a leaked key
send as any domain the account ever verifies, which is a phishing primitive
rather than a convenience. `ses:SendRawEmail` is not granted: the application
sends simple text through the v2 API and has no use for MIME it assembles
itself.

## 4. The environment

Six values, saved together:

```
MAIL_ENABLED           true
MAIL_FROM              no-reply@izyglobalservices.com
MAIL_PORTAL_URL        https://logs.izyglobalservices.com
SES_REGION             us-east-2
SES_ACCESS_KEY_ID      ...
SES_SECRET_ACCESS_KEY  ...
```

`MAIL_ENABLED` with any of the others missing is a **boot failure**, the same
as `FILES_ENABLED` without a bucket. That is deliberate: a server that started
with mail switched on and no credentials would quietly stop notifying a
hospital, and nobody would notice for a fortnight.

`MAIL_PORTAL_URL` must be https. It is the one link in every notification, and
plain http would send a hospital to a page where their session cookie crosses
the network in clear.

**`SWEEP_INTERVAL_SECONDS` must also be set.** Nothing is sent by the request
that recorded the delivery: notifications are written to a table and the
scheduler drains them. With no interval the rows accumulate and no email ever
goes out. See `core/notify/dispatch.ts` for why that separation is worth the
extra setting.

## 5. Check it

The boot log says which state it is in:

```
scheduler  sweep=every 120s  mail=on
```

`mail` reading anything else is the reason, printed. Then close one rehearsal
delivery and confirm the row is marked sent:

```sql
SELECT id, kind, username, sent_at FROM notifications WHERE kind LIKE 'delivery.%' ORDER BY id DESC LIMIT 5;
```

A row with `sent_at` still null after two ticks means SES refused it, and the
reason is in the log as `notify.dispatch.send_failed`. The message text is
never logged: it is addressed to a hospital about one of their deliveries.

## Still open

- **Per-user opt-out.** Every pharmacy member scoped to a site is notified.
  There is no "email me only about failures" setting, and somebody will ask.
- **Bounce and complaint handling.** SES will publish these to SNS; nothing
  consumes them yet, so a pharmacist who leaves the hospital generates a bounce
  on every delivery and no one is told to remove the account.
- **Push notification.** The device table and the registration routes exist and
  nothing delivers to them. Email was built first because a pharmacist is at a
  desk, not carrying our app.
