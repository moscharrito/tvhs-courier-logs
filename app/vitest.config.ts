/* Vitest for the phone app.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A RENDERER HERE AT ALL.
 *
 * Every other test in this workspace is src/lib/*.ts: pure functions, no
 * React. That was a deliberate line and it held until a hooks-order bug
 * reached a signed release build -- usePaged called below three conditional
 * early returns in screens/Run.tsx, which made the driver's own run screen
 * throw and render white the moment their work loaded. See the commit.
 *
 * Nothing in 262 passing tests could have caught it, because none of them
 * mount a component, and React's hook-order invariant is only enforced when
 * a component actually renders twice.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND WHY IT IS NOT REACT NATIVE TESTING LIBRARY.
 *
 * RNTL wants React Native's own source, which ships as Flow and needs a
 * transform chain this project does not otherwise have -- a second build
 * configuration to keep working, for tests that would still not run a real
 * native view.
 *
 * The invariant worth protecting belongs to REACT, not to React Native:
 * "rendered more hooks than during the previous render" is thrown by the
 * reconciler and does not care whether the host component is a <View> or a
 * stub. So react-native is stubbed (test/react-native.ts) and the tree is
 * rendered with react-test-renderer. A test here proves hooks are ordered,
 * effects run, and a screen survives its own data arriving. It proves
 * nothing about layout, and is not meant to.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./test/setup.ts'],
        alias: [
            /* Exact match only. A regex would also catch
               react-native-svg and the async-storage package, which have
               their own stubs or none. */
            { find: /^react-native$/, replacement: new URL('./test/react-native.tsx', import.meta.url).pathname },
        ],
    },
});
