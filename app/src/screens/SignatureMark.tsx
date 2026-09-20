/* A signature, shown rather than captured.
 *
 * The pad in SignaturePad.tsx takes a finger and produces strokes. This
 * takes strokes and draws them, which is what the typed-initials path needs:
 * the courier has to SEE the mark before recording it, because the person it
 * belongs to is standing in front of them.
 *
 * Same 0..1 stroke format, so this renders a drawn signature and a derived
 * one identically. That is deliberate for the screen and precisely what must
 * NOT happen in the database: the row carries `capture_method` so the record
 * can tell them apart even though the picture cannot.
 */

import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { GLASS, RADIUS, SPACE, TYPE, theme } from '../theme';
import type { Stroke } from '../lib/strokes';

export function SignatureMark({ strokes, height = 150 }: { strokes: Stroke[]; height?: number }) {
    const [width, setWidth] = useState(0);
    const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

    /* One path per stroke, straight segments between sampled points: the
       points are close enough together that curve fitting would change
       nothing a person could see. */
    const paths = width > 0
        ? strokes
            .filter((s) => s.length > 1)
            .map((s) => s.map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * width).toFixed(2)} ${(p.y * height).toFixed(2)}`).join(' '))
        : [];

    return (
        <View style={[styles.box, { height }]} onLayout={onLayout} accessibilityRole="image">
            {paths.length === 0 ? (
                <Text style={styles.empty}>The mark appears here as you type the name.</Text>
            ) : (
                <Svg width={width} height={height}>
                    {paths.map((d, i) => (
                        <Path
                            key={i}
                            d={d}
                            stroke={theme.ink}
                            strokeWidth={2.4}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                        />
                    ))}
                </Svg>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    box: {
        backgroundColor: 'rgba(255,255,255,0.85)',
        borderWidth: 1,
        borderColor: GLASS.borderSubtle,
        borderRadius: RADIUS.button,
        overflow: 'hidden',
        justifyContent: 'center',
        paddingHorizontal: SPACE.sm,
    },
    empty: { fontSize: TYPE.meta, color: theme.muted, textAlign: 'center' },
});
