# Resetting your password

For pharmacy counters, site managers and drivers. The same three steps on a
phone and in a browser.

Screens referenced here are in `portal-screens/`.

---

## Before you start: do we have your address?

The reset finds your account **by email address**. If the office has not put
an address on your account, this will not work — and it will not tell you so.
You will be told a code is on its way, because that message is deliberately
the same whether or not the address is known to us, and nothing is sent.

> **As of 29 October 2026 the nine University Health counter logins
> (`uh.green`, `uh.vida`, and the rest) have no address on file.** Until they
> do, ring the office for a reset. The office can set a password directly.

Drivers created with `create-drivers.mjs` always have one: that script
refuses a row without an address for exactly this reason.

---

## Step 1 — "Forgotten your password?"

`r1-signin.png`

On the sign-in screen, choose your project, then **Forgotten your password?**
underneath the box.

## Step 2 — type the address, not the username

`r2-forgot.png`

> Your email address
> *The address the office has for you. Not your username.*

This catches people out, so it is worth saying twice:

| Who | Username | Address to type |
|---|---|---|
| Driver | usually their email | the same address |
| Pharmacy counter | `uh.vida`, `uh.green` … | the pharmacy's mailbox, **not** `uh.vida` |
| Site manager | `uh.sitemanager` | their own work address |

Press **Send me a code**. You will see:

> If that address belongs to an account, a six digit code is on its way. It
> expires in 15 minutes. If nothing arrives, ring the office.

That wording is on purpose. It is the same answer either way, so this page
cannot be used to find out who has an account.

## Step 3 — the code and the new password

`r3-code.png`

The email contains six digits. It **expires in fifteen minutes and works
once**. Type it in, choose a new password on the same screen, press **Set the
new password**.

---

## What happens next

- **Every device is signed out.** That includes a driver's phone PIN, so a
  driver sets the PIN up again the next time they open the app.
- The old password stops working immediately.
- Nobody at the office ever sees your new password. That is the point of the
  reset existing at all: the password we generate when we create an account is
  the one you sign in with until you replace it with something we have never
  seen.

## If nothing arrives

1. Check the address you typed. The username is not always the address.
2. Check junk mail.
3. Wait a minute — it is sent immediately but mail is not always instant.
4. Ring the office. They can set a password for you directly, and they can
   also put an address on your account so that next time this works.

## For the office

- `server/scripts/set-emails.mjs` puts addresses on accounts that lack them.
  Run it before telling anybody to use this page.
- Reset codes go out through a separate mail provider from everything else,
  because AWS SES is still in its sandbox and will only deliver to verified
  addresses. See `docs/reset-codes-via-resend.md`. When SES production access
  lands, `MAIL_FALLBACK_ENABLED=false` puts reset codes back with the rest.
- A reset code never contains a name, a link or any account detail. Six digits
  and nothing else, so it is the one message that can go through a second
  provider at the lowest cost.
