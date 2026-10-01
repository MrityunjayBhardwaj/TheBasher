// #1226 — a regeneration says what it moved under a layer, through the real cook.
//
// The capability is scripted by seed so each row states exactly what regenerated: seed 8 turns the
// spine 60° everywhere, seed 9 returns seed 7's motion byte for byte under a different request, and
// seed 10 renames the spine. The layer is an additive one on the generated rig's own Object, keyed
// at 0.5 s — the shape a director's "lift" edit takes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useNotificationStore } from '../stores/notificationStore';
import { __resetGeneratedClipsForTests } from '../../core/motiongen/generatedClipCache';
import { STUB_UNIT_SCALE } from '../../core/motiongen/StubMotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationResult,
} from '../../core/motiongen/MotionGenerationCapability';
import type { Op } from '../../core/dag/types';
import { edgeTarget } from '../animate/graphNodes';

/**
 * Hips + Spine, three frames at 0.5 s; the spine's Z rotation from 0.5 s on, and its name, set by the
 * caller. Frame 0 stays neutral, as a generated walk's does: a retarget reads a chain end's first
 * frame as its reference pose, and a turn held from frame 0 would be absorbed there by design.
 */
function bvh(spineZ: number, spine = 'Spine'): string {
  const row = `0 1 0 0 0 0 0 0 ${spineZ}`;
  const rest = '0 1 0 0 0 0 0 0 0';
  return `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT ${spine}
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site
    {
      OFFSET 0.0 0.5 0.0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
${rest}
${row}
${row}
`;
}

const BY_SEED: Record<number, string> = {
  7: bvh(0),
  8: bvh(60),
  9: bvh(0),
  10: bvh(0, 'Chest'),
};

const capability: MotionGenerationCapability = {
  id: 'scripted',
  kind: 'stub',
  isAvailable: async () => true,
  async generate(request): Promise<MotionGenerationResult> {
    const bvh = request.seed === undefined ? undefined : BY_SEED[request.seed];
    if (bvh === undefined) throw new Error(`no scripted motion for seed ${request.seed}`);
    return {
      jobId: `job-${request.seed}`,
      bvh,
      model: request.model,
      unitScale: STUB_UNIT_SCALE,
      worldOffsetXZ: null,
      worldRotationRadians: null,
    };
  },
  cancel: async () => {},
};
vi.mock('../boot', () => ({ getMotionCapability: async () => capability }));

// Imported AFTER vi.mock so the module picks up the mocked boot.
import { cookMotionGenerations } from './cookMotionGenerations';
import { mintMotionGenerateOps } from './mintMotionGenerate';
import { regenerationShifts } from './regenerationShift';
import { validatePlan } from '../../agent/mutators/index';
import { retargetMutator } from '../../agent/mutators/builders/retarget';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import { bakePose } from '../animate/bakePose';
import { evaluate } from '../../core/dag/evaluator';
import type { PosedSkeletonValue } from '../../nodes/types';

const store = () => useDagStore.getState();
const dispatch = (ops: Op[]) => store().dispatchAtomic(ops, 'user', 'test');

/** A generated walk, cooked once, on its own Object, with an additive layer keyed on the spine. */
function emptyProject(): void {
  store().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
}

/** A generated walk, cooked once, on its own Object, under a layer on the spine: additive and keyed
 *  at 0.5 s unless `layer` says otherwise. Into the current project, or a fresh one. */
async function layeredWalk(
  opts: { fresh?: boolean; layerId?: string; layer?: Record<string, unknown> } = {},
): Promise<{ producerId: string; clipId: string; objectId: string }> {
  if (opts.fresh !== false) emptyProject();
  const layerId = opts.layerId ?? 'layer_lift';
  const minted = mintMotionGenerateOps(store().state, {
    prompt: 'walk',
    seed: 7,
    model: 'kimodo-base',
  });
  dispatch(minted.ops as Op[]);
  await cookMotionGenerations();
  const objectId = minted.objectId!;
  dispatch([
    {
      type: 'addNode',
      nodeId: layerId,
      nodeType: 'PoseLayer',
      params: opts.layer ?? {
        name: 'lift spine',
        mode: 'additive',
        members: [{ bone: 'Spine', rotationMode: 'XYZ' }],
        channels: [
          {
            bone: 'Spine',
            component: 'rotation',
            keyframes: [{ time: 0.5, value: [10, 0, 0], easing: 'linear' }],
          },
        ],
      },
    },
    {
      type: 'connect',
      from: { node: minted.clipId, socket: 'pose' },
      to: { node: layerId, socket: 'pose' },
    },
    {
      type: 'connect',
      from: { node: layerId, socket: 'out' },
      to: { node: objectId, socket: 'pose' },
      replace: true,
    },
  ] as Op[]);
  expect(edgeTarget(store().state.nodes[objectId], 'pose')).toBe(layerId);
  return { producerId: minted.producerId, clipId: minted.clipId, objectId };
}

