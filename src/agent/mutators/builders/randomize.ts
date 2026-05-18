// randomize Mutator — per-target randomization across color | rotation |
// scale. ONE call emits N × P ops in one atomic dispatch (N = targets,
// P = properties), with optional `seed` for byte-identical determinism
// via mulberry32 (reused from src/nodes/random.ts — no new RNG dep).
//
// Spec (D-01..D-02):
//   {
//     targetSelectors: NodeId[],
//     properties: ('color' | 'rotation' | 'scale')[],   // non-empty, deduped
//     ranges: {
//       color?:    { h:[min,max], s:[min,max], l:[min,max] },
//       rotation?: { axis:'x'|'y'|'z'|'random', degRange:[min,max] },
//       scale?:    { factor:[min,max] },
//     },
//     seed?: number,
//   }
//
// `position` is EXCLUDED from `PropertyName` (D-05 hard scope — ScatterNode
// owns position-randomization; mixing surfaces duplicates intent). It MAY
// appear in `contract.preserves` as an honest disclosure of what this
// Mutator never touches — `'position'` is a pre-existing `PreservedAspect`
// token already used at setMaterialColor.ts:34 (NOT an H36-invented one).
//
// Per-property sampler helpers take `rng: () => number` explicitly — every
// randomness source inside `build()` flows through the closured rng created
// ONCE at the top. Anti-pattern: any helper calling Math.random in the
// seeded branch (silently breaks determinism). hslToHex is pure.
//
// Hue wrap (D-01): `h:[350, 10]` is the canonical "near-red jitter" — when
// `min > max` the sampler wraps via modular arithmetic. zod does NOT
// enforce min ≤ max on hue (intentional).
//
// HSL is not perceptually uniform — acceptable for v0.7.2 (OKLCH upgrade
// tracked as a follow-up).
//
// REF: issue #26 path B; .planning/phases/07.2-mutator-randomize/CONTEXT.md
// D-01..D-10; mirror builders rotate.ts / scale.ts / setMaterialColor.ts.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { mulberry32, randRange } from '../../../nodes/random';

// ---------------------------------------------------------------------------
// Sub-schemas (D-08 — bound discipline)
// ---------------------------------------------------------------------------

const HslRange = z.object({
  // NOTE: hue does NOT carry a min ≤ max refinement — wrap is the
  // intended behavior for h:[350, 10] (D-01 pre-mortem).
  h: z.tuple([z.number().min(0).max(360), z.number().min(0).max(360)]),
  s: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
    .refine(([a, b]) => a <= b, 's: min must be ≤ max'),
  l: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
    .refine(([a, b]) => a <= b, 'l: min must be ≤ max'),
});

const RotationRange = z.object({
  axis: z.enum(['x', 'y', 'z', 'random']),
  degRange: z
    .tuple([z.number(), z.number()])
    .refine(([a, b]) => a <= b, 'degRange: min must be ≤ max'),
});

const ScaleRange = z.object({
  factor: z
    .tuple([z.number().positive(), z.number().positive()])
    .refine(([a, b]) => a <= b, 'factor: min must be ≤ max'),
});

// D-05 hard scope — `'position'` does NOT appear in PropertyName. The
// Wave 4 grep gate enforces this.
const PropertyName = z.enum(['color', 'rotation', 'scale']);

const RandomizeSpec = z
  .object({
    targetSelectors: z.array(z.string().min(1)).min(1),
    properties: z
      .array(PropertyName)
      .min(1)
      .refine((arr) => new Set(arr).size === arr.length, 'properties must be deduped'),
    ranges: z.object({
      color: HslRange.optional(),
      rotation: RotationRange.optional(),
      scale: ScaleRange.optional(),
    }),
    seed: z.number().int().optional(),
  })
  .superRefine((s, ctx) => {
    for (const p of s.properties) {
      if (!s.ranges[p]) {
        ctx.addIssue({
          code: 'custom',
          message: `ranges.${p} is required when "${p}" is in properties[]`,
          path: ['ranges', p],
        });
      }
    }
  });

