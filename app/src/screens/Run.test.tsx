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
vi.mock('../lib/api', async (orig) => ({ ...(await orig<object>()), get }));
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
        status: 'assigned',
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

beforeEach(() => { get.mockReset(); });
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
});
