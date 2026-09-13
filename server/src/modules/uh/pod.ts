/* The proof of delivery.
 *
 * Scope 1.2.8 names exactly what this document has to carry:
 *
 *   the date and time, the pickup location, the delivery location, the
 *   description and quantity, and the printed name and signature of the
 *   authorised sending AND receiving personnel.
 *
 * So the layout is built around those five, in that order, with the two
 * signatures side by side because that pairing is the point of the document.
 * Everything else on the page is supporting evidence: the chain of custody,
 * the packages, and whatever explains a delivery that did not happen.
 *
 * THE SIGNATURES ARE DRAWN, NOT DESCRIBED. They were captured as strokes in a
 * 0..1 space (ticket 2.4), which means they can be drawn at any size without
 * blurring, and it means this document renders the actual movement of the pen
 * rather than a sentence claiming somebody signed.
 *
 * A MISSING SIGNATURE IS SHOWN AS MISSING. An empty box with the reason under
 * it, never a blank space that could be mistaken for one that did not print.
 * A proof of delivery that hides its own gaps is not proof of anything.
 */

import type { Client } from '@libsql/client';
import { buildPdf, Page, PAGE, textWidth, toLatin, wrap, type Point } from '../../core/pdf/writer';

const MARGIN = 54;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

export interface PodPackage {
    description: string;
    quantity: number;
    signatureRequired: boolean;
    outcome: string;
    failureReason: string;
    failureNote: string;
}

export interface PodEvent {
    type: string;
    at: string;
    by: string;
    signedName: string;
    reason: string;
}

export interface PodSignature {
    /** Strokes as captured: points in a 0..1 space. */
    strokes: Array<Array<{ x: number; y: number }>>;
    signedName: string;
    capturedAt: string;
}

export interface PodData {
    orderId: number;
    reference: string;
    serviceType: string;
    serviceDate: string;
    timezone: string;
    /** Where it came from, and where it went (Scope 1.2.8). */
    pickupLocation: string;
    pickupAddress: string;
    deliveryName: string;
    deliveryAddress: string;
    status: string;
    receivedAt: string;
    dueAt: string | null;
    pickedUpAt: string | null;
    arrivedAt: string | null;
    deliveredAt: string | null;
    returnedAt: string | null;
    returnedTo: string;
    courier: string;
    receivedBy: string;
    noSignatureReason: string;
    failureReason: string;
    packages: PodPackage[];
    events: PodEvent[];
    pickupSignature: PodSignature | null;
    deliverySignature: PodSignature | null;
    /** A doorstep photo, when there is one and the file service can serve it. */
    photo: { available: boolean; note: string };
}

const EVENT_LABEL: Record<string, string> = {
    created: 'Order received', released: 'Released to dispatch', assigned: 'Assigned to a courier',
    unassigned: 'Taken off a courier', picked_up: 'Collected from the pharmacy',
    arrived: 'Courier arrived', delivered: 'Handed over', attempted: 'Could not deliver',
    returned: 'Returned to a pharmacy', cancelled: 'Cancelled', note: 'Note',
};

const STATUS_LABEL: Record<string, string> = {
    pending: 'Received', ready: 'Ready', assigned: 'Assigned', picked_up: 'In transit',
    delivered: 'Delivered', failed: 'Not delivered', cancelled: 'Cancelled',
};

/** A time a person can read, in the contract's timezone, labelled as such. */
export function stamp(iso: string | null, timezone: string): string {
    if (!iso) return '';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: 'short', day: '2-digit',
        hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(at);
}

/**
 * Fit captured strokes into a box, keeping their shape.
 *
 * The capture space is 0..1 in both axes and the box is wider than it is tall,
 * so scaling each axis independently would stretch a signature into something
 * that is not what the person drew. One scale factor for both, centred.
 * Y is flipped: the capture has y growing downward like a screen, PDF has it
 * growing upward.
 */