export type RandomizeSpec = z.infer<typeof RandomizeSpec>;
type HslRangeT = z.infer<typeof HslRange>;
type RotationRangeT = z.infer<typeof RotationRange>;
type ScaleRangeT = z.infer<typeof ScaleRange>;

// ---------------------------------------------------------------------------
// Pure samplers — every randomness source threads through `rng` explicitly.
// No implicit Math.random. hslToHex is purely deterministic on its inputs.
// ---------------------------------------------------------------------------

function sampleHue(rng: () => number, [min, max]: [number, number]): number {
  if (min <= max) {
    return randRange(rng, min, max);
  }
  // Wrap: min > max means the range crosses 360/0. Span = (360-min) + max.
  return (min + rng() * (360 - min + max)) % 360;
}

function hslToHex(h: number, s: number, l: number): string {
  // Standard HSL → RGB (h in [0,360), s/l in [0,1]); pure, no randomness.
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 60) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (hh < 120) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (hh < 180) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (hh < 240) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (hh < 300) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function sampleHslToHex(rng: () => number, range: HslRangeT): string {
  const h = sampleHue(rng, range.h);
  const s = randRange(rng, range.s[0], range.s[1]);
  const l = randRange(rng, range.l[0], range.l[1]);
  return hslToHex(h, s, l);
}

function sampleRotationDelta(
  rng: () => number,
  range: RotationRangeT,
): { axis: 'x' | 'y' | 'z'; deltaDeg: number } {
  const axis: 'x' | 'y' | 'z' =
    range.axis === 'random'
      ? (['x', 'y', 'z'] as const)[Math.floor(rng() * 3)]
      : range.axis;
  const deltaDeg = randRange(rng, range.degRange[0], range.degRange[1]);
  return { axis, deltaDeg };
}

function sampleScaleFactor(rng: () => number, range: ScaleRangeT): number {
  return randRange(rng, range.factor[0], range.factor[1]);
}

// ---------------------------------------------------------------------------
// Capability probes — mirror existing builders verbatim (DO NOT re-derive)
//   canColor:    setMaterialColor.ts:47-48
//   canRotation: rotate.ts:49-50
//   canScale:    scale.ts:46-47
// ---------------------------------------------------------------------------

function canColor(params: Record<string, unknown> | undefined): boolean {
  const hasMaterial = !!params?.material && typeof params.material === 'object';
  const hasColor = typeof params?.color === 'string';
  return hasMaterial || hasColor;
}

function canRotation(params: Record<string, unknown> | undefined): boolean {
  const rot = params?.rotation;
  return Array.isArray(rot) && rot.length === 3;
}

function canScale(params: Record<string, unknown> | undefined): boolean {
  const hasSize = Array.isArray(params?.size) && (params!.size as unknown[]).length === 3;
  const hasRadius = typeof params?.radius === 'number';
  return hasSize || hasRadius;
}

// ---------------------------------------------------------------------------
// MutatorDefinition
// ---------------------------------------------------------------------------

