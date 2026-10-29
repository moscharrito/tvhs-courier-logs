/* Turning the noon wave into routes somebody can drive.
 *
 * Ticket 7.9.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM, IN THE CONTRACT'S OWN NUMBERS.
 *
 * Nine pharmacies release their lists by noon. An average day is 937
 * deliveries and a Tuesday is 1,417 (docs/volume-2026-h1.md). Until now the
 * dispatch board put all of them in one unassigned pool and a dispatcher
 * moved them onto runs one at a time. That is not a noon wave, it is an
 * afternoon of clicking, and docs/dispatch-strategy-reference.md says as
 * much: "bulk import and bulk assignment come before any per-order screen
 * polish".
 *
 * This module does the deciding. It takes a day's orders and says which ones
 * belong together. It touches no database and no network, which is the whole
 * reason it is testable against a Tuesday.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ZIP AND NOT COORDINATES.
 *
 * Because there are no coordinates and there are not going to be any before
 * go-live. `orders.lat` and `orders.lng` exist and stay null: a patient's
 * delivery address is protected health information, Google Maps Platform is
 * not covered by Google's BAA, and core/geo/provider.ts refuses in code to
 * send one anywhere it is not scoped for. AWS Location Service is the
 * intended answer and it is ticket 0.10's decision to make, not this one's.
 *
 * So the geography available here is the destination ZIP, and that turns out
 * to be enough to be useful. 185 ZIPs carry the contract, but 13 of them
 * carry half the deliveries and 29 carry 80 percent. The busiest four --
 * 78207 at 55 a day, 78228 at 52, 78237 at 52, 78223 at 49 -- are each more
 * than a driver's morning on their own. A ZIP is a contiguous postal area,
 * it is already on every order, and it is already the unit Addendum 2 clause
 * 2 prices by. Grouping by it is coarse and it is real, which beats precise
 * and invented.
 *
 * NO ADJACENCY TABLE, AND THAT IS DELIBERATE. The obvious next move is "and
 * then merge neighbouring ZIPs", which needs to know which ZIPs touch. We do
 * not have that and nothing in the repo does. Guessing it from the numbers
 * -- 78207 must be next to 78208 -- is wrong often enough to route a driver
 * across the county, and a wrong answer delivered confidently is worse here
 * than a coarse one. What we do have is `orders.zone`, the ZIP's distance
 * band from the pickup site, and two ZIPs in the same zone off the same
 * pharmacy really are both within that band of it. That is the proximity
 * signal this uses. When ticket 0.10 lands a HIPAA-eligible geocoder, real
 * adjacency slots in behind the same function signature.
 *
 * The unit packed is the (pharmacy, ZIP) pair rather than the ZIP, because a
 * busy ZIP is served by more than one counter and a run that collects from
 * four of them spends its morning being badged in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STAT COMES OUT FIRST, BEFORE ANY OF THAT.
 *
 * A STAT carries two deadlines and both bind: two hours overall from the
 * request, and one hour from pickup. A STAT dropped into a forty-stop loop
 * breaches the inner clock on the way to the eleventh stop, and it does so
 * invisibly, because the run as a whole still looks like it is running to
 * time. So STATs are pulled out before anything is packed and come back as
 * their own short runs. This is the one rule here that is about the contract
 * rather than about efficiency, and it is why it runs first.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT REFUSES TO PRETEND THE DAY FITS.
 *
 * Eighteen drivers at forty stops each is 720 stops. An average day is 937.
 * The arithmetic does not close on most days and it is not this module's job
 * to hide that: when there are more orders than the fleet can carry, the
 * orders that did not fit come back in `unplaced` with a reason, and the
 * proposal says how many more drivers the day actually needs.
 *
 * The alternative is runs of eighty stops that look like a plan at noon and
 * are a breach by four o'clock. A dispatcher who can see at 12:05 that today
 * needs six more drivers can do something about it. One who finds out at
 * 16:00 cannot.
 */

/** One order, reduced to what clustering cares about. */
export interface Clusterable {
    id: number;
    /** The pharmacy it is collected from. */
    siteId: number;
    /** Destination ZIP. Never empty: the column is NOT NULL. */
    zip: string;
    /** Distance band from the pickup site, or null when the ZIP is unmapped. */
    zone: number | null;
    /** ISO, or null when no deadline has been stamped yet. */
    dueAt: string | null;
    serviceType: string;
}

