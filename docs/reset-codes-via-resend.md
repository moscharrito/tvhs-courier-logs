# Reset codes through Resend, while SES is in the sandbox

A bridge with a date on it. SES will not deliver to an unverified recipient
while it is in the sandbox, which is no use to a courier whose account
carries a gmail address. Reset codes go out through Resend until AWS grants
production access; everything else stays on SES.

**Delivery notices and the daily summary do not come through here.** They
carry the volume -- about 3,000 on a weekday -- and they stay on SES under
the agreement already in place. Only the six digit code moves.

## USE A DIFFERENT SUBDOMAIN FROM SES

Verify `notify.izyglobalservices.com` in Resend, not `izyglobalservices.com`
and not `mail.izyglobalservices.com`.

SES already owns DKIM on `mail.` and the apex was verified for SES on
28 October. DKIM selectors would not actually collide, but SPF on one name
would have to list both providers, and the day somebody removes one include
they break the other provider's mail with no obvious connection between the
two. A separate subdomain keeps the two vendors from sharing a single record
that either could break.

## STEPS

1. Create the Resend account. Add the domain `notify.izyglobalservices.com`.
2. Publish the DNS records Resend gives you -- its own SPF and DKIM, nothing
   to do with the SES records already published. Same trap as last time: if
   the DNS host appends the domain, enter only the first label.
3. Wait for Resend to show the domain Verified.
4. Create an API key with send permission. It begins `re_`.
5. Set these on Render, in the server's environment:

        MAIL_FALLBACK_ENABLED=true
        MAIL_FALLBACK_API_KEY=re_...
        MAIL_FALLBACK_FROM=no-reply@notify.izyglobalservices.com

   `MAIL_FALLBACK_ENDPOINT` can be left unset; it defaults to Resend's.

6. Redeploy. Nothing else changes: with the fallback configured the reset
   router uses it, and without it the router keeps using SES.

## CHECKING IT WORKS

Trigger a reset for an address on a real account that is NOT one of the two
SES-verified identities -- a gmail address is the point of the exercise --
and the code should arrive. Before this bridge, that send never left the
building.

`/health` reports the SES mailer, not this one, so a successful reset through
Resend will not move the `mail` field. Resend's own dashboard is where the
send shows up.

## TURNING IT OFF, WHICH IS THE GOAL

The day AWS grants production access:

    MAIL_FALLBACK_ENABLED=false

Redeploy, and reset codes go back through SES with every other message. No
code change and no second vendor in the path. That is the whole reason the
transport is selected by configuration rather than by an import.

## WHAT THIS DOES NOT DO

It does not help the accounts that have no email address at all. A reset for
an address nobody holds is answered with "a code is on its way" and nothing
is sent, by design -- see `core/auth/password-reset.ts`. As of 28 October
that is 32 of 39 accounts, including all nine University Health portals.
`server/scripts/set-emails.mjs` is the fix for that, and it is a separate
job from this one.
