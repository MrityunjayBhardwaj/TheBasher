// #1211 / #1212 — a skinned-bar exported from Blender with EVERY exporter option at its default,
// and one with Bone1's scale keyed away from its rest, each deformed natively and compared with
// Blender 5.1.1 deforming the same file (step 4 of "Bones as Channels", #1233).
//
// The default export writes 5 of the bar's 6 bone channels as 2-key STEP (the exporter's
// `sampled/armature/sampler.py:218-227`); the reader refused that file until #1211. The scale file's
// Bone1 scale is keyed (1,1,1) @0, (1.5,1,1) @12, (0.6,1.8,1.2) @24 and sampled per frame; the reader
// refused a scale away from rest until #1212. Both files arrive as keys on the base pose layer.
//
// Oracle: `ref/probes/blender-native-character/q1211_default_export_oracle.py` (builds both fixtures,
// byte-reproducible, and dumps every vertex's rest → deformed position in glTF axes). The exporter
// samples every frame, so frames 0/6/12/18/24 are key times, where Blender's interpolation and
// ours agree exactly. Vertices are joined by rest position (Blender keeps 6, so do we).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from './registerAll';
import { applyOp } from '../core/dag/ops';
import { evaluate } from '../core/dag';
import { sampleSkinDeform } from './armatureDeform';
import type { ModifiedDataValue } from './types';
import { sceneOnlyState } from '../test-utils/sceneOnlyState';

type Oracle = Record<number, readonly (readonly [readonly number[], readonly number[]])[]>;

/** Blender 5.1.1, `skinned-bar-default.glb`: [rest, deformed] per vertex, per frame. */
const DEFAULT_EXPORT: Oracle = {
  0: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.2, 2.0, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [0.2, 2.0, 0.0],
    ],
  ],
  6: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.537443, 1.866692, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-0.162758, 2.006732, 0.0],
    ],
  ],
  12: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.823046, 1.602159, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-0.528135, 1.872395, 0.0],
    ],
  ],
  18: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.988716, 1.249882, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-0.816553, 1.610935, 0.0],
    ],
  ],
  24: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-1.013626, 0.887917, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-0.978764, 1.286394, 0.0],
    ],
  ],
};

/** Blender 5.1.1, `skinned-bar-keyed-scale.glb`: [rest, deformed] per vertex, per frame. */
const KEYED_SCALE: Oracle = {
  0: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.2, 2.0, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [0.2, 2.0, 0.0],
    ],
  ],
  6: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.584279, 1.849187, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-0.115923, 2.024237, 0.0],
    ],
  ],
  12: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-0.896774, 1.5346, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-0.454407, 1.939954, 0.0],
    ],
  ],
  18: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-1.354074, 1.413018, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-1.173302, 1.792125, 0.0],
    ],
  ],
  24: [
    [
      [-0.2, -0.0, 0.0],
      [-0.2, -0.0, 0.0],
    ],
    [
      [-0.2, 1.0, 0.0],
      [-0.2, 1.0, 0.0],
    ],
    [
      [-0.2, 2.0, 0.0],
      [-1.803609, 1.037337, 0.0],
    ],
    [
      [0.2, 0.0, -0.0],
      [0.2, 0.0, -0.0],
    ],
    [
      [0.2, 1.0, 0.0],
      [0.2, 1.0, 0.0],
    ],
    [
      [0.2, 2.0, 0.0],
      [-1.782692, 1.276423, 0.0],
    ],
  ],
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

async function deformedAt(file: string) {
  const bytes = readFileSync(`public/assets/${file}`);
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: `user-imports/native/${file}`,
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state = sceneOnlyState();
  for (const op of result.ops) state = applyOp(state, op).next;
  const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const value = evaluate(state, modifierId, {
    ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
  }).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh' || !value.skin) throw new Error('no skinned mesh');
  const mesh = descriptor.data;
  const key = (p: ArrayLike<number>, i: number) =>
    // Rounded to 1e-4, with -0 written as 0, so a float32 rest meets Blender's printed one.
    [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]
      .map((v) => String(Math.round(v * 1e4) / 1e4 + 0))
      .join(',');
  return {
    state,
    count: mesh.points.length / 3,
    at: (frame: number) => {
      const out = sampleSkinDeform(value.skin!, mesh, frame / 24);
      const byRest = new Map<string, number[]>();
      for (let i = 0; i < mesh.points.length / 3; i++) {
        byRest.set(key(mesh.points, i), [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
      }
      return (rest: readonly number[]) => byRest.get(key(rest, 0));
    },
  };
}

describe.each([
  [
    'skinned-bar-default.glb',
    'every exporter option at default: 5 of 6 channels STEP',
    DEFAULT_EXPORT,
  ],
  ['skinned-bar-keyed-scale.glb', 'Bone1 scale keyed away from rest', KEYED_SCALE],
] as const)('%s, %s — deforms as Blender deforms it', (file, _why, oracle) => {
  it('reads natively, onto the base pose layer', async () => {
    const { state, count } = await deformedAt(file);
    expect(Object.values(state.nodes).filter((n) => n.type === 'PoseLayer')).toHaveLength(1);
    expect(Object.values(state.nodes).some((n) => n.type === 'AnimationClip')).toBe(false);
    expect(count).toBe(oracle[0].length);
  });

  it.each([0, 6, 12, 18, 24])(
    'frame %i: every vertex where Blender puts it, to 1e-5',
    async (frame) => {
      const { at } = await deformedAt(file);
      const ours = at(frame);
      let compared = 0;
      for (const [rest, want] of oracle[frame]) {
        const got = ours(rest);
        expect(got, `vertex resting at ${rest}`).toBeDefined();
        want.forEach((c, k) => expect(got![k], `${rest} axis ${k}`).toBeCloseTo(c, 5));
        compared++;
      }
      expect(compared).toBe(oracle[frame].length);
    },
  );
});
