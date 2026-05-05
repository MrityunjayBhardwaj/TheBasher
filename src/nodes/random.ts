// Deterministic PRNG for `pure: true` evaluators.
//
// THESIS.md §48: random nodes accept a `seed` parameter; randomness is
// `mulberry32(seed)`. ESLint forbids Math.random in `src/nodes/**` so this
// is the only legal source of randomness inside node evaluators.
//
// REF: THESIS.md §48.

/** mulberry32 — small, fast, fully deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function rand(): number {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [min, max). */
export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Integer in [0, n). */
export function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}
