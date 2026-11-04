/* The courier's run screen, mounted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIRST TEST IN THIS WORKSPACE THAT RENDERS ANYTHING, AND WHY.
 *
 * usePaged holds a page number in useState, which makes it a hook, and it
 * was called below three conditional early returns: the loading spinner,
 * Collect and Stop. The first render stopped at the spinner having run nine
 * hooks. The render after the courier's run arrived fell through and ran
 * ten. React throws "rendered more hooks than during the previous render",
 * the component unmounts, and the screen is white.
 *
 * That shipped. It was in a signed release build and in the bundle staged
 * for Play, and it broke the main screen of the app for every courier on
 * every shift, the moment their work loaded.
 *
 * TWO HUNDRED AND SIXTY-TWO TESTS PASSED THROUGHOUT. Every one of them was
 * a pure function in src/lib; none mounted a component; React only enforces
 * hook order when something actually renders twice. The bug was found by
 * reading logcat on an emulator, because on a phone the failure is a white
 * screen and nothing else -- no dialog, no log a courier can reach, nothing
 * dispatch could act on. The report would have been "the app does not
 * work".
 *
 * So the test that matters here is not an assertion about any particular
 * pixel. It is: mount the screen with no data, let its own fetch resolve,
 * and require that it is still standing. That is the exact sequence that
 * broke, and any hook called after a conditional return will fail it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Run } from './Run';
import type { MyRun, Project, Stop } from '../lib/api';

/* The screen's two sources: the API and the offline queue. Both are mocked
   at the module boundary, so this test says nothing about either -- they
   have their own tests, and a screen test that also exercised the queue
   would fail for two unrelated reasons. */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (orig) => ({ ...(await orig<object>()), get, post }));
/* The stop screen asks whether photo storage is on and would open a camera.
   Neither belongs in a test about which stops can be opened. */
vi.mock('../lib/pod', async (orig) => ({
    ...(await orig<object>()),
    podAvailable: async () => ({ available: false }),
    capturePhoto: async () => ({ kind: 'cancelled' }),
    uploadPhoto: async () => ({ kind: 'failed', message: 'no storage in a test' }),
}));
vi.mock('../lib/queue', () => ({
    readQueue: async () => ({ queue: [], rejected: [] }),
    flush: async () => ({ queue: [], rejected: [] }),
    dismissRejections: async () => ({ queue: [], rejected: [] }),
}));

const project: Project = {
    id: 2, code: 'uh', name: 'UH Pharmacy Courier', timezone: 'America/Chicago', role: 'courier',
} as unknown as Project;

function stop(sequence: number, over: Partial<Stop> = {}): Stop {
    return {
        sequence,
        orderId: 1000 + sequence,
        externalRef: `RX-${1000 + sequence}`,
        serviceType: 'SCHEDULED',
        recipientName: `Test Patient ${sequence}`,
        address: `${sequence} Rehearsal Way`,
        city: 'San Antonio',
        zip: '78207',
        recipientPhone: '210-555-0100',
        idRequired: false,
        /* COLLECTED. An uncollected stop now hides the whole round -- the
           same rule as the web's MyRun -- so a test about the list says so,
           and the one about the gate asks for 'assigned'. */
        status: 'picked_up',
        ...over,
    } as unknown as Stop;
}

function runWith(stops: Stop[]): MyRun {
    return {
        serviceDate: '2026-10-21',
        timezone: 'America/Chicago',
        courierUsername: 'demo.courier',
        runs: [{ id: 535, label: 'RBG zone 1 loop', status: 'active', stops }],
        dispatch: { phone: '210-555-0000', name: 'Dispatch' },
    };
}

/** Every string in the rendered tree, joined.
 *
 *  Walked rather than JSON.stringify'd: a rendered tree holds React
 *  elements in places that reference their own fiber, so serialising it
 *  throws on a circular structure. */
function textOf(node: unknown): string {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    const children = (node as { children?: unknown }).children;
    return children === undefined ? '' : textOf(children);
}

/* The run endpoint and the order endpoint are different shapes, and the
   stop screen asks for the second one as soon as it opens. One mock that
   answered both with a run left `detail.packages` undefined. */
