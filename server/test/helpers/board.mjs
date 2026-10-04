/* The board as a screen, from the board as a wire.
 *
 * The endpoint used to embed each order inside the lane stop and the pool
 * entry that showed it. It now sends the cards once, in a map keyed by id,
 * and has the pool and the lanes point at them, so that a poll carrying a
 * cursor can leave out the ones that did not move.
 *
 * The tests that were written against the old shape are asking real questions
 * about the board, not about its serialisation: is this order in the pool and
 * on a lane at once, does the current stop advance, does a filter narrow both
 * sides together. Rewriting them in terms of id lookups would have buried
 * those questions in bookkeeping.
 *
 * So this puts the cards back, exactly as web/src/lib/board.ts does for the
 * browser, and those tests keep asking what they were asking. The wire shape
 * itself has its own file: test/board-delta.test.mjs.
 */

/**
 * Put the cards back where they are shown.
 *
 * Pass a board response body. A body with no `orders` map is returned
 * untouched, so this is safe to apply to an error response or to anything
 * that is not a board.
 */
export function rehydrateBoard(body) {
    if (body === null || typeof body !== 'object' || body.orders === undefined) return body;

    const card = (id) => body.orders[String(id)] ?? null;

    const pool = (body.pool ?? []).map((p) => ({
        site: p.site,
        orders: p.orderIds.map(card).filter((o) => o !== null),
        overdue: p.overdue,
    }));

    const lanes = (body.lanes ?? []).map((lane) => {
        const stops = lane.stops
            .map((st) => ({ sequence: st.sequence, order: card(st.orderId) }))
            .filter((st) => st.order !== null);
        const current = lane.currentStopOrderId === null ? null : card(lane.currentStopOrderId);
        const { currentStopOrderId: _c, ...rest } = lane;
        return {
            ...rest,
            stops,
            currentStop: current === null
                ? null
                : { sequence: stops.find((st) => st.order.id === current.id)?.sequence ?? 0, order: current },
        };
    });

    return { ...body, pool, lanes };
}

/** A supertest response with its board body rehydrated, status and headers
 *  intact, so a caller can keep reading `.status` and `.body`. */
export function asScreen(res) {
    return { status: res.status, headers: res.headers, body: rehydrateBoard(res.body) };
}
