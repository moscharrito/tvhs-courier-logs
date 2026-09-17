/* Signing for a delivery, on glass (ticket 7.5).
 *
 * PanResponder rather than a gesture library, because this is one view that
 * needs raw touch coordinates and nothing else, and react-native-svg draws
 * the result. Both are what the ecosystem actually uses for this; neither is
 * a dependency added for one clever thing.
 *
 * The numbers are all in strokes.ts and tested there. This file is the
 * surface: measure the pad, collect points, hand back normalised strokes.
 *
 * THE PERSON SIGNING IS NOT THE COURIER. That is the whole point of the
 * signature under the contract: it is evidence the package changed hands. So
 * the pad says whose name goes underneath, the courier types it, and neither
 * is optional. A signature with no printed name is a squiggle nobody can
 * attribute, which Scope 1.2.8 asks us not to produce.
 */

import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { theme } from '../theme';
import { fit, looksSigned, toPath, toPoint, type Stroke } from '../lib/strokes';

interface Props {
    label: string;
    onChange: (strokes: Stroke[], signed: boolean) => void;
}

export function SignaturePad({ label, onChange }: Props) {
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    /* The stroke under the finger, kept separate from the committed ones so
       the line follows the touch without rewriting the whole list on every
       move event. */
    const [live, setLive] = useState<Stroke>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });

    /* Refs, not state: a touch handler that reads state sees whatever React
       last rendered, which during a fast scrawl is several points behind. */
    const current = useRef<Stroke>([]);
    const started = useRef<number>(0);
    const box = useRef({ width: 0, height: 0 });

    const onLayout = (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        box.current = { width, height };
        setSize({ width, height });
    };

    const responder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (e) => {
                if (started.current === 0) started.current = Date.now();
                const { locationX, locationY } = e.nativeEvent;
                current.current = [toPoint(locationX, locationY, box.current.width, box.current.height, Date.now() - started.current)];
                setLive(current.current);
            },
            onPanResponderMove: (e) => {
                const { locationX, locationY } = e.nativeEvent;
                current.current = [
                    ...current.current,
                    toPoint(locationX, locationY, box.current.width, box.current.height, Date.now() - started.current),
                ];
                setLive(current.current);
            },
            onPanResponderRelease: () => {
                const stroke = current.current;
                current.current = [];
                setLive([]);
                if (stroke.length === 0) return;
                setStrokes((done) => {
                    const next = fit([...done, stroke]);
                    onChange(next, looksSigned(next));
                    return next;
                });
            },
        }),
    ).current;

    const clear = () => {
        current.current = [];
        started.current = 0;
        setLive([]);
        setStrokes([]);
        onChange([], false);
    };

    return (
        <View>
            <View style={styles.head}>
                <Text style={styles.label}>{label}</Text>
                <Text style={styles.clear} onPress={clear} accessibilityRole="button">Clear</Text>
            </View>
            <View
                style={styles.pad}
                onLayout={onLayout}
                accessibilityLabel={label}
                {...responder.panHandlers}
            >
                <Svg width={size.width} height={size.height}>
                    {[...strokes, live].map((stroke, i) => (
                        <Path
                            key={i}
                            d={toPath(stroke, size.width, size.height)}
                            stroke={theme.ink}
                            strokeWidth={2.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                        />
                    ))}
                </Svg>
                {strokes.length === 0 && live.length === 0 && <Text style={styles.hint}>Sign here</Text>}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 16 },
    label: { fontSize: 13, color: theme.muted },
    clear: { fontSize: 14, color: theme.green },
    /* Tall enough to sign in, on a phone held by somebody at a door. */
    pad: {
        height: 170, marginTop: 6, borderRadius: 10, borderWidth: 1,
        borderStyle: 'dashed', borderColor: theme.line, backgroundColor: theme.card,
        alignItems: 'center', justifyContent: 'center',
    },
    hint: { position: 'absolute', color: theme.muted, fontSize: 15 },
});