async function regenerate(producerId: string, seed: number): Promise<void> {
  useNotificationStore.getState().clear();
  dispatch([{ type: 'setParam', nodeId: producerId, paramPath: 'seed', value: seed }] as Op[]);
  const out = await cookMotionGenerations(producerId);
  expect(out).toMatchObject({ generated: 1, baked: 1 });
}

const toasts = () => useNotificationStore.getState().toasts;

describe('a regeneration names what it moved under a layer (#1226)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
    useAssetErrorStore.getState().clearAll();
    useNotificationStore.getState().clear();
  });

  it('a spine that turns 60° under the layer is named, with the layer and the amount', async () => {
    const { producerId } = await layeredWalk();
    await regenerate(producerId, 8);

    const warn = toasts().filter((t) => t.severity === 'warn');
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain('"lift spine" Spine moved 60° at 0.50 s');
    // It stays until read.
    expect(warn[0].durationMs).toBe(0);
  });

  it('the same motion under a new request moves nothing, and says it looked', async () => {
    const { producerId } = await layeredWalk();
    await regenerate(producerId, 9);

    expect(toasts().filter((t) => t.severity === 'warn')).toEqual([]);
    expect(toasts().map((t) => t.message)).toEqual([
      'Regenerated: 1 layer compared, no result moved.',
    ]);
  });

  it('a member whose bone the new rig lacks is said, never passed as unmoved', async () => {
    const { producerId } = await layeredWalk();
    await regenerate(producerId, 10);

    const messages = toasts().map((t) => t.message);
    expect(messages).toEqual([
      'Could not compare every layer after regenerating: "lift spine": Spine is not in the rig on both sides.',
    ]);
  });

  it('a muted layer plays nothing, so it is counted apart and never named as moved', async () => {
    const { producerId } = await layeredWalk();
    dispatch([{ type: 'setParam', nodeId: 'layer_lift', paramPath: 'mute', value: true }] as Op[]);
    const before = store().state;
    await regenerate(producerId, 8);
    const report = regenerationShifts(before, store().state, [
      edgeTarget(store().state.nodes.layer_lift, 'pose')!,
    ]);
    expect(report).toMatchObject({ compared: 0, muted: 1, moved: [], uncompared: [] });
    expect(toasts()).toEqual([]);
  });

  it('a first cook compares nothing, even under a layer: there was no motion to move', async () => {
    const { producerId, clipId } = await layeredWalk();
    // Back to a clip that was never baked, with the layer still on it: the state a first cook sees
    // when a layer was wired before anything generated.
    dispatch([
      { type: 'setParam', nodeId: clipId, paramPath: 'keyframes', value: [] },
      { type: 'setParam', nodeId: clipId, paramPath: 'sourceHash', value: '' },
    ] as Op[]);
    useNotificationStore.getState().clear();
    __resetGeneratedClipsForTests();
    const out = await cookMotionGenerations(producerId);
    expect(out).toMatchObject({ generated: 1, baked: 1 });
    expect(toasts()).toEqual([]);
  });

  it('a layer with no keys is compared at the frames of the motion under it', async () => {
    const { producerId } = await layeredWalk({
      layer: {
        name: 'hold spine',
        mode: 'additive',
        members: [{ bone: 'Spine', rotationMode: 'XYZ', rotation: [10, 0, 0] }],
      },
    });
    await regenerate(producerId, 8);
    // Its first frame of full size: nothing keys this layer, so the motion's own frames are where it looked.
    expect(toasts().map((t) => t.message)).toEqual([
      'The regenerated motion moved layered results: "hold spine" Spine moved 60° at 0.50 s. ' +
        'To keep a character as it is through the next regeneration, select it and use “bake motion to keys”.',
    ]);
  });

  it("another motion's layers are not compared: only what stands on the regenerated clip", async () => {
    const first = await layeredWalk();
    await layeredWalk({ fresh: false, layerId: 'layer_other' });
    await regenerate(first.producerId, 8);
    const [warn] = toasts();
    expect(warn.message).toContain('"lift spine" Spine moved 60°');
    expect(toasts()).toHaveLength(1);
    // One layer named, not two: the second walk's layer reads a clip nobody regenerated.
    expect(warn.message.match(/moved 60°/g)).toHaveLength(1);
  });

  it("another motion's layers are not even counted as compared", async () => {
    const first = await layeredWalk();
    await layeredWalk({ fresh: false, layerId: 'layer_other' });
    await regenerate(first.producerId, 9);
    // A reach that took every layered Object would compare the untouched walk too and say 2 here.
    expect(toasts().map((t) => t.message)).toEqual([
      'Regenerated: 1 layer compared, no result moved.',
    ]);
  });

  it('a layer on a character the motion reaches through a retarget is compared too', async () => {
    const { producerId, clipId } = await layeredWalk();
    const sourceSkeletonId = edgeTarget(store().state.nodes[clipId], 'skeleton')!;
    const bones = (store().state.nodes[sourceSkeletonId].params as { bones: unknown[] }).bones;
    // A character of its own: a rig standing at rest, as a dropped model's does.
    const stand = buildSkeletonObjectOps({
      skeletonId: 'tskel',
      bones: bones as never,
      sceneNodeId: 'n_scene',
      normalise: false,
      name: 'hero',
      pose: { node: 'tskel', socket: 'pose' },
      nameFollowsClip: false,
    });
    dispatch([
      { type: 'addNode', nodeId: 'tskel', nodeType: 'Skeleton', params: { bones } },
      ...stand.ops,
    ] as Op[]);
    // The bind, by the product's own mutator: the retarget becomes the character's pose.
    const bind = validatePlan(
      retargetMutator,
      {
        sourceId: clipId,
        sourceSkeletonId,
        targetSkeletonId: 'tskel',
        customMap: { Hips: 'Hips', Spine: 'Spine' },
        outputClipId: 'retarget',
      },
      store().state,
      'bind',
    );
    if (!bind.ok) throw new Error(bind.reason);
    dispatch(bind.ops as Op[]);
    expect(edgeTarget(store().state.nodes[stand.objectId], 'pose')).toBe('retarget');
    dispatch([
      {
        type: 'addNode',
        nodeId: 'layer_hero',
        nodeType: 'PoseLayer',
        params: {
          name: 'hero lean',
          mode: 'additive',
          members: [{ bone: 'Spine', rotationMode: 'XYZ' }],
          channels: [
            {
              bone: 'Spine',
              component: 'rotation',
              keyframes: [{ time: 1, value: [0, 5, 0], easing: 'linear' }],
            },
          ],
        },
      },
      {
        type: 'connect',
        from: { node: 'retarget', socket: 'posed' },
        to: { node: 'layer_hero', socket: 'pose' },
      },
      {
        type: 'connect',
        from: { node: 'layer_hero', socket: 'out' },
        to: { node: stand.objectId, socket: 'pose' },
        replace: true,
      },
    ] as Op[]);

    await regenerate(producerId, 8);
    const [warn] = toasts();
    expect(warn.message).toContain('"lift spine" Spine moved 60° at 0.50 s');
    expect(warn.message).toContain('"hero lean" Spine moved 60° at 1.00 s');
  });
});

