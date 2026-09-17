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

export async function loadToken(): Promise<string | null> {
    try {
        return await SecureStore.getItemAsync(KEY);
    } catch {
        return null;
    }
}

export async function saveToken(token: string): Promise<boolean> {
    try {
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
        await SecureStore.deleteItemAsync(KEY);
    } catch {
        /* Nothing useful to do. The caller has already forgotten it in
           memory, which is what signs the courier out of this session. */
    }
}
