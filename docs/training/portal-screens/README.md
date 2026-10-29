# Portal screens

Captured from the running app on 29 October 2026 at 1920x1080 — not mocked,
not drawn. What is in them is what the portal does.

## Whose screen is whose

The thing to keep straight, because the first cut of the training deck did
not: **the client has two portals, and the dispatch board is not one of
them.**

- **University Health** — the contract manager, and the eight counters.
- **Izy Global** — dispatch, the drivers, the board, the roster. Our side.

A client never opens a dispatch screen to run this contract, so the `m*`
files below are for our own training and for answering "what do you actually
do with our list", not for a client deck.

## The contract manager (`uh.manager`)

Sees every counter, and holds the counter passwords.

| | |
|---|---|
| `c1-manager-deliveries.png` | All eight counters together, or filtered to one |
| `c2-manager-performance.png` | On time, late, failed across the contract |
| `c3-manager-logins.png` | **Set a new password for any of their own pharmacies** |
| `c4-manager-sendlist.png` | Sending a list on a counter's behalf |

## One pharmacy counter (`uh.vida`)

Sees its own work and nothing else.

| | |
|---|---|
| `p1-deliveries.png` | Sent to us · still out · delivered · not delivered |
| `p2-send-list.png` | Sending the daily list. **Their own pharmacy is the only entry in the dropdown** |
| `p3-performance.png` | On time, late and failed, for their counter only |

## Getting back in (signed out)

| | |
|---|---|
| `r1-signin.png` | Where it starts |
| `r2-forgot.png` | The address, not the username |
| `r3-code.png` | Six digits and the new password, on one screen |

## Izy Global's own screens

Not in the client deck. Useful for our training and for the one slide that
explains what happens to a list after it is sent.

| | |
|---|---|
| `m1-home.png` | The project page a site manager opens on |
| `m2-board.png` | The dispatch board |
| `m7-wave.png` | Planning the wave |
| `m3-roster.png` | Which pharmacy each driver works from |
| `m4-orders.png` | Every order on the contract |
| `m5-custody.png` | One delivery's chain of custody |
| `m6-drivers.png` | The drivers record |

## The patient data in these is invented

Every recipient, address and prescription reference was made up for a
rehearsal on this laptop. No real patient appears in any of them.

**The driver names in `m3-roster.png` are not invented.** That screen, and
`m6-drivers.png` and `m2-board.png`, carry real staff names — which is why
every `.png` here is gitignored and the files are handed over directly.

## How they were taken, so they can be retaken

The browser pane caps a screenshot at its own width — 513 pixels here — so
these come from headless Edge driven over CDP, which gives true 1920x1080.
A session cookie cannot be passed on a command line, so the script signs in
through the API and sets the cookie over the wire before the first
navigation. Three things cost time:

1. **Attach to a tab of your own.** Taking `targets[0]` photographed Edge's
   own "we are syncing your browsing data" interstitial, with the signed-in
   person's email address on it.
2. **Git Bash rewrites a leading slash.** `/projects/uh` arrives as
   `C:/Program Files/Git/projects/uh`, and the only symptom is a blank page.
   Paths are passed without the leading slash for that reason.
3. **A skipped `setCookie` is not the same as being signed out.** The browser
   profile outlives one run, so the signed-out screens clear cookies rather
   than merely not setting them.