// #1230 — freezing a character: its computed motion baked to keys. The bake detaches the computed
// source from the character's chain, so a later regeneration has nothing of that character to write.
describe('a character whose motion was baked to keys is not moved by a regeneration (#1230)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
    useAssetErrorStore.getState().clearAll();
    useNotificationStore.getState().clear();
  });

  /** The Spine's rotation in the pose the Object is handed, at each of the walk's three frames. */
  function spineAt(objectId: string): number[][] {
    const top = edgeTarget(store().state.nodes[objectId], 'pose')!;
    const pose = evaluate(store().state, top).value as PosedSkeletonValue;
    return [0, 0.5, 1].map((t) => {
      const spine = pose.sample(t).find((b) => b.name === 'Spine')!;
      return [...spine.quaternion];
    });
  }

  /** The largest angle, in degrees, between two samplings of the same three frames. */
  function turned(was: number[][], now: number[][]): number {
    return Math.max(
      ...was.map((a, i) => {
        const b = now[i];
        const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
        return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      }),
    );
  }

  function bake(objectId: string): void {
    const baked = bakePose(store().state, {
      object: objectId,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId: `${objectId}_frozen`,
    });
    if (!baked.ok) throw new Error(baked.reason);
    expect(baked.report.detached).not.toBeNull();
    dispatch(baked.ops as Op[]);
  }

  it('the baked character holds its pose at every frame; the unbaked one turns 60°', async () => {
    const frozen = await layeredWalk();
    const live = await layeredWalk({ fresh: false, layerId: 'layer_live' });
    bake(frozen.objectId);

    const frozenWas = spineAt(frozen.objectId);
    const liveWas = spineAt(live.objectId);
    await regenerate(frozen.producerId, 8);
    // The same request again: served from the clip cache, so it bakes without generating.
    dispatch([{ type: 'setParam', nodeId: live.producerId, paramPath: 'seed', value: 8 }] as Op[]);
    expect(await cookMotionGenerations(live.producerId)).toMatchObject({ baked: 1 });

    expect(turned(frozenWas, spineAt(frozen.objectId))).toBeLessThan(1e-4);
    // The control: the same regeneration on a character that was not baked.
    expect(turned(liveWas, spineAt(live.objectId))).toBeGreaterThan(59);
  });

  it('its layers are not reported as moved: nothing regenerated under them', async () => {
    const { producerId, objectId } = await layeredWalk();
    bake(objectId);
    await regenerate(producerId, 8);
    expect(toasts()).toEqual([]);
  });

  it('a notice that names a moved layer says how to freeze a character', async () => {
    const { producerId } = await layeredWalk();
    await regenerate(producerId, 8);
    const [warn] = toasts().filter((t) => t.severity === 'warn');
    expect(warn.message).toContain('“bake motion to keys”');
  });

  it('a notice with nothing moved does not bring it up', async () => {
    const { producerId } = await layeredWalk();
    await regenerate(producerId, 9);
    expect(
      toasts()
        .map((t) => t.message)
        .join(' '),
    ).not.toContain('bake');
  });
});