export const randomizeMutator: MutatorDefinition<RandomizeSpec> = {
  name: 'mutator.randomize',
  description:
    'Randomize per-target values for color/rotation/scale across N targets. ' +
    'One call emits N × P ops in one atomic dispatch (one undo entry). ' +
    'Ranges are direct (`{h:[0,360], s:[0,1], l:[0,1]}` for color; ' +
    '`{axis,degRange:[min,max]}` for rotation; `{factor:[min,max]}` for scale). ' +
    'Optional `seed` makes the entire sample sequence byte-identically ' +
    'reproducible. Use ScatterNode for position randomization.',
  spec: RandomizeSpec,
  specExample: {
    targetSelectors: ['node_id_a', 'node_id_b'],
    properties: ['color', 'rotation', 'scale'],
    ranges: {
      color: { h: [0, 360], s: [0.5, 1], l: [0.4, 0.6] },
      rotation: { axis: 'random', degRange: [0, 360] },
      scale: { factor: [0.5, 1.5] },
    },
    seed: 42,
  },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    // The CONSERVATIVE static intersection of pre-existing PreservedAspect
    // tokens this Mutator NEVER touches regardless of call-time
    // `properties[]`. `'position'` is the same token at
    // setMaterialColor.ts:34 — NOT an H36-invented preserve. V14 honest
    // distinctness emerges from per-property `lossy.kind` strings + the
    // N × P Op-shape; `preserves` is just an accurate contract disclosure.
    preserves: ['children', 'position'],
    lossy: [
      {
        kind: 'color-jitter',
        reason:
          'Color sampled from declared HSL range; previous color overwritten when "color" ∈ properties.',
      },
      {
        kind: 'rotation-jitter',
        reason:
          'Rotation delta sampled from degRange and added to current rotation when "rotation" ∈ properties.',
      },
      {
        kind: 'scale-jitter',
        reason:
          'Scale factor sampled from declared range and multiplied into size/radius when "scale" ∈ properties.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent'],
    };
  },
  // D-10 anti-silent-skip: enumerate the (target, property) cartesian
  // product; ANY incompatible pair → reject the WHOLE call at gate 4 with
  // the pair named in the reason. No partial emission.
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      if (!node) return { ok: false, reason: `Target "${id}" not in DAG.` };
      const params = node.params as Record<string, unknown> | undefined;
      for (const prop of spec.properties) {
        if (prop === 'color' && !canColor(params)) {
          return {
            ok: false,
            reason:
              `Target "${id}" (${node.type}) has no material.color or color param ` +
              `— incompatible with property "color".`,
          };
        }
        if (prop === 'rotation' && !canRotation(params)) {
          return {
            ok: false,
            reason:
              `Target "${id}" (${node.type}) does not carry a vec3 rotation param ` +
              `— incompatible with property "rotation".`,
          };
        }
        if (prop === 'scale' && !canScale(params)) {
          return {
            ok: false,
            reason:
              `Target "${id}" (${node.type}) has no scalable size/radius param ` +
              `— incompatible with property "scale".`,
          };
        }
      }
    }
    return { ok: true };
  },
  // D-03 determinism contract: rng created ONCE per build() call; iteration
  // order is `for (target of targetSelectors) for (prop of properties)` in
  // spec order so the seed sequence is byte-stable across hosts/runs.
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const rng: () => number =
      spec.seed !== undefined ? mulberry32(spec.seed) : Math.random;
    const ops: Op[] = [];

    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      const params = node.params as Record<string, unknown>;

      for (const prop of spec.properties) {
        if (prop === 'color') {
          // mirror setMaterialColor.ts:62-77 — material.color vs color paramPath
          const hex = sampleHslToHex(rng, spec.ranges.color!);
          if (params.material && typeof params.material === 'object') {
            ops.push({
              type: 'setParam',
              nodeId: id,
              paramPath: 'material.color',
              value: hex,
            });
          } else if (typeof params.color === 'string') {
            ops.push({
              type: 'setParam',
              nodeId: id,
              paramPath: 'color',
              value: hex,
            });
          }
        } else if (prop === 'rotation') {
          // mirror rotate.ts:59-72 — add deltaDeg to current rotation vec3
          const { axis, deltaDeg } = sampleRotationDelta(rng, spec.ranges.rotation!);
          const axisIdx = { x: 0, y: 1, z: 2 }[axis];
          const current = params.rotation as [number, number, number];
          const next: [number, number, number] = [...current];
          next[axisIdx] += deltaDeg;
          ops.push({
            type: 'setParam',
            nodeId: id,
            paramPath: 'rotation',
            value: next,
          });
        } else {
          // scale — mirror scale.ts:67-83 — uniform scalar multiply size or radius
          const factor = sampleScaleFactor(rng, spec.ranges.scale!);
          if (Array.isArray(params.size)) {
            const size = params.size as [number, number, number];
            ops.push({
              type: 'setParam',
              nodeId: id,
              paramPath: 'size',
              value: [size[0] * factor, size[1] * factor, size[2] * factor],
            });
          } else if (typeof params.radius === 'number') {
            ops.push({
              type: 'setParam',
              nodeId: id,
              paramPath: 'radius',
              value: params.radius * factor,
            });
          }
        }
      }
    }

    return ops;
  },
};
