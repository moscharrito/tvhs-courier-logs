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