export interface ClusterSettings {
    /** Couriers available to carry the day. */
    drivers: number;
    /**
     * Stops one courier can complete in a day.
     *
     * Forty, from the offer letter's own illustration: 40 stops at 11 to 12
     * minutes each is 7.3 to 8 hours, which is a full day and not a
     * stretch target.
     */
    maxStopsPerRun: number;
    /**
     * Pharmacies one run may collect from.
     *
     * Two. Drivers do not have independent access to University Health
     * facilities: at every site a lead badges them in, retrieves the
     * packages and escorts them out, and where several drivers are assigned
     * to one site they wait outside until called. Each extra pharmacy on a
     * run is another one of those, so a run spanning five sites spends the
     * morning in car parks.
     */
    maxSitesPerRun: number;
    /** Stops on a STAT run. STATs are driven more or less directly. */
    maxStopsPerStatRun: number;
}

export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = {
    drivers: 18,
    maxStopsPerRun: 40,
    maxSitesPerRun: 2,
    maxStopsPerStatRun: 4,
};

export interface ProposedRun {
    /** 'stat' runs are the pulled-out urgent work; 'standard' is the wave. */
    kind: 'stat' | 'standard';
    /** In the order they should be driven: by deadline, soonest first. */
    orderIds: number[];
    /** Destination ZIPs on this run, for the dispatcher to recognise it by. */
    zips: string[];
    /** Pharmacies this run collects from. */
    siteIds: number[];
    /** The soonest deadline on the run, which is the one that bites. */
    earliestDueAt: string | null;
}

export interface Unplaced {
    orderId: number;
    why: 'no_driver_left';
}

export interface Proposal {
    runs: ProposedRun[];
    /** Never silently dropped. Every order is in a run or in here. */
    unplaced: Unplaced[];
    /** Plain sentences for the dispatcher, not codes. */
    notes: string[];
    /** Drivers this day would need at the configured capacity. */
    driversNeeded: number;
}

/** Soonest deadline first. A null deadline sorts last: it is not urgent, it
 *  is unstamped, and putting it first would push real deadlines back. */
function byDue(a: Clusterable, b: Clusterable): number {
    if (a.dueAt === null && b.dueAt === null) return a.id - b.id;
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    if (a.dueAt === b.dueAt) return a.id - b.id;
    return a.dueAt < b.dueAt ? -1 : 1;
}

const earliest = (orders: Clusterable[]): string | null =>
    orders.reduce<string | null>(
        (soonest, o) => (o.dueAt !== null && (soonest === null || o.dueAt < soonest) ? o.dueAt : soonest),
        null,
    );

/** A run built from a settled list of orders, sequenced by deadline. */
function runOf(kind: 'stat' | 'standard', orders: Clusterable[]): ProposedRun {
    const sorted = [...orders].sort(byDue);
    return {
        kind,
        orderIds: sorted.map((o) => o.id),
        /* Sorted so two runs over the same ZIPs read the same, and unique so
           a forty-stop run in one ZIP does not list it forty times. */
        zips: [...new Set(sorted.map((o) => o.zip))].sort(),
        siteIds: [...new Set(sorted.map((o) => o.siteId))].sort((a, b) => a - b),
        earliestDueAt: earliest(sorted),
    };
}

/**
 * A day's orders, grouped into runs somebody can drive.
 *
 * Pure: no database, no network, no clock. Give it the same orders twice and
 * it answers the same way, which is what makes a Tuesday a test case.
 */