export function fitStrokes(
    strokes: Array<Array<{ x: number; y: number }>>,
    box: { x: number; y: number; width: number; height: number },
): Point[][] {
    const scale = Math.min(box.width, box.height);
    const offsetX = box.x + (box.width - scale) / 2;
    const offsetY = box.y + (box.height - scale) / 2;
    return strokes.map((stroke) => stroke
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({
            x: offsetX + Math.min(1, Math.max(0, p.x)) * scale,
            y: offsetY + (1 - Math.min(1, Math.max(0, p.y))) * scale,
        })));
}

/* ------------------------------------------------------------------ layout */

export function renderPod(data: PodData, now: Date = new Date()): Buffer {
    const page = new Page();
    let y = PAGE.height - MARGIN;

    /* Header. The document says what it is and which delivery it is about
     * before anything else, because it will be printed, filed and found again
     * by somebody who was not there. */
    page.text('Proof of delivery', MARGIN, y, { font: 'Helvetica-Bold', size: 18 });
    page.textRight('Izy Global Services LLC', PAGE.width - MARGIN, y, { font: 'Helvetica-Bold', size: 10 });
    page.textRight('University Health Pharmacy Courier', PAGE.width - MARGIN, y - 12, { size: 9, grey: 0.4 });
    y -= 26;
    page.text(
        `Delivery ${data.orderId}${data.reference ? `   Pharmacy reference ${data.reference}` : ''}`,
        MARGIN, y, { size: 10, grey: 0.3 },
    );
    y -= 8;
    page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.25, width: 1 });
    y -= 22;

    /* The five fields, labelled with the clause they come from so that anybody
     * checking the contract against the document can do it in one pass. */
    const half = CONTENT_WIDTH / 2 - 10;
    const leftX = MARGIN;
    const rightX = MARGIN + CONTENT_WIDTH / 2 + 10;

    const field = (label: string, value: string, x: number, top: number, width: number): number => {
        page.text(label.toUpperCase(), x, top, { size: 7, grey: 0.45 });
        let cursor = top - 12;
        for (const line of wrap(value || '-', 'Helvetica', 10, width)) {
            page.text(line, x, cursor, { size: 10 });
            cursor -= 12;
        }
        return cursor - 4;
    };

    const dateAndTime = data.deliveredAt
        ? stamp(data.deliveredAt, data.timezone)
        : data.arrivedAt
            ? `${stamp(data.arrivedAt, data.timezone)} (arrived; not delivered)`
            : stamp(data.receivedAt, data.timezone);

    const leftBottom = field('Date and time of delivery', dateAndTime, leftX, y, half);
    const rightBottom = field('Service', `${data.serviceType}  ·  ${STATUS_LABEL[data.status] ?? data.status}`, rightX, y, half);
    y = Math.min(leftBottom, rightBottom);

    const pickupBottom = field(
        'Pickup location',
        [data.pickupLocation, data.pickupAddress].filter(Boolean).join(', '),
        leftX, y, half,
    );
    const deliveryBottom = field(
        'Delivery location',
        [data.deliveryName, data.deliveryAddress].filter(Boolean).join(', '),
        rightX, y, half,
    );
    y = Math.min(pickupBottom, deliveryBottom) - 6;

    /* Description and quantity, one row per package, because a dry run is
     * billed per item and a part-delivered order has to show which part. */
    page.text('DESCRIPTION AND QUANTITY', MARGIN, y, { size: 7, grey: 0.45 });
    y -= 14;
    page.text('Qty', MARGIN, y, { font: 'Helvetica-Bold', size: 9 });
    page.text('Description', MARGIN + 34, y, { font: 'Helvetica-Bold', size: 9 });
    page.text('Signature required', MARGIN + 300, y, { font: 'Helvetica-Bold', size: 9 });
    page.text('Outcome', MARGIN + 420, y, { font: 'Helvetica-Bold', size: 9 });
    y -= 4;
    page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.75 });
    y -= 12;

    for (const pkg of data.packages) {
        page.text(String(pkg.quantity), MARGIN, y, { size: 10 });
        for (const [i, line] of wrap(pkg.description, 'Helvetica', 10, 250).entries()) {
            page.text(line, MARGIN + 34, y - i * 11, { size: 10 });
        }
        page.text(pkg.signatureRequired ? 'Yes' : 'No', MARGIN + 300, y, { size: 10 });
        page.text(pkg.outcome === 'pending' ? '-' : pkg.outcome, MARGIN + 420, y, { size: 10 });
        y -= 12 * Math.max(1, wrap(pkg.description, 'Helvetica', 10, 250).length);
        if (pkg.outcome === 'failed' && (pkg.failureReason || pkg.failureNote)) {
            const reason = [pkg.failureReason.replace(/_/g, ' '), pkg.failureNote].filter(Boolean).join(' - ');
            for (const line of wrap(reason, 'Helvetica', 9, CONTENT_WIDTH - 34)) {
                page.text(line, MARGIN + 34, y, { size: 9, grey: 0.35 });
                y -= 11;
            }
        }
        y -= 2;
    }
    y -= 8;
    page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.75 });
    y -= 22;

    /* The two signatures, side by side. This pairing is what Scope 1.2.8 is
     * actually asking for, so it gets the space. */
    const boxWidth = CONTENT_WIDTH / 2 - 12;
    const boxHeight = 74;
    const signatureBoxTop = y;

    const drawSignature = (
        title: string, signature: PodSignature | null, fallback: string, x: number,
    ) => {
        page.text(title.toUpperCase(), x, signatureBoxTop, { size: 7, grey: 0.45 });
        const boxY = signatureBoxTop - 12 - boxHeight;
        page.rect(x, boxY, boxWidth, boxHeight, { grey: 0.75 });
        if (signature && signature.strokes.length > 0) {
            for (const stroke of fitStrokes(signature.strokes, { x: x + 6, y: boxY + 6, width: boxWidth - 12, height: boxHeight - 12 })) {
                page.polyline(stroke);
            }
        } else {
            /* Said, not left blank: a gap on a proof of delivery has to read as
               a gap, not as a printing failure. */
            const message = fallback || 'Not captured';
            page.text(message, x + (boxWidth - textWidth(message, 'Helvetica', 9)) / 2, boxY + boxHeight / 2 - 3, { size: 9, grey: 0.5 });
        }
        let cursor = boxY - 14;
        page.text(signature?.signedName || fallback || '-', x, cursor, { font: 'Helvetica-Bold', size: 10 });
        cursor -= 11;
        page.text(
            signature ? stamp(signature.capturedAt, data.timezone) : '',
            x, cursor, { size: 9, grey: 0.4 },
        );
        return cursor - 12;
    };

    const senderBottom = drawSignature(
        'Sending personnel (printed name and signature)',
        data.pickupSignature,
        data.pickupSignature ? '' : 'No pickup signature',
        MARGIN,
    );
    const receiverBottom = drawSignature(
        'Receiving personnel (printed name and signature)',
        data.deliverySignature,
        data.noSignatureReason || (data.status === 'failed' ? 'Not delivered' : 'No signature captured'),
        MARGIN + CONTENT_WIDTH / 2 + 12,
    );
    y = Math.min(senderBottom, receiverBottom);

    if (data.noSignatureReason) {
        for (const line of wrap(`Left without a signature: ${data.noSignatureReason}`, 'Helvetica', 9, CONTENT_WIDTH)) {
            page.text(line, MARGIN, y, { size: 9, grey: 0.35 });
            y -= 11;
        }
    }
    if (data.status === 'failed' && data.failureReason) {
        for (const line of wrap(`Not delivered: ${data.failureReason.replace(/_/g, ' ')}`, 'Helvetica', 9, CONTENT_WIDTH)) {
            page.text(line, MARGIN, y, { size: 9, grey: 0.35 });
            y -= 11;
        }
    }
    if (data.returnedAt) {
        page.text(
            `Returned to ${data.returnedTo || 'a pharmacy'} at ${stamp(data.returnedAt, data.timezone)}`,
            MARGIN, y, { size: 9, grey: 0.35 },
        );
        y -= 11;
    }
    if (data.photo.note) {
        page.text(data.photo.note, MARGIN, y, { size: 9, grey: 0.35 });
        y -= 11;
    }
    y -= 10;

    /* The chain of custody. Last, because it is the supporting evidence rather
     * than the thing being proved, but complete, because a dispute is exactly
     * when somebody reads this far. */
    page.line(MARGIN, y, PAGE.width - MARGIN, y, { grey: 0.75 });
    y -= 14;
    page.text('CHAIN OF CUSTODY', MARGIN, y, { size: 7, grey: 0.45 });
    y -= 14;
    for (const event of data.events) {
        if (y < MARGIN + 40) {
            page.text('Continued in the full record held by Izy Global Services.', MARGIN, y, { size: 9, grey: 0.45 });
            break;
        }
        page.text(stamp(event.at, data.timezone), MARGIN, y, { size: 9, grey: 0.35 });
        page.text(EVENT_LABEL[event.type] ?? event.type, MARGIN + 130, y, { size: 9 });
        const detail = [event.by, event.signedName && `signed ${event.signedName}`, event.reason && event.reason.replace(/_/g, ' ')]
            .filter(Boolean).join('  ·  ');
        page.text(detail, MARGIN + 270, y, { size: 9, grey: 0.35 });
        y -= 12;
    }

    /* Footer: when this copy was produced and what it is. A printed document
     * outlives the screen it came from and gets quoted back at us. */
    page.line(MARGIN, MARGIN + 22, PAGE.width - MARGIN, MARGIN + 22, { grey: 0.8 });
    page.text(
        `Produced ${stamp(now.toISOString(), data.timezone)} from the chain of custody record. Service date ${data.serviceDate}.`,
        MARGIN, MARGIN + 10, { size: 8, grey: 0.45 },
    );
    page.textRight(`Delivery ${data.orderId}`, PAGE.width - MARGIN, MARGIN + 10, { size: 8, grey: 0.45 });

    return buildPdf([page], {
        title: `Proof of delivery ${data.orderId}`,
        // No patient name in the metadata: it shows in a reader's title bar and
        // in the file properties of anything this is forwarded to.
        subject: 'University Health Pharmacy Courier',
    }, now);
}

