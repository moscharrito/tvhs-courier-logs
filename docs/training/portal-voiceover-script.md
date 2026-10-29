# UH portals — voiceover script

Generated from the deck. The words beside each picture are the words spoken over it.

### Two portals, two levels

> University Health Pharmacy Courier has two portals. One is for the pharmacy, and one is for the site manager who runs dispatch. They are the same system, and they deliberately show different things. This goes through both, side by side, and finishes with how to reset a password.

### The short version

- A pharmacy sees its own counter. Only its own.
- A site manager sees the whole contract: every counter, every driver, every delivery.
- Neither sees what a driver is paid, except an administrator.
- What each person can do is decided by the server, not by hiding buttons.

> The short version is this. A pharmacy account sees its own counter and nothing else. A site manager sees the whole contract: every pharmacy, every driver, every delivery. And what each person is allowed to do is decided by the server, not by hiding a button on a screen. That matters, because a field a screen declines to draw is still in the response.

## The pharmacy portal

### What a pharmacy opens on

*Screen: `p1-deliveries.png`*

- Four counters: sent to us, still out, delivered, not delivered.
- Their own deliveries, live, refreshed while they watch.
- Click any counter to see the deliveries behind it.

> This is what the Vida pharmacy sees when they sign in. Four counters across the top: how many they sent us, how many are still out with a driver, how many are delivered, and how many were not. Those four add up to what they sent, so nothing is unaccounted for. Clicking any of them opens the deliveries behind it. The list is live; it refreshes while they are looking at it.

### Sending the daily list

*Screen: `p2-send-list.png`*

- Their own counter is the only one in the dropdown.
- Upload the spreadsheet they already produce — no new format.
- Nothing is created until they have seen the rows and confirmed.

> This is how the list reaches us. The pharmacy uploads the spreadsheet they already produce. Notice the pharmacy dropdown: Vida is the only entry in it. They cannot upload for another counter, and they cannot see another counter has uploaded. The file itself is never stored. It is read in memory, turned into deliveries, and discarded. And nothing is created until somebody has looked at the rows and confirmed them.

### The columns are theirs, not ours

- Nine pharmacies send nine different layouts. None is a specification.
- The app guesses the mapping from the header row and asks you to check it.
- Controlled, Photo ID and Signature flow all the way to the driver’s phone.
- Change a column and the preview must be re-read before you can import.

> The columns are the pharmacy’s own. Nine counters send nine different layouts, and none of them is a specification, so the app guesses the mapping from the header row and asks a person to check it. The ones worth checking every time are Controlled, Photo I D, and Signature required. Those three travel from the spreadsheet all the way to the driver’s phone and onto the proof of delivery. If you change a column after the preview, the app will not let you import until it has re-read the file: otherwise you would be confirming one thing and creating another.

### Their own numbers

*Screen: `p3-performance.png`*

- On time, late, failed — for their counter.
- Downloadable, for their own records.
- A proof of delivery for any delivery they sent.

> And they can see how we are doing for them: on time, late, failed, over whatever period they choose. They can download it, and they can pull the proof of delivery for any delivery they sent us. For a delivery another counter sent, the same page answers as if it did not exist. Not an error, not a refusal that confirms it is there. It simply is not theirs.

## The site manager portal

### What a site manager opens on

*Screen: `m1-home.png`*

- The whole contract, not one counter.
- Board, orders, performance, discrepancies, returns, drivers.
- Importing a list needs the admin role — a site manager is told so plainly.

> The site manager sees something quite different. Their role is named at the top: site manager. From here they reach the dispatch board, every order on the contract, performance, discrepancies, returns, and the drivers record. One thing they cannot do is import a list on a pharmacy’s behalf, and the page says so in words rather than hiding the panel, so nobody wonders where it went.

### The dispatch board

*Screen: `m2-board.png`*

- Unassigned work on the left, grouped by pharmacy.
- One lane per driver, with every stop on it.
- Counters for the day: in transit, delivered, failed, overdue.

> The dispatch board is where the day is run. On the left is work nobody has been given yet, grouped by the pharmacy it came from. Each driver gets a lane with their stops in the order they will drive them. Across the top are the counters for the whole day. A card can be dragged from the pool onto a lane, or moved between lanes, and every one of those moves is recorded.

### Planning the wave

*Screen: `m7-wave.png`*

- Groups the unassigned work into drivable runs.
- Suggests a driver for each — the one whose pharmacy it is.
- It proposes and stops. Nothing is assigned until you accept it.

