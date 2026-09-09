/* Injection point between the TypeScript core and the legacy server.js.
 *
 * server.js is plain CommonJS and cannot require TypeScript sources, so the
 * entry point (src/legacy.ts) registers core services here before requiring
 * server.js, and server.js pulls them out at load. Once the legacy handlers
 * move into src/modules/tvhs this file goes away. */

const registry = new Map();

module.exports = {
    set(name, value) {
        registry.set(name, value);
    },
    get(name) {
        if (!registry.has(name)) {
            throw new Error(`legacy-bridge: "${name}" was not provided. Boot through src/index.ts (or the test harness), not node server.js.`);
        }
        return registry.get(name);
    },
    has(name) {
        return registry.has(name);
    },
};
