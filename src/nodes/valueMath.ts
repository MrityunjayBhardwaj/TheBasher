// valueMath — the ONE shared pure scalar-math core (#292, Epic 1 Inc 1).
//
// Both the animation F-Modifier stack (channelModifiers.ts) and the compute-node
// vocabulary (computeNodes.ts) need the same primitives. Rather than duplicate
// them (and let the two drift), the genuinely-shared math lives here.
//
// Shared today: the deterministic fractal value-noise (F-Mod Noise + the Noise
// compute node). The remaining primitives (clamp / lerp / fit / curveRemap /
// applyMathOp) back the compute nodes. NOTE: the F-Modifiers deliberately keep
// their OWN clamp/remap expressions — e.g. the Envelope's remap divides by
// `mod.max - mod.min` directly, and rerouting it through `fit` would change float
// rounding and break the byte-identical guarantee. So this core SERVES the compute
// nodes; it does not retro-rewrite the F-mods beyond the noise core they truly share.
//
// PURE: no Math.random, no clocks, no globals — every function is (inputs) → number.
// REF: Blender fcurve.c noise/ramp math; Houdini VOP fit/clamp/ramp; #292.

// ── deterministic fractal value-noise (moved verbatim from channelModifiers.ts) ──
// A sine-hash of the integer lattice, smoothstep-interpolated → C1-continuous value
// noise in [-1,1], summed over octaves. Deterministic in `x`, so the curve the
// editor draws is the curve that plays (H40).

function hash1(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s); // [0,1)
}

function valueNoise1D(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smoothstep → C1
  const a = hash1(i);
  const b = hash1(i + 1);
  return (a + (b - a) * u) * 2 - 1; // [-1,1)
}

/** Fractal (fBm) value-noise: `depth` octaves, halving amplitude, doubling freq,
 *  normalised back to ≈[-1,1]. `depth` clamped to [1,8]. */
export function fractalNoise(x: number, depth: number): number {
  const oct = Math.max(1, Math.min(Math.floor(depth) || 1, 8));
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * valueNoise1D(x * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

// ── compute-node primitives ─────────────────────────────────────────────────

/** Clamp `v` into [min, max]. Robust to inverted bounds (result never exceeds max). */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Linear interpolation (Mix). `t` is NOT clamped — pass a clamped `t` for a bounded mix. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map `v` from the input range onto the output range (Houdini `fit`). A degenerate
 *  input range (inMax === inMin) maps to `outMin` (no divide-by-zero). When `doClamp`
 *  the normalised position is clamped to [0,1] BEFORE the output remap. */
export function fit(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  doClamp = false,
): number {
  const denom = inMax - inMin;
  let t = denom === 0 ? 0 : (v - inMin) / denom;
  if (doClamp) t = clamp(t, 0, 1);
  return outMin + t * (outMax - outMin);
}

/** One control point of a CurveRemap ramp. */
export interface RampPoint {
  readonly x: number;
  readonly y: number;
}

/** Piecewise-linear remap of `x` through the ramp control points (Houdini/Blender
 *  ramp). Points need not be pre-sorted (a copy is sorted by x). Outside the point
 *  range holds the first/last `y` (Blender `fcm_envelope_evaluate` segment scan).
 *  No points → identity. */
export function curveRemap(x: number, points: readonly RampPoint[]): number {
  const n = points.length;
  if (n === 0) return x;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[n - 1];
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 0; i < n - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.x <= x && x <= b.x) {
      const d = b.x - a.x;
      if (d <= 0) return a.y;
      const f = (x - a.x) / d;
      return a.y + f * (b.y - a.y);
    }
  }
  return last.y;
}

/** The binary arithmetic ops the `Math` compute node exposes via an op-enum. */
export const MATH_OPS = ['add', 'sub', 'mul', 'div'] as const;
export type MathOp = (typeof MATH_OPS)[number];

/** Apply a binary arithmetic op. Division by zero is SAFE (→ 0), keeping the graph
 *  finite/deterministic rather than propagating Infinity/NaN through downstream nodes. */
export function applyMathOp(op: MathOp, a: number, b: number): number {
  switch (op) {
    case 'add':
      return a + b;
    case 'sub':
      return a - b;
    case 'mul':
      return a * b;
    case 'div':
      return b === 0 ? 0 : a / b;
  }
}

// ── stateful step math (Epic 2) ──────────────────────────────────────────────
// These are the PER-FRAME recurrence steps for the stateful ops (Lag/Spring). They
// are pure functions of (previous state, current input) → next state — the memory
// lives OUTSIDE, in the seam's replay loop (src/app/statefulOps.ts), which threads
// the previous output forward frame by frame from a known seed. Purity here + the
// fixed seed + the fixed frame interval = determinism by contract (a scrub replays
// the same interval and lands the same value), NOT purity of the containing node.
// REF: Houdini Lag/Spring CHOP (output(t) = g(input(t), output(t−Δ))); GT
//      GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §5/§5a.

/** One Lag step (first-order low-pass). `factor` ∈ [0,1] is the fraction of the gap
 *  to the target closed this frame: 1 = no lag (snaps to input), →0 = heavy lag
 *  (barely moves). `factor` is clamped to [0,1] so the recurrence never overshoots
 *  or diverges. `out = prev + (input − prev)·factor`. */
export function lagStep(prev: number, input: number, factor: number): number {
  const k = clamp(factor, 0, 1);
  return prev + (input - prev) * k;
}
