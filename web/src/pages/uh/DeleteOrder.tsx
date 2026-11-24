/* Asking twice before an order is destroyed, in one place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE, which is the argument order-delete.ts makes on
 * the server and for the same reason:
 *
 *     "Listed rather than discovered, so adding a table that references
 *      orders and forgetting this list is a failed DELETE in a test rather
 *      than a row left pointing at nothing in production."
 *
 * Two copies of a warning is the drift, built in. The take-an-order panel
 * has had this control since 4 November; the dispatch board wanted the same
 * thing on 24 November, under "Assign to...". A second copy would have been
 * fifteen lines of prose about permanence that nobody would diff again, on
 * the one action in this product that cannot be undone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT DO: the request.
 *
 * Each screen keeps its own busy flag, its own message line and its own
 * idea of what to reload afterwards -- the board re-reads the whole board,
 * the order panel re-runs its search. Pulling that in here would mean a
 * component that knows about both, which is how a shared thing becomes two
 * things wearing one name. This owns the wording and the two steps; the
 * caller owns the consequence.
 *
 * THE STATUS IS IN THE SENTENCE because deleting a delivered stop is a
 * different act from deleting one nobody has touched, and only the person
 * reading it can tell which this is. A single order is not a list: the
 * thing about to be destroyed fits on the screen, so it is shown rather
 * than warned about in the abstract.
 */

import { useState } from 'react';

/** What the server says went, once it has gone. */
export interface Removed {
    id: number;
    was: { reference: string; status: string };
    onInvoices: string[];
    filesDeleted: number;
    runsRemoved: number;
}

/**
 * The sentence to put on the screen afterwards.
 *
 * The invoice and photograph clauses are the two consequences a person does
 * not see coming when they click Delete on a row, so they are reported
 * rather than left in an audit log: an issued invoice is now short a line,
 * and the proof somebody signed for is gone from the bucket.
 */
export function describeRemoval(gone: Removed): string {
    const invoiced = gone.onInvoices.length > 0
        ? ` It was on ${gone.onInvoices.length === 1 ? 'an invoice' : 'invoices'}, which is now short a line.`
        : '';
    const files = gone.filesDeleted > 0
        ? ` ${gone.filesDeleted} ${gone.filesDeleted === 1 ? 'photograph' : 'photographs'} went with it.`
        : '';
    return `Order ${gone.id}${gone.was.reference ? ` (${gone.was.reference})` : ''} `
        + `deleted permanently.${invoiced}${files}`;
}

/**
 * Delete, then confirm. Never one click.
 *
 * `onDelete` runs only after the second press. It is given nothing: the
 * caller already knows which order this is, and handing it back an id it
 * supplied invites a second source of truth about which row is going.
 */
export function DeleteOrderControl({ orderId, recipientName, status, disabled, onDelete }: {
    orderId: number;
    recipientName: string;
    status: string;
    disabled?: boolean;
    onDelete: () => void | Promise<void>;
}) {
    const [confirming, setConfirming] = useState(false);

    if (!confirming) {
        return (
            <button
                className="izy-btn secondary"
                type="button"
                disabled={disabled}
                /* NAMED, because a screen reader hearing "Delete" nine times
                   down a pool of waiting orders is told nothing about which
                   one it is standing on. */
                aria-label={`Delete order ${orderId} for ${recipientName}`}
                onClick={() => setConfirming(true)}
            >
                Delete
            </button>
        );
    }

    /* ── IT STACKS, AND THAT IS ABOUT THE COLUMN RATHER THAN THE WORDING.
     *
     * On the dispatch board this lives in the third track of a CSS grid,
     * one row per waiting order, and the track sizes to its content. Laid
     * out in a line, the row being confirmed grew its own column by three
     * hundred pixels and stopped lining up with the five rows around it --
     * the select above it stretched with it, which reads as a rendering
     * fault rather than as a question. Block, and the column does not
     * move: only this row gets taller. */
    return (
        <span className="izy-confirm-delete">
            <span className="izy-muted">
                Delete #{orderId} for {recipientName}
                {status === 'delivered' || status === 'failed'
                    ? `, which is already ${status}, `
                    : ' '}
                permanently? There is no undo.
            </span>
            <span className="izy-confirm-delete-do">
                <button className="izy-btn danger" type="button" disabled={disabled} onClick={() => { void onDelete(); }}>
                    Delete permanently
                </button>
                <button className="izy-btn secondary" type="button" disabled={disabled} onClick={() => setConfirming(false)}>
                    Keep
                </button>
            </span>
        </span>
    );
}
