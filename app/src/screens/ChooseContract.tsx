/* The first screen: which contract are you driving today.
 *
 * Before the password, because a driver knows which vans they drive before
 * they know their password, and because the app used to hardcode `uh` at
 * signup, which was wrong the moment Izy ran two contracts.
 *
 * IT GRANTS NOTHING. See the header of lib/contracts.ts: this is
 * unauthenticated and anybody holding the phone can tap either card. Access
 * is still the membership the server returns after sign-in, and a driver who
 * taps the wrong one is told so by name once they are signed in.
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CardButton, Ground, Panel } from '../ui/Glass';
import { CONTRACTS, type Contract } from '../lib/contracts';
import { RADIUS, SPACE, TYPE, theme } from '../theme';

export function ChooseContract({ onChoose }: { onChoose: (contract: Contract) => void }) {
    return (
        <Ground>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
                <View style={styles.brand}>
                    <Text style={styles.wordmark}>TAG</Text>
                    {/* A short rule instead of a tagline. It gives the
                        wordmark something to sit on without adding a
                        sentence nobody reads twice. */}
                    <View style={styles.rule} />
                </View>

                <Panel style={styles.panel}>
                    <Text style={styles.title}>Select Contract</Text>
                    {CONTRACTS.map((c) => (
                        <CardButton
                            key={c.code}
                            title={c.name}
                            detail={c.detail}
                            tone={c.code === 'uh' ? 'primary' : 'secondary'}
                            onPress={() => onChoose(c)}
                            accessibilityHint="Opens the sign in screen for this contract"
                        />
                    ))}
                </Panel>

            </ScrollView>

            {/* OUTSIDE THE SCROLL VIEW, and that is the whole fix.
                Inside it, the footer was part of what the scroll view was
                centring, so "centre" meant the centre of the space above the
                footer and the wordmark sat high by half the footer's height.
                Ground's content layer is an absolute fill, so the scroll view
                takes the room that is left and the footer sits under it.

                The year comes from the clock rather than being typed, so it
                cannot be the one thing on screen that is wrong next January. */}
            <Text style={styles.copyright}>© {new Date().getFullYear()} Izy Global Services LLC</Text>
        </Ground>
    );
}

/* How far below true centre the group sits, in points.
 *
 * NOT A STRUCTURAL FIX, and the difference matters to whoever reads this
 * next. The status bar allowance below genuinely centres the content in the
 * area a person can see; this is on top of that, because arithmetic centre
 * and optical centre are not the same place. A heavy card carries more visual
 * weight than a wordmark and a hairline, so the eye reads a mathematically
 * centred group as sitting high, and wants it lower.
 *
 * Doubled into paddingTop: padding shifts the centre of the remaining space
 * by half of what is added, so 20 here moves the group down 20.
 */
const OPTICAL_DROP = 20;

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    /* paddingTop CLEARS THE STATUS BAR, and that is why the wordmark used to
       read high.
       
       Ground's content layer is an absolute fill starting at y=0, so it sits
       under the clock and the battery. Centring against the full height puts
       content above the centre of the part a person can actually see. Every
       other screen in the app already allows for this: 56 on Board, Profile,
       Requests, Run and Stop, 60 on Apply and Onboarding. This screen had 22,
       which made it the only one that did not.
       
       60 matches Apply.tsx, the other screen that centres its content. */
    wrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.lg, paddingTop: 60 + OPTICAL_DROP * 2 },

    brand: { alignItems: 'center', marginBottom: SPACE.xl },
    wordmark: {
        fontSize: 54,
        fontWeight: '800',
        color: theme.green,
        /* TIGHT, NOT WIDE. This was +2, which is the letterspacing of a 1990s
           corporate logotype; a wordmark of three capitals reads as one shape
           when the letters are pulled together, and that is most of what
           makes a mark look current. */
        letterSpacing: -1.5,
        textAlign: 'center',
    },
    rule: {
        width: 48,
        height: 4,
        borderRadius: RADIUS.pill,
        backgroundColor: theme.greenBright,
        marginTop: SPACE.md,
    },
    copyright: {
        /* Clear of the home indicator on a phone with no hardware button. */
        paddingBottom: SPACE.lg,
        paddingTop: SPACE.sm,
        fontSize: TYPE.meta,
        color: theme.muted,
        textAlign: 'center',
    },
    panel: { borderRadius: RADIUS.card },
    /* A label over two cards, not the page's title: the wordmark above is
       that. It sat at TYPE.title, 26 and near-black, competing with the mark
       and shouting an instruction nobody needs shouted.
       Small, spaced and muted, which is how a modern interface labels a
       group rather than announcing one. Still 15pt, the app's floor. */
    title: {
        fontSize: TYPE.meta,
        fontWeight: '700',
        color: theme.muted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginBottom: SPACE.md,
        marginLeft: 2,
    },
});
