# The driver app

Expo, TypeScript, iOS and Android from one codebase. Ticket 7.1.

```bash
cd app
npm install
npm run typecheck
npm test
npm start          # then scan the QR with Expo Go
```

## It is outside the root npm workspaces, on purpose

`package.json` at the repository root lists `server` and `web` and does not
list `app`. That is deliberate, and it is worth writing down because the
obvious thing to do is add it.

React Native pulls in about 900 packages, many of them platform-specific. In
the root workspace they would land in the lockfile that `npm run ci` and the
Render build resolve, and this repository has already been bitten once by
exactly that: regenerating the lockfile in ticket 5.9 silently dropped 74
`@esbuild/*` platform entries, which installed fine on Windows and would have
failed on Render's Linux builder.

So the app keeps its own `package-lock.json`. `npm run ci` at the root stays
the server and the web shell, unchanged in scope and speed, and the app is
checked with its own `npm run typecheck` and `npm test`. When there is a CI
pipeline that builds the app, it gets its own job.

## What is tested and what is not

**Tested, under vitest, on a laptop:** `src/lib/http.ts`. It imports nothing
from expo or react-native, which is why it is a separate file from
`api.ts`: URL joining, header construction, error shaping, and the one error
that means sign out.

**Not tested, and not claimed to be:** the screens and the Keychain. Testing
React Native components needs `jest-expo` and a renderer, and testing
`expo-secure-store` needs a device or an emulator. Neither exists here: this
is a Windows machine with no Android SDK and no way to build for iOS.

So the app in this ticket **has been typechecked and never run**. That is the
honest state of it, and it is the reason 7.1 stops where it does.

## What the app does

Sign in, pick a contract, read today's run. That is the whole of 7.1.

It deliberately does **not** collect, deliver, fail a stop or capture a
signature. Those are 7.3 and 7.5 and they arrive together: a courier who can
mark a delivery but cannot sign for it has broken the chain of custody this
contract is built on, so half the flow is worse than none. The run screen says
so on screen rather than leaving somebody to look for a button that is not
there.

## The credential

The web shell uses a cookie. This app uses a bearer token, and the server grew
an explicit path for it in ticket 7.1
(`server/src/core/auth/sessions.ts`, `NATIVE_CLIENT_HEADER`).

React Native's `fetch` does have a cookie jar on both platforms, so relying on
cookies would work on a good day. It is the wrong answer anyway: that jar is
shared process-wide, persists differently on iOS and Android, cannot be
inspected by the app, and cannot be put in the Keychain. An app that sends
`X-Izy-Client: app` on login gets the token in the response body and **no
cookie at all** — one credential per client, and the client says which it
wants. The token goes to `expo-secure-store`, which is the iOS Keychain and
the Android Keystore.

The session token is never given to a web caller, and there is a test
asserting the word does not appear in a web login response
(`server/test/auth-bearer.test.mjs`).

## Pointing it at a server

`app.json`, `expo.extra.apiBaseUrl`. It defaults to `http://127.0.0.1:3100`,
which is the rehearsal server from `docs/day-rehearsal.md`.

A simulator reaches the host differently from a physical phone: a real device
on the same network needs the machine's LAN address, not `127.0.0.1`. That is
the first thing to change when the app is run for the first time.
