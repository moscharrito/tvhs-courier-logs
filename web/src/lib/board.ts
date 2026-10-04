/* Putting the board back together.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE WIRE SHAPE AND THE SCREEN SHAPE ARE DIFFERENT NOW.
 *
 * A poll used to carry the whole board, 361 KB of it, three quarters being
 * seven hundred and fifty cards that had been sent fifteen seconds earlier
 * unchanged. So the server now sends the cards in their own map and has the
 * pool and the lanes point at them by id, and with `?since=` it sends only
 * the cards that moved.
 *
 * This is the one place that knows about that. It takes what arrived, merges
 * it over what we already had, and hands back exactly the structure the board
 * has always rendered: lanes whose stops carry an order, pools whose entries
 * carry orders. Six hundred lines of rendering did not have to learn about
 * any of this, which is the point of doing it here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A HOLE IS SOMETHING WE CAN SEE, AND THAT IS THE WHOLE SAFETY ARGUMENT.
 *
 * The membership always arrives in full: every id in the pool and on every
 * lane, every poll, delta or not. So if an id arrives that we hold no card
 * for, that is not a silent gap, it is a detectable one. `missing` names
 * them, the caller refetches without a cursor, and the board is whole again
 * on the next tick.
 *
 * The alternative, rendering a placeholder, would put a card on a dispatch
 * board that says less than the truth. Dropping it for one tick and refilling
 * is the lesser harm: a card that is briefly absent gets noticed, a card that
 * is quietly wrong does not.
 *
 * Generic over the card, deliberately. This file has no business knowing what
 * is on one, and the page that renders them keeps that type.
 */

export interface SiteRef { id: number; code: string; name: string }

/** What the server sends. Cards by id; everything else points at them.
 *
 *  Generic over the courier and activity shapes as well as the card, so that
 *  this file still knows nothing about any of them and the page that renders
 *  them keeps its own types. Defaulting them to unknown would push `unknown`
 *  out into six hundred lines of JSX. */
export interface BoardWire<TCard, TCourier, TActivity> {
    serviceDate: string;
    generatedAt: string;
    timezone: string;
    summary: Record<string, number>;
    carrying: { shown: number; of: number; limit: number; truncated: boolean };
    bySite: Array<{ site: SiteRef; total: number; open: number; overdue: number }>;
    /** Cards by id, as strings because that is what JSON object keys are. */
    orders: Record<string, TCard>;
    /** Hand back as `?since=`. Null when the day holds no orders. */
    cursor: string | null;
    /** True when `orders` holds every card the membership references. */
    complete: boolean;
    pool: Array<{ site: SiteRef; orderIds: number[]; overdue: number }>;
    lanes: Array<{
        run: { id: number; courierUsername: string; serviceDate: string; label: string; status: string; startedAt: string | null };
        courier: TCourier;
        stops: Array<{ sequence: number; orderId: number }>;
        currentStopOrderId: number | null;
        counts: { total: number; remaining: number; done: number; overdue: number };
    }>;
    couriers: TCourier[];
    idleCouriers: TCourier[];
    activity: TActivity[];
}

/** What the page renders: the cards put back where they are shown. */
export interface BoardView<TCard, TCourier, TActivity>
    extends Omit<BoardWire<TCard, TCourier, TActivity>, 'pool' | 'lanes' | 'orders'> {
    pool: Array<{ site: SiteRef; orders: TCard[]; overdue: number }>;
    lanes: Array<Omit<BoardWire<TCard, TCourier, TActivity>['lanes'][number], 'stops' | 'currentStopOrderId'> & {
        stops: Array<{ sequence: number; order: TCard }>;
        currentStop: { sequence: number; order: TCard } | null;
    }>;
}

export interface Merged<TCard, TCourier, TActivity> {
    view: BoardView<TCard, TCourier, TActivity>;
    /** The cache to pass into the next merge. */
    cards: ReadonlyMap<number, TCard>;
    /** Ids the membership referenced that no card was held for. Non-empty
     *  means refetch without a cursor; see the note at the top. */
    missing: number[];
    /** The cursor to send next, or null to ask for everything. */
    cursor: string | null;
}

/**
 * Merge a poll over the cards already held.
 *
 * `held` is the previous call's `cards`, or an empty map on a first load. A
 * `complete` response replaces the cache rather than adding to it, so a card
 * that has left the board does not sit in memory for the rest of the day.
 */
export function mergeBoard<TCard extends { id: number }, TCourier, TActivity>(
    wire: BoardWire<TCard, TCourier, TActivity>,
    held: ReadonlyMap<number, TCard> = new Map(),
): Merged<TCard, TCourier, TActivity> {
    /* A complete board is the authority on what exists; a delta is only an
       update to it. Rebuilding from empty on a complete poll is what stops
       this growing all day. */
    const cards = new Map<number, TCard>(wire.complete ? [] : held);
    for (const card of Object.values(wire.orders)) cards.set(card.id, card);

    const missing: number[] = [];
    const take = (id: number): TCard | null => {
        const card = cards.get(id);
        if (card === undefined) {
            missing.push(id);
            return null;
        }
        return card;
    };

    const pool = wire.pool.map((p) => ({
        site: p.site,
        orders: p.orderIds.map(take).filter((c): c is TCard => c !== null),
        overdue: p.overdue,
    }));

    const lanes = wire.lanes.map((lane) => {
        const stops = lane.stops
            .map((st) => ({ sequence: st.sequence, order: take(st.orderId) }))
            .filter((st): st is { sequence: number; order: TCard } => st.order !== null);
        const currentOrder = lane.currentStopOrderId === null ? null : cards.get(lane.currentStopOrderId) ?? null;
        /* The sequence the server picked, not the first survivor: if the
           current stop's card is the one we are missing, there is no honest
           answer and null is better than pointing at a different stop. */
        const currentStop = currentOrder === null
            ? null
            : { sequence: stops.find((st) => st.order.id === currentOrder.id)?.sequence ?? 0, order: currentOrder };
        const { stops: _s, currentStopOrderId: _c, ...rest } = lane;
        return { ...rest, stops, currentStop };
    });

    const { pool: _p, lanes: _l, orders: _o, ...rest } = wire;

    return {
        view: { ...rest, pool, lanes },
        cards,
        /* Deduped: one card can be referenced from more than one place, and
           reporting it twice would say nothing extra. */
        missing: [...new Set(missing)],
        cursor: wire.cursor,
    };
}