export function proposeRuns(
    orders: Clusterable[],
    settings: ClusterSettings = DEFAULT_CLUSTER_SETTINGS,
): Proposal {
    const notes: string[] = [];
    const runs: ProposedRun[] = [];

    if (orders.length === 0) {
        return { runs: [], unplaced: [], notes: ['Nothing to route yet.'], driversNeeded: 0 };
    }

    /* ── 1. STAT, out of the way first ──────────────────────────────── */
    const stat = orders.filter((o) => o.serviceType === 'stat');
    const rest = orders.filter((o) => o.serviceType !== 'stat');

    /* BY PHARMACY, AND THEN IN FOURS.

       Not just in fours. A Tuesday found this one: chunking the STAT list
       as it came produced a four-stop run collecting from four different
       counters, each with its own escorted badge-in, against a clock of one
       hour from pickup. A STAT run collects at one pharmacy. */
    const statBySite = new Map<number, Clusterable[]>();
    for (const o of [...stat].sort(byDue)) {
        const got = statBySite.get(o.siteId);
        if (got) got.push(o);
        else statBySite.set(o.siteId, [o]);
    }
    for (const [, atSite] of [...statBySite.entries()].sort((a, b) => a[0] - b[0])) {
        for (let i = 0; i < atSite.length; i += settings.maxStopsPerStatRun) {
            runs.push(runOf('stat', atSite.slice(i, i + settings.maxStopsPerStatRun)));
        }
    }
    if (stat.length > 0) {
        notes.push(
            `${stat.length} STAT ${stat.length === 1 ? 'delivery is' : 'deliveries are'} on `
            + `${runs.length} short ${runs.length === 1 ? 'run' : 'runs'} of their own. A STAT has one hour `
            + 'from pickup as well as two from the request, and it cannot hold that inside a full loop.',
        );
    }

    /* ── 2. The wave, by ZIP, biggest first ─────────────────────────── */
    /* Biggest first so the ZIPs that are a run on their own take whole runs
       and the remainder is small enough to combine sensibly. Filling with
       the small ones first strands the big ones across every run. */
    /* THE UNIT IS (PHARMACY, ZIP), NOT ZIP.

       Grouping by ZIP alone was wrong and a Tuesday found it: 78207 is
       served by several counters, so one ZIP group arrived carrying four
       pharmacies, and a group that becomes a run on its own never passes
       through the merge check that enforces the site limit. The result was
       a run with four escorted badge-ins on it.

       A delivery is collected at one site and goes to one ZIP. That pair is
       the smallest thing that cannot be split by either constraint, so it
       is what gets packed. */
    const byPlace = new Map<string, Clusterable[]>();
    for (const o of rest) {
        const key = `${o.siteId}|${o.zip}`;
        const got = byPlace.get(key);
        if (got) got.push(o);
        else byPlace.set(key, [o]);
    }
    const groups = [...byPlace.entries()]
        .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))
        .map(([, list]) => list);

    /* ── 3. Pack ────────────────────────────────────────────────────── */
    /* An open run is one still taking stops. A group joins the first open
       run it fits in: capacity, and the pharmacy limit, which is the real
       constraint because every extra site is another escorted badge-in. */
    interface Open { orders: Clusterable[]; sites: Set<number>; zones: Set<number | null> }
    const open: Open[] = [];

    const fits = (run: Open, group: Clusterable[]): boolean => {
        if (run.orders.length + group.length > settings.maxStopsPerRun) return false;
        const sites = new Set(run.sites);
        for (const o of group) sites.add(o.siteId);
        if (sites.size > settings.maxSitesPerRun) return false;
        /* Same distance band from the pickup, which is the only proximity
           we can honestly claim. An unmapped ZIP (zone null) combines only
           with other unmapped ones rather than being assumed near. */
        const zones = new Set(run.zones);
        for (const o of group) zones.add(o.zone);
        return zones.size <= 1;
    };

    for (const group of groups) {
        /* A ZIP bigger than one run becomes whole runs of itself, and the
           remainder goes back through the normal path. 78207 at 55 a day is
           a run and a bit, every day. */
        let remaining = group;
        while (remaining.length > settings.maxStopsPerRun) {
            const full = remaining.slice(0, settings.maxStopsPerRun);
            open.push({
                orders: full,
                sites: new Set(full.map((o) => o.siteId)),
                zones: new Set(full.map((o) => o.zone)),
            });
            remaining = remaining.slice(settings.maxStopsPerRun);
        }
        if (remaining.length === 0) continue;

        const home = open.find((run) => fits(run, remaining));
        if (home) {
            for (const o of remaining) { home.orders.push(o); home.sites.add(o.siteId); home.zones.add(o.zone); }
        } else {
            open.push({
                orders: [...remaining],
                sites: new Set(remaining.map((o) => o.siteId)),
                zones: new Set(remaining.map((o) => o.zone)),
            });
        }
    }

    /* ── 4. Staff it, and say so when it does not fit ───────────────── */
    /* STAT runs are already committed: they are the ones with a deadline
       that cannot move, so they take their drivers first. */
    const statRuns = runs.length;
    const standard = open
        .map((run) => runOf('standard', run.orders))
        /* Soonest deadline first, so when the fleet runs out it is the
           slackest work that goes unplaced rather than whatever happened to
           be packed last. */
        .sort((a, b) => {
            if (a.earliestDueAt === null && b.earliestDueAt === null) return 0;
            if (a.earliestDueAt === null) return 1;
            if (b.earliestDueAt === null) return -1;
            return a.earliestDueAt < b.earliestDueAt ? -1 : 1;
        });

    const seats = Math.max(0, settings.drivers - statRuns);
    const staffed = standard.slice(0, seats);
    const overflow = standard.slice(seats);

    runs.push(...staffed);

    const unplaced: Unplaced[] = overflow.flatMap((run) =>
        run.orderIds.map((orderId) => ({ orderId, why: 'no_driver_left' as const })));

    const driversNeeded = statRuns + standard.length;
    if (unplaced.length > 0) {
        notes.push(
            `${unplaced.length} ${unplaced.length === 1 ? 'delivery has' : 'deliveries have'} no driver. `
            + `Today needs ${driversNeeded} and ${settings.drivers} ${settings.drivers === 1 ? 'is' : 'are'} `
            + `available, so ${driversNeeded - settings.drivers} more `
            + `${driversNeeded - settings.drivers === 1 ? 'is' : 'are'} needed at ${settings.maxStopsPerRun} `
            + 'stops each. Nothing is assigned until you accept this.',
        );
    }

    const unmapped = rest.filter((o) => o.zone === null).length;
    if (unmapped > 0) {
        notes.push(
            `${unmapped} ${unmapped === 1 ? 'delivery is' : 'deliveries are'} to a ZIP with no zone, so `
            + `${unmapped === 1 ? 'it was' : 'they were'} grouped apart rather than assumed nearby. `
            + 'Check the zone map covers them.',
        );
    }

    return { runs, unplaced, notes, driversNeeded };
}

