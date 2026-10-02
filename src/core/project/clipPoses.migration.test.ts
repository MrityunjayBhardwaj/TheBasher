// #1227 — v19 → v20: a saved clip's keys (bone INDEX, XYZ euler radians) become timed poses (bone
// NAME, quaternion), the shape the clip value already carried.
//
// The proof material is recorded, not derived: `generated-walk-v19.json` is cut from the shipped
// example's generated walk as saved at format 19 (78 bones, its first 4 frames, 312 keys), and
// `generated-walk-expected.json` holds what that clip evaluated to and sampled to through the code
// as it was BEFORE this change (`a94f7360`). A migrated clip must evaluate to the same poses and
// sample to the same pose between them.
//
// REF: src/core/project/migrations.ts (`migrateClipKeysToPoses`); src/core/import/keyframePoses.ts
//      (`posesFromKeyframes`, the one conversion); issue #1227.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateClipKeysToPoses, migrateProjectFormat } from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';
import {
  AnimationClipNode,
  AnimationClipParams,
  type ClipOutputs,
} from '../../nodes/AnimationClip';
import { SkeletonNode, SkeletonParams } from '../../nodes/Skeleton';
import type { MotionPose, Quat, Vec3 } from '../../nodes/types';

const DIR = resolve(dirname(new URL(import.meta.url).pathname), '__fixtures__/clip-shape');
const read = (name: string) => JSON.parse(readFileSync(resolve(DIR, name), 'utf8'));

interface Expected {
  readonly poses: MotionPose[];
  readonly times: number[];
  readonly samples: { name: string; position: Vec3; quaternion: Quat }[][];
}

type RawNode = { type: string; params: Record<string, unknown>; inputs?: unknown };
type Raw = { formatVersion: number; state: { nodes: Record<string, RawNode> } };

function v19(nodes: Record<string, unknown>): Raw {
  return { formatVersion: 19, state: { nodes } } as Raw;
}

/** The migrated clip node evaluated on its skeleton node, as the evaluator would. */
function evaluateClip(raw: Raw, clipId: string, skeletonId: string): ClipOutputs {
  const nodes = raw.state.nodes;
  const skeleton = SkeletonNode.evaluate(
    SkeletonParams.parse(nodes[skeletonId].params),
    {},
    undefined as never,
  ).out;
  return AnimationClipNode.evaluate(
    AnimationClipParams.parse(nodes[clipId].params),
    { skeleton },
    undefined as never,
  ) as ClipOutputs;
}

afterEach(() => vi.restoreAllMocks());

describe('#1227 — a saved generated walk plays as it did', () => {
  it('migrates on load to stored poses that ARE the poses it evaluated to before', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const expected = read('generated-walk-expected.json') as Expected;
    const out = migrateProjectFormat(read('generated-walk-v19.json')) as Raw;
    expect(out.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    const params = out.state.nodes.motionclip_mujimfon_2.params;
    expect(params).not.toHaveProperty('keyframes');
    expect(params.poses).toEqual(expected.poses);
    // The denominator: 4 frames of all 78 bones, so nothing was dropped on the way.
    expect(expected.poses).toHaveLength(4);
    expect(expected.poses.every((p) => Object.keys(p.bones).length === 78)).toBe(true);
  });

  it('samples between its poses and past its end to the recorded pose, to 1e-6', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const expected = read('generated-walk-expected.json') as Expected;
    const out = migrateProjectFormat(read('generated-walk-v19.json')) as Raw;
    const { pose } = evaluateClip(out, 'motionclip_mujimfon_2', 'motionskel_mujimfon_3');
    let compared = 0;
    expected.times.forEach((t, i) => {
      pose.sample(t).forEach((bone, b) => {
        const want = expected.samples[i][b];
        expect(bone.name).toBe(want.name);
        for (let a = 0; a < 3; a++)
          expect(Math.abs(bone.position[a] - want.position[a])).toBeLessThan(1e-6);
        for (let a = 0; a < 4; a++)
          expect(Math.abs(bone.quaternion[a] - want.quaternion[a])).toBeLessThan(1e-6);
        compared++;
      });
    });
    expect(compared).toBe(3 * 78);
  });
});

