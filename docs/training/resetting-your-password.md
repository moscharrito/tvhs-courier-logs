# Getting back in

For University Health pharmacy counters and the contract manager.

Screens referenced here are in `portal-screens/`.

---

## There are three ways, and the fastest is not email

| If you are | Do this |
|---|---|
| **A pharmacy counter** | Ask your **contract manager**. They set it themselves, on the spot. |
| **The contract manager** | Reset it yourself if your account has an email address, or ring the Izy Global office. |
| **Anyone, any time** | Ring the Izy Global office. We can set a password directly. |

Only the middle one depends on email, and email is the slowest of the three.

---

## For the contract manager: setting a counter's password

`c3-manager-logins.png`

**Pharmacy logins** in your portal lists every counter you cover, with its
username and a **Set a new password** button.

Use it when somebody has forgotten theirs, when a member of staff leaves, or
when a password has been sent to the wrong person.

- Changing it **signs that pharmacy out everywhere, immediately**. That is
  usually the reason for doing it.
- Every change is recorded against your name and the pharmacy.
- **The password itself is never recorded**, by us or anywhere in the system.
  Hand it over, and ask them to change it once they are in.
- Your own password is not changed from this screen. Use **Your account**.

---

## Resetting your own, by email

### Step 1 — "Forgotten your password?"

On the sign-in screen, underneath the box.

### Step 2 — the address, not the username

`r2-forgot.png`

> Your email address
> *The address the office has for you. Not your username.*

This is the step people get wrong:

| | Username | Address to type |
|---|---|---|
| Pharmacy counter | `uh.vida`, `uh.green` … | the pharmacy's mailbox, **not** `uh.vida` |
| Contract manager | `uh.manager` | your own work address |

You will see:

> If that address belongs to an account, a six digit code is on its way. It
> expires in 15 minutes. If nothing arrives, ring the office.

That wording is the same whether or not we recognise the address — on
purpose, so the page cannot be used to find out who has an account.

### Step 3 — the code and the new password

`r3-code.png`

Six digits, **expires in fifteen minutes, works once**. Type it in, choose a
new password on the same screen, press **Set the new password**. Every device
is signed out.

---

## For the Izy Global office

- `server/scripts/set-emails.mjs` puts addresses on accounts that lack them.
  Run it before telling any counter to use the email route.
- Reset codes go out through a separate provider from everything else,
  because AWS SES is still sandboxed and delivers only to verified addresses.
  See `docs/reset-codes-via-resend.md`. When production access lands,
  `MAIL_FALLBACK_ENABLED=false` puts them back with the rest.
- A reset code carries six digits and nothing else: no name, no link, no
  account detail. That is what makes it the one message safe to send through
  a second vendor.