/* ═══════════════════════════════════════════════ putting names on the runs
 *
 * WHY THIS IS A SECOND PASS AND NOT PART OF proposeRuns.
 *
 * proposeRuns answers "what are the runs", which is a question about the
 * day's orders and nothing else. Who drives them is a question about who
 * turned up. Keeping them apart means the grouping stays pure and testable
 * against a fixed list of orders -- a Tuesday is still a test case -- and
 * that a dispatcher can re-staff a plan without re-grouping it, which is
 * what happens when somebody rings in sick at 12:30.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SUGGESTION IS A DEFAULT. IT IS NOT AN ASSIGNMENT.
 *
 * Nothing here writes anything. It returns a name per run for the screen to
 * put in a dropdown, already selected, which the dispatcher changes or
 * accepts. That distinction is the whole design: twenty-three drivers is
 * too many to pick by hand every morning and far too few to let a function
 * dispatch unsupervised.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOME FIRST, THEN FLOATERS, THEN COVER -- IN THAT ORDER AND SAID OUT LOUD.
 *
 * University Health staffs by location. A driver hired at Southeast drives
 * from Southeast, and the run they should be offered is the one that
 * collects there. So:
 *
 *   home      their home pharmacy is on the run. The ordinary case.
 *   floater   no home pharmacy recorded, so they go anywhere.
 *   cover     somebody else's site, because nobody from that site is left.
 *
 * `cover` is deliberately last and deliberately named, because it is the
 * one a dispatcher should look at: it means a counter is short-handed, and
 * on a morning where that is news it is worth seeing before the wave goes
 * out rather than at four o'clock.
 */

/** One driver available to carry work, as the roster knows them. */
export interface RosterDriver {
    username: string;
    name: string;
    /** Their standing pharmacy, or null for a floater. */
    homeSiteId: number | null;
}