describe('#1227 — an index is named through the clip`s own rig', () => {
  const skeleton = (names: string[]) => ({
    type: 'Skeleton',
    params: {
      bones: names.map((name, i) => ({
        name,
        parent: i - 1,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
      })),
    },
  });
  const clip = (keyframes: unknown[], skeletonId = 'sk') => ({
    type: 'AnimationClip',
    params: { name: 'c', duration: 1, keyframes },
    inputs: { skeleton: { node: skeletonId, socket: 'out' } },
  });
  const key = (bone: number, time: number, rotation: Vec3 = [0, 0, 0]) => ({
    bone,
    time,
    position: [0, bone, 0],
    rotation,
  });

  it('a Skeleton names it by its bones, in order; keys at one time are one pose', () => {
    const out = migrateClipKeysToPoses(
      v19({ sk: skeleton(['hips', 'spine']), c: clip([key(1, 0.5), key(0, 0), key(1, 0)]) }),
    ) as Raw;
    const poses = out.state.nodes.c.params.poses as MotionPose[];
    expect(poses.map((p) => p.time)).toEqual([0, 0.5]);
    expect(Object.keys(poses[0].bones).sort()).toEqual(['hips', 'spine']);
    expect(poses[1].bones.spine.position).toEqual([0, 1, 0]);
  });

  it('a euler turns into the quaternion it means', () => {
    const out = migrateClipKeysToPoses(
      v19({ sk: skeleton(['hips']), c: clip([key(0, 0, [0, 0, Math.PI / 2])]) }),
    ) as Raw;
    const q = (out.state.nodes.c.params.poses as MotionPose[])[0].bones.hips.quaternion!;
    [0, 0, Math.SQRT1_2, Math.SQRT1_2].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
  });

  it('a GltfSkeleton names it by its skin`s joint keys', () => {
    const out = migrateClipKeysToPoses(
      v19({
        asset: {
          type: 'GltfAsset',
          params: { skins: [{ jointKeys: ['x'] }, { jointKeys: ['Root', 'Hips'] }] },
        },
        gsk: {
          type: 'GltfSkeleton',
          params: { skinIndex: 1 },
          inputs: { asset: { node: 'asset', socket: 'out' } },
        },
        c: clip([key(1, 0)], 'gsk'),
      }),
    ) as Raw;
    expect(Object.keys((out.state.nodes.c.params.poses as MotionPose[])[0].bones)).toEqual([
      'Hips',
    ]);
  });

  it('a key whose index the rig lacks is dropped and said, by node, never thrown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = migrateClipKeysToPoses(
      v19({ sk: skeleton(['hips']), c: clip([key(0, 0), key(3, 0), key(3, 1)]) }),
    ) as Raw;
    expect(out.state.nodes.c.params.poses).toEqual([
      { time: 0, bones: { hips: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } } },
    ]);
    expect(warn.mock.calls[0][0]).toContain('c (2 of 3)');
  });

  it('a clip with no rig keeps no keys, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = migrateClipKeysToPoses(v19({ c: clip([key(0, 0)], 'missing') })) as Raw;
    expect(out.state.nodes.c.params.poses).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain('c (1 of 1)');
  });

  it('leaves a node that is not a clip, and a clip already holding poses, alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poses = [{ time: 0, bones: {} }];
    const out = migrateClipKeysToPoses(
      v19({
        sk: skeleton(['hips']),
        layer: { type: 'PoseLayer', params: { keyframes: [1] } },
        c: { type: 'AnimationClip', params: { poses } },
      }),
    ) as Raw;
    expect(out.formatVersion).toBe(20);
    expect(out.state.nodes.layer.params).toEqual({ keyframes: [1] });
    expect(out.state.nodes.c.params.poses).toBe(poses);
    expect(warn).not.toHaveBeenCalled();
  });
});
