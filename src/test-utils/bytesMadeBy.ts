// How much typed-array memory a piece of code allocates, for tests that state a bound on it.

/**
 * Every byte of typed array made while `run` runs. Nothing made inside is freed before it
 * returns, so this is at least the most it ever held.
 */
export function bytesMadeBy(run: () => void): number {
  const kinds = [
    'Float32Array',
    'Float64Array',
    'Int32Array',
    'Uint32Array',
    'Int16Array',
    'Uint16Array',
    'Int8Array',
    'Uint8Array',
  ] as const;
  const scope = globalThis as unknown as Record<string, unknown>;
  const kept = kinds.map((kind) => scope[kind]);
  let bytes = 0;
  kinds.forEach((kind, i) => {
    scope[kind] = new Proxy(kept[i] as object, {
      construct(target, args) {
        const made = Reflect.construct(target as never, args) as { byteLength: number };
        // A view onto a buffer that already exists makes nothing.
        if (!(args[0] instanceof ArrayBuffer)) bytes += made.byteLength;
        return made;
      },
    });
  });
  try {
    run();
  } finally {
    kinds.forEach((kind, i) => (scope[kind] = kept[i]));
  }
  return bytes;
}