export interface Staffing {
    /** Parallel to the runs given: the driver for each, or null. */
    suggested: Array<{ username: string; name: string; why: 'home' | 'floater' | 'cover' } | null>;
    /** How many runs got nobody. */
    unstaffed: number;
    /** Drivers who were on the roster and were not needed. */
    spare: RosterDriver[];
    /** Plain sentences for the dispatcher, not codes. */
    notes: string[];
}

/**
 * Offer each proposed run to a driver, preferring their own pharmacy.
 *
 * Pure: no database, no network, no clock. One driver takes at most one run
 * -- a second wave is a second call, with whoever is left.
 */
export function staffProposal(runs: ProposedRun[], roster: readonly RosterDriver[]): Staffing {
    const notes: string[] = [];
    const suggested: Staffing['suggested'] = runs.map(() => null);

    if (roster.length === 0) {
        return {
            suggested,
            unstaffed: runs.length,
            spare: [],
            notes: runs.length === 0 ? [] : ['Nobody is on shift, so no run has a driver yet.'],
        };
    }

    const free = new Map(roster.map((d) => [d.username, d]));
    const take = (d: RosterDriver, why: 'home' | 'floater' | 'cover', at: number) => {
        free.delete(d.username);
        suggested[at] = { username: d.username, name: d.name, why };
    };

    /* STAT first, then soonest deadline. The order matters because the
       roster runs out: whatever is left unstaffed should be the slackest
       work on the board, never the hour-from-pickup run. Indices are
       carried along so `suggested` stays parallel to the caller's array. */
    const order = runs
        .map((run, index) => ({ run, index }))
        .sort((a, b) => {
            if (a.run.kind !== b.run.kind) return a.run.kind === 'stat' ? -1 : 1;
            const x = a.run.earliestDueAt;
            const y = b.run.earliestDueAt;
            if (x === null && y === null) return a.index - b.index;
            if (x === null) return 1;
            if (y === null) return -1;
            return x === y ? a.index - b.index : (x < y ? -1 : 1);
        });

    let cover = 0;
    for (const { run, index } of order) {
        const sites = new Set(run.siteIds);

        /* A driver whose own pharmacy is on this run. Among several, the
           one whose site is the run's ONLY site goes first: a run that
           collects at two counters is somebody's home either way, and
           giving it to the driver with no better option wastes the match. */
        const home = [...free.values()]
            .filter((d) => d.homeSiteId !== null && sites.has(d.homeSiteId))
            .sort((a, b) => a.username.localeCompare(b.username));
        if (home.length > 0) { take(home[0]!, 'home', index); continue; }

        const floater = [...free.values()]
            .filter((d) => d.homeSiteId === null)
            .sort((a, b) => a.username.localeCompare(b.username))[0];
        if (floater) { take(floater, 'floater', index); continue; }

        const anybody = [...free.values()].sort((a, b) => a.username.localeCompare(b.username))[0];
        if (anybody) { take(anybody, 'cover', index); cover += 1; continue; }

        /* Nobody left. Left null, counted below, never silently dropped. */
    }

    const unstaffed = suggested.filter((s) => s === null).length;
    if (unstaffed > 0) {
        notes.push(
            `${unstaffed} ${unstaffed === 1 ? 'run has' : 'runs have'} no driver: `
            + `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} and ${roster.length} `
            + `${roster.length === 1 ? 'driver' : 'drivers'} on shift. Nothing is assigned until you accept this.`,
        );
    }
    if (cover > 0) {
        notes.push(
            `${cover} ${cover === 1 ? 'run is' : 'runs are'} offered to a driver from another pharmacy, `
            + 'because nobody from that counter was left. Check the home pharmacy on those before you send them.',
        );
    }
    const spare = [...free.values()];
    if (spare.length > 0 && unstaffed === 0) {
        notes.push(
            /* NOT "on shift". This function is given a roster and does not
               know what kind it is: when nobody has tapped Go on shift the
               caller plans from the full driver list instead, and saying
               "31 drivers are on shift" directly under "Nobody is on shift"
               is a contradiction a dispatcher has to reason past. Found on
               29 October by reading the screen it produced. */
            `${spare.length} ${spare.length === 1 ? 'driver was' : 'drivers were'} not needed by this plan.`,
        );
    }

    return { suggested, unstaffed, spare, notes };
}
