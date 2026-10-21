/* Shared setup for the app's tests.
 *
 * The pure src/lib tests need none of this and are unaffected by it. It
 * exists for the screen tests: the native modules a screen reaches for on a
 * phone have no meaning in node, and left unstubbed they throw at import
 * time, before the component this test is about has rendered once.
 *
 * Each stub is the smallest thing that lets the import succeed. None of
 * them pretends to work: a test that needs the camera or a real position
 * needs a device, and should say so rather than asserting against a fake.
 */

import { vi } from 'vitest';

/* React only treats act() as act() when it is told it is in a test
   environment. Without this it still runs, but it warns on every call and
   does not guarantee the effect queue is drained before act() returns --
   so a screen test could assert against a tree that is one setState behind
   and pass for the wrong reason. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* Secure storage: the session token lives here. Returning null means
   "nobody is signed in", which is the state a screen test sets up
   explicitly anyway. */
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
}));

vi.mock('expo-location', () => ({
    requestForegroundPermissionsAsync: async () => ({ status: 'undetermined' }),
    requestBackgroundPermissionsAsync: async () => ({ status: 'undetermined' }),
    getForegroundPermissionsAsync: async () => ({ status: 'undetermined' }),
    getCurrentPositionAsync: async () => { throw new Error('no position in a test'); },
    hasStartedLocationUpdatesAsync: async () => false,
    startLocationUpdatesAsync: async () => undefined,
    stopLocationUpdatesAsync: async () => undefined,
    Accuracy: { Balanced: 3, High: 4 },
}));

vi.mock('expo-image-picker', () => ({
    launchCameraAsync: async () => ({ canceled: true }),
    requestCameraPermissionsAsync: async () => ({ status: 'undetermined' }),
    MediaTypeOptions: { Images: 'Images' },
}));

vi.mock('expo-task-manager', () => ({
    defineTask: () => undefined,
    isTaskRegisteredAsync: async () => false,
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { apiBaseUrl: 'https://example.test', tvhsApiBaseUrl: 'https://example.test' } } },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    },
}));

/* react-native-svg draws every icon. The real package is native; the icons
   only need to be renderable, not correct. */
vi.mock('react-native-svg', () => {
    const { createElement } = require('react') as typeof import('react');
    const host = (name: string) => {
        const C = (props: Record<string, unknown> & { children?: unknown }) =>
            createElement(name, props, (props.children ?? null) as never);
        C.displayName = name;
        return C;
    };
    return {
        default: host('Svg'),
        Svg: host('Svg'),
        Path: host('Path'),
        Circle: host('Circle'),
        Rect: host('Rect'),
        G: host('G'),
        Line: host('Line'),
        Polyline: host('Polyline'),
        Defs: host('Defs'),
        LinearGradient: host('LinearGradient'),
        Stop: host('Stop'),
    };
});
