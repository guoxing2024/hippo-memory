/**
 * The DSH 0.1.7 configuration contract, shared by the host-half suites.
 *
 * Since 0.1.7 the Loader validates a plugin's `Config` schema and hands
 * `apply()` one live reference per `.volatile()` field — including fields the
 * profile never set, which arrive as references to the schema default. A suite
 * that passes plain values is therefore not exercising what the host sends.
 */

/** One Loader config reference: frozen, read through get(). */
export function ref(value) {
  let current = value;
  return Object.freeze({
    get: () => current,
    /** stands in for the Loader's updateVolatile() */
    write: (next) => { current = next; }
  });
}

const resolved = {
  enabled: true,
  contextLimit: 6,
  sharedStore: false,
  embedding: 'off',
  similarityThreshold: undefined
};

/**
 * @param overrides - resolved field values to replace (embedding defaults to
 *   'off' so no suite pays for a 24MB model download; the 'auto' composition
 *   default is asserted on the schema instead).
 * @returns a config shaped like `Config['~standard'].validate(...)`.
 */
export function loaderConfig(overrides = {}) {
  const config = {};
  for (const [key, value] of Object.entries({ ...resolved, ...overrides })) config[key] = ref(value);
  return config;
}