function answering(run: MyRun, order: Record<string, unknown> = { status: 'delivered', packages: [] }) {
    return (path: string) => Promise.resolve(/\/orders\//.test(path) ? order : run);
}

/** Mount, then flush the promises the screen kicked off in its effects. */
async function mount(): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer;
    await act(async () => {
        tree = create(
            <Run token="t" project={project} onSignedOut={() => undefined} onBack={() => undefined} />,
        );
    });
    /* A second flush: load() awaits the fetch and then the outbox, so one
       turn of the loop leaves the screen mid-way through its own setState. */
    await act(async () => { await Promise.resolve(); });
    return tree;
}

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(() => { vi.clearAllMocks(); });

describe('the run screen survives its own data arriving', () => {
    it('renders a run without throwing on the second render', async () => {
        /* THE REGRESSION. Render one: data is null, the spinner returns
           early. Render two: the run is in, and every hook has to be called
           in the same order it was the first time. Before the fix this threw
           "rendered more hooks than during the previous render" and the
           courier got a white screen. */
        get.mockResolvedValue(runWith([stop(1), stop(2), stop(3)]));

        const tree = await mount();

        expect(tree.toJSON()).not.toBeNull();
        /* Still mounted AND past the early return: the courier's own stop is
           on screen, which is only reachable through the code that used to
           throw. */
        expect(textOf(tree.toJSON())).toContain('Test Patient 1');
    });

    it('survives an empty run, which takes a different branch', async () => {
        /* No stops means `next` is null and the list renders its empty case.
           Same hook sequence, different body: a guard placed in the wrong
           branch would pass the test above and fail this one. */
        get.mockResolvedValue(runWith([]));
        const tree = await mount();
        expect(tree.toJSON()).not.toBeNull();
    });

    it('survives the fetch failing, which is the other early return', async () => {
        /* A courier in a basement. error is set, data stays null, and the
           screen renders the message instead of the run -- still after the
           same hooks. */
        get.mockRejectedValue(new Error('Cannot reach dispatch.'));
        const tree = await mount();
        expect(tree.toJSON()).not.toBeNull();
    });

    it('pages a long run, which is what the moved hook is for', async () => {
        /* usePaged is the hook that was in the wrong place, so the test
           suite should also prove it still does its job after being moved,
           not merely that it stopped throwing. A full zone-1 loop is thirty
           stops; the list pages them and the first page's stops are on
           screen. */
        get.mockResolvedValue(runWith(Array.from({ length: 30 }, (_, i) => stop(i + 1))));

        const tree = await mount();
        const text = textOf(tree.toJSON());

        expect(tree.toJSON()).not.toBeNull();
        expect(text).toContain('Test Patient 1');
        /* Paged, not all thirty at once: the last stop of a thirty-stop run
           cannot be on the first page. */
        expect(text).not.toContain('Test Patient 30');
    });

    /* ─────────────────────────────────────────────────────────────────
     * A FINISHED STOP CAN BE OPENED (4 November 2026).
     *
     * It used to be greyed out and `disabled`, so the tap did nothing at
     * all. Two things happen often enough that the gate cost more than it
     * protected: a photograph of the signed form that came out blurred,
     * and a dry run where the patient rang the pharmacy back and the
     * driver got there again an hour later. Both were a telephone call to
     * somebody holding the admin role, or went unrecorded.
     * ───────────────────────────────────────────────────────────────── */

    /* The text inside an UNRENDERED element tree, which is what a test
       instance's props hold. textOf above walks toJSON output, where every
       node carries `children` directly; a React element carries it under
       `props`, so that one returns '' for all of these. */
    function inside(node: unknown): string {
        if (node === null || node === undefined || node === false) return '';
        if (typeof node === 'string') return node;
        if (typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(inside).join(' ');
        const props = (node as { props?: { children?: unknown } }).props;
        return props === undefined ? '' : inside(props.children);
    }

    /** Press the control whose own text contains `label`. */
    async function press(tree: ReactTestRenderer, label: string) {
        const hit = tree.root.findAll(
            (n) => typeof n.type !== 'string'
                && typeof (n.props as { onPress?: unknown }).onPress === 'function'
                && inside(n.props.children).includes(label),
        ).pop();
        expect(hit, `nothing pressable containing "${label}"`).toBeDefined();
        await act(async () => { (hit!.props as { onPress: () => void }).onPress(); });
        await act(async () => { await Promise.resolve(); });
    }

    /** Tap the row for a given patient in the "All stops" list. */
    const tapStop = (tree: ReactTestRenderer, name: string) => press(tree, name);

    it('opens a delivered stop instead of ignoring the tap', async () => {
        get.mockImplementation(answering(runWith([stop(1, { status: 'delivered' } as Partial<Stop>)])));
        const tree = await mount();

        await tapStop(tree, 'Test Patient 1');

        const text = textOf(tree.toJSON());
        expect(text).toContain('Recorded as delivered');
        /* And it does not offer the delivery form again: this stop is
           finished and recording it twice is the thing to avoid. */
        expect(text).not.toContain('I have arrived');
        expect(text).not.toContain('Could not deliver');
    });

    it('offers a second attempt on a failed stop, and only there', async () => {
        get.mockImplementation(answering(runWith([
            stop(1, { status: 'failed' } as Partial<Stop>),
            stop(2, { status: 'delivered' } as Partial<Stop>),
        ]), { status: 'failed', packages: [{ id: 1, description: 'Cold pack', quantity: 1 }] }));
        const tree = await mount();

        await tapStop(tree, 'Test Patient 1');
        expect(textOf(tree.toJSON())).toContain('I delivered it after all');
    });

    it('does not offer a second attempt on a delivered stop', async () => {
        /* A delivered stop is finished. Offering to deliver it again is
           how one delivery becomes two on an invoice. */
        get.mockImplementation(answering(runWith([stop(1, { status: 'delivered' } as Partial<Stop>)])));
        const tree = await mount();

        await tapStop(tree, 'Test Patient 1');
        expect(textOf(tree.toJSON())).not.toContain('I delivered it after all');
    });

    it('asks the server for the second attempt and opens the delivery it made', async () => {
        /* The driver should land on the new delivery, not back on a list
           to hunt through for a row that was not there a moment ago -- and
           never on the old stop, which is finished. */
        const failed = runWith([stop(1, { status: 'failed' } as Partial<Stop>)]);
        const after = runWith([
            stop(1, { status: 'failed' } as Partial<Stop>),
            stop(2, { status: 'assigned', orderId: 2222, recipientName: 'Test Patient 1' } as Partial<Stop>),
        ]);
        let first = true;
        get.mockImplementation((path: string) => {
            if (/\/orders\//.test(path)) {
                return Promise.resolve({ status: 'failed', packages: [{ id: 1, description: 'Cold pack', quantity: 1 }] });
            }
            if (first) { first = false; return Promise.resolve(failed); }
            return Promise.resolve(after);
        });
        post.mockResolvedValue({ id: 2222, reattemptOf: 1001, runId: 535 });

        const tree = await mount();
        await tapStop(tree, 'Test Patient 1');

        await press(tree, 'I delivered it after all');
        await act(async () => { await Promise.resolve(); });

        expect(post.mock.calls[0]?.[0]).toContain('/orders/1001/redeliver');
        /* On the second attempt now, which is assigned rather than failed,
           so the ordinary delivery form is what is on screen. */
        const text = textOf(tree.toJSON());
        expect(text).not.toContain('Recorded as not delivered');
        expect(text).toContain('Handed over');
    });

    it('shows the round as soon as it is assigned', async () => {
        /* THE OPPOSITE OF WHAT WAS HERE. The round used to be replaced by
           "Collect first" until custody was recorded, matching the web.
           Both dropped that on 3 November: drivers stopped recording
           collections, the server writes the custody event itself, and
           there is nothing left to wait for before showing somebody the
           stops they were assigned. */
        get.mockResolvedValue(runWith([
            stop(1, { status: 'assigned' } as Partial<Stop>),
            stop(2, { status: 'picked_up' } as Partial<Stop>),
        ]));
        const tree = await mount();
        const text = textOf(tree.toJSON());

        expect(text).not.toContain('Collect first');
        expect(text).not.toContain('Collect from a pharmacy');
        /* Both of them, collected or not: the gate was all-or-nothing and
           so is its absence. */
        expect(text).toContain('Test Patient 1');
        expect(text).toContain('Test Patient 2');
    });
});
