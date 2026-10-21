/* A stand-in for react-native, for tests that render a screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT DELIBERATELY IS NOT.
 *
 * React Native's own package is Flow, and running it under vitest means a
 * transform chain this project does not otherwise need. The invariant these
 * tests exist to protect belongs to React rather than to React Native:
 * "rendered more hooks than during the previous render" comes out of the
 * reconciler, and it does not care whether the host element is a <View> or
 * the string 'View'.
 *
 * So every component here is a host element with the same name, rendered by
 * react-test-renderer into a plain tree. That is enough to prove that a
 * screen mounts, that its effects run, that it survives its own data
 * arriving, and that its hooks are called in the same order every time.
 *
 * IT PROVES NOTHING ABOUT LAYOUT, STYLING OR GESTURES, and should not be
 * extended to pretend otherwise. A test that needs a real view needs a real
 * device.
 */

import { createElement, type ReactNode } from 'react';

type Props = Record<string, unknown> & { children?: ReactNode };

/** A host component named after the real one, so trees read properly.
 *
 *  `children` is pulled out rather than spread. Passing it as a prop AND as
 *  the child makes toJSON() return a structure that holds React elements in
 *  its props, and those carry a fiber reference: the tree is then circular
 *  and anything walking it, a test's own assertion included, throws. */
function host(name: string) {
    const C = ({ children, ...rest }: Props) => createElement(name, rest, children ?? null);
    C.displayName = name;
    return C;
}

export const View = host('View');
export const Text = host('Text');
export const ScrollView = host('ScrollView');
export const Pressable = host('Pressable');
export const TextInput = host('TextInput');
export const Image = host('Image');
export const Modal = host('Modal');
export const ActivityIndicator = host('ActivityIndicator');
export const RefreshControl = host('RefreshControl');
export const KeyboardAvoidingView = host('KeyboardAvoidingView');

/* Styles are identity here. The screens only ever read back what they put
   in, and a test asserting on a resolved style id would be asserting on
   StyleSheet's implementation rather than on the screen. */
export const StyleSheet = {
    create: <T,>(styles: T): T => styles,
    flatten: (style: unknown) => style,
    absoluteFillObject: {},
    hairlineWidth: 1,
};

export const Platform = { OS: 'android' as const, select: (o: Record<string, unknown>) => o['android'] ?? o['default'] };

export const Linking = {
    openURL: async () => undefined,
    canOpenURL: async () => true,
};

export const AccessibilityInfo = {
    isReduceMotionEnabled: async () => false,
    announceForAccessibility: () => undefined,
    addEventListener: () => ({ remove: () => undefined }),
};

/* Enough Animated for a component to build and start one without a frame
   loop. Nothing here advances time: a test that cares about an animation is
   a test that wants a device. */
class AnimatedValue {
    constructor(private value: number) {}
    setValue(v: number) { this.value = v; }
    interpolate() { return this; }
    addListener() { return '0'; }
    removeAllListeners() { /* nothing is listening */ }
}
const timing = () => ({ start: (cb?: () => void) => cb?.(), stop: () => undefined });
export const Animated = {
    Value: AnimatedValue,
    View: host('Animated.View'),
    Text: host('Animated.Text'),
    timing,
    spring: timing,
    loop: timing,
    sequence: timing,
    parallel: timing,
};

export const Easing = {
    linear: (t: number) => t,
    ease: (t: number) => t,
    in: (f: (t: number) => number) => f,
    out: (f: (t: number) => number) => f,
    inOut: (f: (t: number) => number) => f,
};

export const PanResponder = {
    create: () => ({ panHandlers: {} }),
};

export type LayoutChangeEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };
export type StyleProp<T> = T | T[] | null | undefined;
export type ViewStyle = Record<string, unknown>;
export type TextStyle = Record<string, unknown>;
export type TextInputProps = Record<string, unknown>;