/* -------------------------------------------------------------- gathering */

/** A filename that names the delivery and nothing about the patient. */
export const podFilename = (orderId: number, serviceDate: string): string =>
    `proof-of-delivery-${orderId}-${toLatin(serviceDate)}.pdf`;

interface LoadOptions {
    projectId: number;
    orderId: number;
    timezone: string;
    /** Client viewers see a courier's first name; staff see the full record. */
    courierName: (username: string) => string;
    photoAvailable: boolean;
}

/**
 * Everything the document needs, in one place.
 *
 * Reads the signatures by the key on the custody event rather than by guessing
 * from the order: a pickup signature covers a batch, so several orders point at
 * the same row, and the event is what ties this order to that signature.
 */
export async function loadPodData(client: Client, opts: LoadOptions): Promise<PodData | null> {
    const orderRs = await client.execute({
        sql: `SELECT o.*, s.name AS site_name, s.address_line AS site_address, s.city AS site_city, s.zip AS site_zip,
                     r.name AS returned_site_name
              FROM orders o
              JOIN sites s ON s.id = o.site_id
              LEFT JOIN sites r ON r.id = o.returned_to_site_id
              WHERE o.project_id = ? AND o.id = ?`,
        args: [opts.projectId, opts.orderId],
    });
    const o = orderRs.rows[0];
    if (!o) return null;

    const packages = await client.execute({
        sql: `SELECT description, quantity, signature_required, outcome, failure_reason_code, failure_note
              FROM packages WHERE order_id = ? ORDER BY id`,
        args: [opts.orderId],
    });
    const events = await client.execute({
        sql: `SELECT type, at, actor, signed_name, signature_key, reason FROM custody_events
              WHERE order_id = ? ORDER BY at, id`,
        args: [opts.orderId],
    });

    /** The signature row a custody event points at, if any. */
    const signatureFor = async (type: string): Promise<PodSignature | null> => {
        const row = [...events.rows].reverse().find((e) => String(e['type']) === type && String(e['signature_key'] ?? '') !== '');
        if (!row) return null;
        const id = Number(String(row['signature_key']).replace('local:signature:', ''));
        if (!Number.isInteger(id)) return null;
        const rs = await client.execute({
            sql: 'SELECT signed_name, strokes, captured_at FROM signatures WHERE id = ?',
            args: [id],
        });
        const sig = rs.rows[0];
        if (!sig) return null;
        let strokes: Array<Array<{ x: number; y: number }>> = [];
        try {
            const parsed: unknown = JSON.parse(String(sig['strokes'] ?? '[]'));
            if (Array.isArray(parsed)) strokes = parsed as Array<Array<{ x: number; y: number }>>;
        } catch {
            strokes = [];
        }
        return {
            strokes,
            signedName: String(sig['signed_name'] ?? row['signed_name'] ?? ''),
            capturedAt: String(sig['captured_at'] ?? row['at']),
        };
    };

    const hasPhoto = events.rows.some((e) => String(e['type']) === 'delivered' && String(e['signed_name']) === 'Left at the door');

    return {
        orderId: Number(o['id']),
        reference: String(o['external_ref'] ?? ''),
        serviceType: String(o['service_type']),
        serviceDate: String(o['service_date']),
        timezone: opts.timezone,
        pickupLocation: String(o['site_name']),
        pickupAddress: [String(o['site_address']), String(o['site_city']), String(o['site_zip'])].filter(Boolean).join(', '),
        deliveryName: String(o['recipient_name']),
        deliveryAddress: [o['address_line'], o['address_line2'], o['city'], o['zip']].filter(Boolean).map(String).join(', '),
        status: String(o['status']),
        receivedAt: String(o['received_at']),
        dueAt: o['due_at'] === null ? null : String(o['due_at']),
        pickedUpAt: o['pickup_at'] === null ? null : String(o['pickup_at']),
        arrivedAt: o['arrived_at'] === null ? null : String(o['arrived_at']),
        deliveredAt: o['delivered_at'] === null ? null : String(o['delivered_at']),
        returnedAt: o['returned_at'] === null ? null : String(o['returned_at']),
        returnedTo: String(o['returned_site_name'] ?? ''),
        courier: opts.courierName(String(o['assigned_to_username'] ?? '')),
        receivedBy: String(o['received_by'] ?? ''),
        noSignatureReason: String(o['no_signature_reason'] ?? ''),
        failureReason: String(o['failure_reason'] ?? ''),
        packages: packages.rows.map((p) => ({
            description: String(p['description']),
            quantity: Number(p['quantity']),
            signatureRequired: Boolean(p['signature_required']),
            outcome: String(p['outcome']),
            failureReason: String(p['failure_reason_code'] ?? ''),
            failureNote: String(p['failure_note'] ?? ''),
        })),
        events: events.rows.map((e) => ({
            type: String(e['type']),
            at: String(e['at']),
            by: opts.courierName(String(e['actor'])),
            signedName: String(e['signed_name'] ?? ''),
            reason: String(e['reason'] ?? ''),
        })),
        pickupSignature: await signatureFor('picked_up'),
        deliverySignature: await signatureFor('delivered'),
        photo: {
            available: hasPhoto && opts.photoAvailable,
            /* Say what is missing and why. A doorstep delivery whose photo
               cannot be shown is a document with a hole in it, and a reader
               deserves to know that rather than wonder. */
            note: hasPhoto
                ? opts.photoAvailable
                    ? 'A photograph of the delivery location is held with this record.'
                    : 'A photograph was taken at the door. Photo storage is not yet configured, so it is not reproduced here.'
                : '',
        },
    };
}
