/* Where the credential lives on a phone (ticket 7.1).
 *
 * expo-secure-store puts it in the iOS Keychain and the Android Keystore,
 * which is the only correct place for a session token. AsyncStorage would be
 * a plain file in the app's sandbox, readable on a rooted device and in some
 * backup images.
 *
 * Every call is wrapped. SecureStore throws on a device with no passcode set
 * and on some emulator images, and a driver who cannot open the app at all
 * because the keychain was unavailable is worse off than one who has to sign
 * in again. Failing to read means "not signed in"; failing to write means the
 * session lasts until the app is closed, which is a bad day and not a broken
 * app.
 */

import * as SecureStore from 'expo-secure-store';

const KEY = 'izy.session.token';
/* WHICH SERVER THE TOKEN ABOVE CAME FROM.
 *
 * The app talks to two: TVHS is live on its own server, UH is still in test
 * on another. A token is only a session on the server that issued it, so a
 * saved token without its server is a token nobody can use: on a cold start
 * the app would send a production credential to the laptop and get a 401 that
 * looks like an expired session rather than a misdirected one.
 *
 * Not a secret, but it lives beside the token because it is useless apart
 * from it, and the two must be forgotten together. */
const BASE_KEY = 'izy.session.base';

export async function loadToken(): Promise<string | null> {
    try {
        return await SecureStore.getItemAsync(KEY);
    } catch {
        return null;
    }
}

export async function loadBase(): Promise<string | null> {
    try {
        return await SecureStore.getItemAsync(BASE_KEY);
    } catch {
        return null;
    }
}

export async function saveToken(token: string, base?: string): Promise<boolean> {
    try {
        if (base !== undefined && base !== '') {
            await SecureStore.setItemAsync(BASE_KEY, base, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
        }
        await SecureStore.setItemAsync(KEY, token, {
            /* Not available until the device has been unlocked once after a
               reboot. A courier's phone is unlocked in their hand, and this
               keeps the token out of reach while it is not. */
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        return true;
    } catch {
        return false;
    }
}

export async function clearToken(): Promise<void> {
    try {
        /* Both, always. A base left behind would point the next sign-in at
           the previous driver's server. */
        await SecureStore.deleteItemAsync(BASE_KEY);
        await SecureStore.deleteItemAsync(KEY);
    } catch {
        /* Nothing useful to do. The caller has already forgotten it in
           memory, which is what signs the courier out of this session. */
    }
}
