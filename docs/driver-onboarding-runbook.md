# Onboarding drivers so the reset code actually works

The plan: create the selected drivers with their real email addresses, hand
each a generated password, tell them to reset it themselves.

That plan has one hard dependency, and it is not AWS.

## THE DRIVERS ARE ON GMAIL, AND SES WILL NOT REACH THEM

SES is in the sandbox. The sandbox delivers only to a verified identity, and
we hold two: `mail.izyglobalservices.com` and `contracts@izyglobalservices.com`.
A code sent to a driver's gmail address is refused before it leaves AWS.

Verifying the apex domain helped the nine University Health counters, whose
addresses we can put on our own domain. It does nothing for a driver on
gmail, and drivers are the people being onboarded.

So **Resend has to be live before the first driver is told to reset**, or
every one of them taps "Forgotten your password?", is told a code is on its
way, and waits for an email that was never sent.

## START THE RESEND DOMAIN TONIGHT

DNS is the slow part and it is the only part that cannot be hurried. SES
took from publishing the records to verifying them with nothing to do in
between. Resend needs the same wait.

1. Create the Resend account.
2. Add the domain `notify.izyglobalservices.com`.
   NOT the apex and NOT `mail.` -- SES owns records on both, and a shared
   SPF record is a thing either vendor can break for the other.
3. Publish the SPF and DKIM records Resend gives you. If the DNS host
   appends the domain, enter only the first label.
4. Leave it. Verification arrives on its own.

Everything else below takes minutes and can be done tomorrow. This cannot.

## WHEN RESEND SHOWS VERIFIED

Create an API key with send permission, then on Render:

    MAIL_FALLBACK_ENABLED=true
    MAIL_FALLBACK_API_KEY=re_...
    MAIL_FALLBACK_FROM=no-reply@notify.izyglobalservices.com

Redeploy. Production is currently running a build from before any of this
existed, so the redeploy is required whatever else happens.

## PROVE IT BEFORE TELLING EIGHTEEN PEOPLE TO USE IT

Create ONE driver with an address you control at a public provider, ask for
a reset, and wait for the code to arrive. Do not skip this. The endpoint
answers "a code is on its way" whether it sent one or not -- that is
deliberate, so it cannot be used to discover who has an account -- which
means an untested pipeline looks exactly like a working one until eighteen
drivers ring the office.

## THEN THE REAL LIST

`username,name,email` per line, one driver per line:

    node server/scripts/create-drivers.mjs --file drivers.csv

It prints the plan and changes nothing. Add `--apply` when it reads right.

The script refuses a driver with no email address, refuses two drivers
sharing one, and refuses an address already on another account. Those three
refusals are the reason tomorrow will not repeat the position we are in
today, where 32 of 39 existing accounts cannot reset their own password
because nobody put an address on them.

Passwords print once. They are not recoverable; rerun with `--reset` if one
is lost.

## THE ORDER MATTERS

Resend verified, then deployed, then tested with one address, then the
eighteen. Onboarding first and discovering the mail path is dead afterwards
means re-issuing eighteen passwords by hand.
