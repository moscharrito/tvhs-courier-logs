# Verifying izyglobalservices.com (the apex) in SES

Created 28 October 2026 in **us-east-1**. Status on creation:
`Verification pending`, DKIM configuration `Pending`, signatures `Enabled`.

## WHY THE APEX, WHEN mail.izyglobalservices.com IS ALREADY VERIFIED

Those two identities do different jobs, and conflating them is the easy
mistake here.

`mail.izyglobalservices.com` is the **sending** identity -- it is what the
From address belongs to. The apex is being verified as a **receiving**
identity, because of how the sandbox works:

> In the sandbox, SES will only deliver to a verified identity. A verified
> DOMAIN identity makes every address in that domain a valid recipient.

So verifying the apex means any `@izyglobalservices.com` address can receive
mail from us while the account is still in the sandbox. That is the whole
point: it unblocks password reset codes without waiting on AWS.

Confirmed from the console on 28 October: the account is in the sandbox in
US East (N. Virginia), 200 emails per 24 hours, and **0 emails sent in the
last 7 days**.

## THE DNS RECORDS TO PUBLISH

Three CNAMEs for Easy DKIM:

| Type | Name | Value |
|---|---|---|
| CNAME | `obwz44eoyzgeggf2lyjcbfbn56zunwgd._domainkey.izyglobalservices.com` | `obwz44eoyzgeggf2lyjcbfbn56zunwgd.dkim.amazonses.com` |
| CNAME | `a5rzjdeag65ghn7ycbyvxjg3erccvtl4._domainkey.izyglobalservices.com` | `a5rzjdeag65ghn7ycbyvxjg3erccvtl4.dkim.amazonses.com` |
| CNAME | `xaj633r43ekkfrj5tqkpesyr4blq46bi._domainkey.izyglobalservices.com` | `xaj633r43ekkfrj5tqkpesyr4blq46bi.dkim.amazonses.com` |

SES also suggests a DMARC record, which is optional for verification:

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc.izyglobalservices.com` | `"v=DMARC1; p=none;"` |

**If the DNS host appends the domain automatically** -- most do -- enter only
the first label, e.g. `obwz44eoyzgeggf2lyjcbfbn56zunwgd._domainkey`, or the
record ends up at `..._domainkey.izyglobalservices.com.izyglobalservices.com`
and never verifies. That is the usual reason this step fails.

Check from a shell once published:

    nslookup -type=CNAME obwz44eoyzgeggf2lyjcbfbn56zunwgd._domainkey.izyglobalservices.com

## WHAT THIS DOES AND DOES NOT FIX

**Fixes:** reset codes to any `@izyglobalservices.com` address, in the
sandbox, today. Give each account an address at this domain and forward it
to the real person.

**Does not fix:** delivery outcome notices. Those run near 3,000 on a
weekday against a 200/day sandbox quota, and no amount of identity
verification changes a quota. Those still need production access.

**The trade-off worth saying out loud:** a reset code landing in a shared or
forwarded counter mailbox is weaker than one going to a named person. The
portal accounts are already shared per counter, so this does not make things
worse -- but it is a real property of the arrangement, not a detail.
