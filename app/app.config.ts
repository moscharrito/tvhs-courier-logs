/* Build-time configuration (ticket 7.6).
 *
 * app.json holds everything that does not change between builds. This file
 * holds the one thing that does, and refuses to produce a release build that
 * would be rejected: see src/lib/apiUrl.cjs for why a submitted app pointing
 * at 127.0.0.1 is a wasted review cycle rather than a bug somebody notices.
 *
 * It throws. That is the point. A build that stops with a sentence naming the
 * variable costs twenty seconds; one that succeeds and is rejected costs a
 * review.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
/* By its real extension, and it must stay that way. Expo transpiles THIS
   file with sucrase and then lets plain Node require whatever it imports, so
   an extensionless import of a .ts file throws at startup. */
import { resolveApiUrl } from './src/lib/apiUrl.cjs';

export default ({ config }: ConfigContext): ExpoConfig => {
    const apiBaseUrl = resolveApiUrl({
        configured: process.env['EXPO_PUBLIC_API_URL'],
        /* EAS sets this to the profile being built. Absent means somebody is
           running `expo start` on their own machine. */
        profile: process.env['EAS_BUILD_PROFILE'],
    });

    return {
        ...config,
        name: config.name ?? 'Izy Courier',
        slug: config.slug ?? 'izy-courier',
        extra: { ...config.extra, apiBaseUrl },
    };
};
