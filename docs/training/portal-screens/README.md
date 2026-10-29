# Portal screens

Thirteen screens at 1920x1080, captured from the running app on 29 October
2026 — not mocked, not drawn. What is in them is what the portal does.

## The pharmacy sees (signed in as `uh.vida`)

| | |
|---|---|
| `p1-deliveries.png` | Their counter's day: sent to us, still out, delivered, not delivered |
| `p2-send-list.png` | Sending the daily list. **Their own pharmacy is the only entry in the dropdown** |
| `p3-performance.png` | On time, late and failed, for their counter only |

## The site manager sees (signed in as `uh.sitemanager`)

| | |
|---|---|
| `m1-home.png` | The whole contract. Role named at the top; list import says it needs admin |
| `m2-board.png` | The dispatch board: unassigned pool, one lane per driver |
| `m7-wave.png` | Planning the wave — proposes runs and names a driver for each |
| `m3-roster.png` | Which pharmacy each driver works from, grouped by counter |
| `m4-orders.png` | Every order on the contract, searchable |
| `m5-custody.png` | One delivery's chain of custody, append-only |
| `m6-drivers.png` | The drivers record — work without money for a site manager |

## Resetting a password (signed out)

| | |
|---|---|
| `r1-signin.png` | Where it starts |
| `r2-forgot.png` | The address, not the username |
| `r3-code.png` | Six digits and the new password, on one screen |

## The patient data in these is invented

Every recipient, address and prescription reference in `p1`, `m2`, `m4` and
`m5` was made up for a rehearsal on this laptop. No real patient appears in
any of them, which is what makes the set safe to put in a deck and send
round.

## How they were taken, so they can be retaken

The browser pane caps a screenshot at its own width — 513 pixels here — so
these come from headless Edge driven over CDP, which gives true 1920x1080.
A session cookie cannot be passed on the command line, so the script signs in
through the API and sets the cookie over the wire before the first navigation.
`scratchpad/shoot.mjs` in the session that produced these; the three things
that cost time were:

1. **Attach to a tab of your own.** Taking `targets[0]` photographed Edge's
   own "we are syncing your browsing data" interstitial, with the signed-in
   person's email address on it.
2. **Git Bash rewrites a leading slash.** `/projects/uh` arrives as
   `C:/Program Files/Git/projects/uh`, and the only symptom is a blank page.
   Paths are passed without the leading slash for that reason.
3. **A skipped `setCookie` is not the same as being signed out.** The browser
   profile outlives one run of the script, so the signed-out screens clear
   cookies rather than merely not setting them.