> Rather than assigning five hundred deliveries by hand, the board can plan the wave. It groups the unassigned work into runs somebody can actually drive, keeps urgent work off the long loops, and puts a name against each run: the driver whose own pharmacy that run collects from. It says how many drivers are on shift and how many are on the roster, because those are different numbers. And it proposes and stops. Nothing is assigned until a person accepts it.

### Who drives from where

*Screen: `m3-roster.png`*

- Drivers grouped by their home pharmacy.
- A counter with nobody says so, in words.
- A default, not a restriction — anybody can cover anybody.

> This is the roster: which pharmacy each driver works from. It is grouped by counter on purpose, because the question you open it to answer is whether every counter is covered, and a list of twenty-three names in alphabetical order cannot answer that. A counter with nobody on it says so, in words. A home pharmacy is a default and not a fence: anybody can still be given any run, which is what covering a sick colleague looks like.

### The chain of custody

*Screen: `m5-custody.png`*

- Every hand-off, in the order it was recorded.
- Append-only: these rows cannot be edited or deleted.
- Who did it, who signed, and what was said about it.

> Open any delivery and the chain of custody is underneath it. Created when the pharmacy sent it, assigned when dispatch gave it to somebody, collected at the counter, arrived at the door, handed over. Each row names the person and, where somebody signed, their printed name. These rows cannot be edited and cannot be deleted. That is enforced by the database itself, not by a rule somebody remembers, which is what makes this usable in an audit.

### The drivers record

*Screen: `m6-drivers.png`*

- What each driver delivered, and what failed.
- A site manager sees the work. An administrator also sees the money.
- The money is removed by the server, not hidden by the screen.

> The drivers record shows what each driver delivered and what did not get through. A site manager sees the work; an administrator also sees what it comes to. The difference is made by the server, which leaves the money out of the response entirely for anybody who may not see it. That is deliberate: a figure a screen is trusted not to draw is a figure that leaks the first time somebody exports the spreadsheet.

## Resetting a password

### Start at the sign-in screen

*Screen: `r1-signin.png`*

- Works for both portals, and for the driver app.
- Nobody needs to ring us to change their own password.
- "Forgotten your password?" is underneath the sign-in box.

> Now, resetting a password. This works the same way for a pharmacy account, for a site manager, and for a driver on their phone. Start at the sign-in screen and choose, forgotten your password, underneath the box.

### The address, not the username

*Screen: `r2-forgot.png`*

- Type the email address the office holds for you.
- For a driver that is usually the same as their username. For a pharmacy it is not.
- The screen answers the same way whether or not the address is known.

> Type the email address the office has for you. For a driver that is usually the same as the username they sign in with. For a pharmacy counter it is not: the username is something like u h dot vida, and the address is a mailbox at the pharmacy. The screen gives the same answer whether or not the address is known to us. That is on purpose, so that nobody can use this page to find out who has an account.

### The code and the new password

*Screen: `r3-code.png`*

- Six digits. Fifteen minutes. Works once.
- Set the new password on the same screen.
- Every device is signed out, including a phone PIN.

> A six digit code arrives by email. It lasts fifteen minutes and it works once. Type it in, choose a new password on the same screen, and that is it. Setting a new password signs every device out, including a driver’s phone P I N, so a driver will need to set that up again afterwards. If nothing arrives, check the address you typed, then ring the office, who can reset it for you.

### Before go-live: two things to know

- An account with no email address on file cannot use this at all.
- It will still say "a code is on its way". Nothing is sent, and nothing reports it.
- The nine pharmacy counter logins have no address yet. Ring the office until they do.
- The office can always reset a password directly.

> Two things to know before go-live. The reset finds an account by its email address, so an account with no address on file cannot use it at all. It will still say a code is on its way, because that message is deliberately the same either way, and nothing anywhere reports that nothing was sent. As of today the nine University Health counter logins have no address on them. Until they do, ring the office for a reset. The office can always set a password directly.

### In one line each

- Pharmacy: your counter, your lists, your numbers, your proofs of delivery.
- Site manager: the whole contract, the board, the roster, the custody record.
- Password: the address the office holds, a six digit code, fifteen minutes.
- Anything that looks wrong — ring the office. Nothing here is a one-way door.

> In one line each. A pharmacy sees its own counter, its own lists, its own numbers and its own proofs of delivery. A site manager sees the whole contract: the board, the roster, and the custody record behind every delivery. And a password reset needs the address the office holds for you, a six digit code, and fifteen minutes. If anything looks wrong, ring the office. Nothing in here is a one way door.
