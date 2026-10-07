// #1339 — the agent builds a skeleton by hand through `mutator.rig.editSkeleton`, and every edit
// undoes to the graph before it exactly.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../../core/dag';
import { Quaternion } from 'three';
import { restBonePose } from '../../../nodes/bonePose';
import { useDagStore } from '../../../core/dag/store';
import { buildDefaultDagState } from '../../../core/project/default';
import { registerAllNodes } from '../../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators, getMutator } from '..';
import { useDiffStore } from '../../diff/store';
import { buildAddPrimitiveOps } from '../../../app/addPrimitives';
import { dispatchMutatorFromUI } from '../../../app/animate/dispatchMutator';
import type { BoneSpec, PosedSkeletonValue } from '../../../nodes/types';
import type { Op } from '../../../core/dag/types';
import { mirroredBoneMapOps } from '../../../app/animate/renameBone';
import { flipSideName } from '../../../app/animate/editSkeleton';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

function armature(): { object: string; skeleton: string } {
  let state = buildDefaultDagState();
  const r = buildAddPrimitiveOps(state, 'Armature', [0, 0, 0])!;
  for (const op of r.ops) state = applyOp(state, op).next;
  useDagStore.getState().hydrate(state);
  return { object: r.newNodeId, skeleton: r.dataNodeId! };
}
const bones = (skeleton: string) =>
  (useDagStore.getState().state.nodes[skeleton].params as { bones: BoneSpec[] }).bones;
const edit = (object: string, e: unknown) =>
  dispatchMutatorFromUI('mutator.rig.editSkeleton', { object, edit: e }, 'edit');

describe('#1339 — mutator.rig.editSkeleton', () => {
  it('builds a chain, subdivides it, re-parents, and each step undoes exactly', () => {
    const { object, skeleton } = armature();
    const graphs: string[] = [JSON.stringify(useDagStore.getState().state.nodes)];
    const steps = [
      { op: 'extrude', from: 'Bone_end' },
      { op: 'extrude', from: 'Bone_end_001' },
      { op: 'subdivide', bone: 'Bone_end', cuts: 1 },
      { op: 'parent', bone: 'Bone_end_002', parent: 'Bone' },
    ];
    for (const step of steps) {
      const res = edit(object, step);
      expect(res.ok, `${step.op}: ${JSON.stringify(res)}`).toBe(true);
      graphs.push(JSON.stringify(useDagStore.getState().state.nodes));
    }
    expect(bones(skeleton).map((b) => [b.name, b.parent])).toEqual([
      ['Bone', -1],
      ['Bone_end', 0],
      ['Bone_end_001', 4],
      ['Bone_end_002', 0],
      ['Bone_end_003', 1],
    ]);
    for (let k = steps.length; k > 0; k--) {
      useDagStore.getState().undo();
      expect(JSON.stringify(useDagStore.getState().state.nodes), `undo of step ${k}`).toBe(
        graphs[k - 1],
      );
    }
  });

  it('#1344 — sets a bone’s joint limits, undoes exactly, and refuses a range that cannot hold', () => {
    const { object, skeleton } = armature();
    const before = JSON.stringify(useDagStore.getState().state.nodes);
    const res = edit(object, { op: 'limits', bone: 'Bone', limits: { x: [-0.5, 1.2] } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(bones(skeleton)[0].limits).toEqual({ x: [-0.5, 1.2] });
    const held = useDagStore.getState().state;
    for (const bad of [{ x: [1, 0] }, { z: [-4, 0] }]) {
      expect(
        edit(object, { op: 'limits', bone: 'Bone', limits: bad }).ok,
        JSON.stringify(bad),
      ).toBe(false);
      expect(useDagStore.getState().state).toBe(held);
    }
    expect(edit(object, { op: 'limits', bone: 'Bone', limits: null }).ok).toBe(true);
    expect('limits' in bones(skeleton)[0]).toBe(false);
    useDagStore.getState().undo();
    useDagStore.getState().undo();
    expect(JSON.stringify(useDagStore.getState().state.nodes)).toBe(before);
  });

  it('refuses what it cannot do by saying why, and writes nothing', () => {
    const { object } = armature();
    const before = useDagStore.getState().state;
    const res = edit(object, { op: 'subdivide', bone: 'Bone_end', cuts: 1 });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/no child/);
    expect(useDagStore.getState().state).toBe(before);
    const notRig = edit(useDagStore.getState().state.outputs.scene!.node, {
      op: 'reroot',
      bone: 'Bone',
    });
    expect((notRig as { reason: string }).reason).toMatch(/not an armature Object/);
  });

  it('a delete names the pose layer still posing the bone it removed', () => {
    const { object } = armature();
    expect(
      dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object, bone: 'Bone_end', rotation: [0, 0, 10] },
        'pose',
      ).ok,
    ).toBe(true);
    const m = getMutator('mutator.rig.editSkeleton')!;
    const state = useDagStore.getState().state;
    const spec = m.spec.parse({ object, edit: { op: 'delete', bone: 'Bone_end' } });
    const notes = m.advisories!(spec, { nodes: new Set() } as never, state);
    expect(notes.join('\n')).toMatch(/still poses or keys "Bone_end"/);
  });

  it('a hand-built armature takes a hand-pose on one bone and then another (#1339)', () => {
    const { object } = armature();
    for (const bone of ['Bone', 'Bone_end']) {
      const res = dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object, bone, rotation: [0, 0, 15] },
        'pose',
      );
      expect(res.ok, `${bone}: ${JSON.stringify(res)}`).toBe(true);
    }
  });
});

describe('#1341 — symmetrize gives the twins their retarget bone-map entries', () => {
  const BODY: BoneSpec[] = [
    { name: 'Spine', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
    { name: 'Arm_L', parent: 0, position: [0.3, 0.4, 0], rotation: [0, 0, -0.9] },
    { name: 'Hand_L', parent: 1, position: [0, 0.5, 0], rotation: [0, 0, 0] },
  ];
  const bone = (name: string): BoneSpec => ({
    name,
    parent: -1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  });
  /**
   * The armature with BODY, a second rig `other` with `otherBones`, and one retarget per entry of
   * `retargets` between them, each reading map `m` (or the map it names).
   */
  function rigged(
    otherBones: string[],
    map: Record<string, string>,
    retargets: { source: 'body' | 'other' | 'none'; target: 'body' | 'other'; map?: string }[],
  ) {
    const { object, skeleton } = armature();
    const ops: Op[] = [
      { type: 'setParam', nodeId: skeleton, paramPath: 'bones', value: BODY },
      {
        type: 'addNode',
        nodeId: 'other',
        nodeType: 'Skeleton',
        params: { bones: otherBones.map(bone) },
      },
      { type: 'addNode', nodeId: 'm', nodeType: 'BoneNameMap', params: { map } },
      { type: 'addNode', nodeId: 'm2', nodeType: 'BoneNameMap', params: { map: {} } },
    ] as Op[];
    const sk = (side: 'body' | 'other') => (side === 'body' ? skeleton : 'other');
    retargets.forEach((r, i) => {
      const id = `rt_${i}`;
      ops.push({ type: 'addNode', nodeId: id, nodeType: 'RetargetClip', params: {} } as Op);
      if (r.source !== 'none') {
        ops.push({
          type: 'connect',
          from: { node: sk(r.source), socket: 'pose' },
          to: { node: id, socket: 'source' },
        } as Op);
      }
      ops.push(
        {
          type: 'connect',
          from: { node: sk(r.target), socket: 'out' },
          to: { node: id, socket: 'skeleton' },
        } as Op,
        {
          type: 'connect',
          from: { node: r.map ?? 'm', socket: 'out' },
          to: { node: id, socket: 'boneMap' },
        } as Op,
      );
    });
    let state = useDagStore.getState().state;
    for (const op of ops) state = applyOp(state, op).next;
    useDagStore.getState().hydrate(state);
    return { object, skeleton };
  }
  const mapOf = (id = 'm') =>
    (useDagStore.getState().state.nodes[id].params as { map: Record<string, string> }).map;
  const symmetrize = (object: string, list = ['Arm_L', 'Hand_L']) =>
    edit(object, { op: 'symmetrize', bones: list });
  const OTHER = ['Hips', 'LeftArm', 'LeftHand', 'RightArm', 'RightHand'];
  const MAP = { Hips: 'Spine', LeftArm: 'Arm_L', LeftHand: 'Hand_L' };

  it('this rig as the target: each mirrored bone is mapped from the flipped source bone, in one undo step', () => {
    const { object, skeleton } = rigged(OTHER, MAP, [{ source: 'other', target: 'body' }]);
    const before = JSON.stringify(useDagStore.getState().state.nodes);
    expect(symmetrize(object).ok).toBe(true);
    expect(bones(skeleton).map((b) => b.name)).toContain('Hand_R');
    expect(mapOf()).toEqual({ ...MAP, RightArm: 'Arm_R', RightHand: 'Hand_R' });
    useDagStore.getState().undo();
    expect(JSON.stringify(useDagStore.getState().state.nodes)).toBe(before);
  });

  it('a source bone with no twin on the motion’s rig is not invented', () => {
    const { object } = rigged(['Hips', 'LeftArm', 'LeftHand', 'RightArm'], MAP, [
      { source: 'other', target: 'body' },
    ]);
    expect(symmetrize(object).ok).toBe(true);
    expect(mapOf()).toEqual({ ...MAP, RightArm: 'Arm_R' });
  });

  it('only the bones symmetrized are mapped, and a twin already mapped is left as it is', () => {
    const { object } = rigged(OTHER, MAP, [{ source: 'other', target: 'body' }]);
    expect(symmetrize(object, ['Arm_L']).ok).toBe(true);
    expect(mapOf()).toEqual({ ...MAP, RightArm: 'Arm_R' });
    // The director re-points the right arm, then symmetrizes again: the entry is theirs.
    const state = applyOp(useDagStore.getState().state, {
      type: 'setParam',
      nodeId: 'm',
      paramPath: 'map',
      value: { Hips: 'Spine', LeftArm: 'Arm_L', LeftHand: 'Hand_L', RightHand: 'Arm_R' },
    } as Op).next;
    useDagStore.getState().hydrate(state);
    expect(symmetrize(object, ['Arm_L']).ok).toBe(true);
    expect(mapOf()).toEqual({
      Hips: 'Spine',
      LeftArm: 'Arm_L',
      LeftHand: 'Hand_L',
      RightHand: 'Arm_R',
    });
  });

  it('the mapped twin then moves with the motion: the retarget turns Arm_R when the source’s RightArm turns', () => {
    const { object, skeleton } = rigged(OTHER, MAP, [{ source: 'none', target: 'body' }]);
    // The motion: the other rig with its RightArm keyed 60° about Z for a second (a base layer).
    let state = useDagStore.getState().state;
    for (const op of [
      {
        type: 'addNode',
        nodeId: 'motion',
        nodeType: 'PoseLayer',
        params: {
          members: [{ bone: 'RightArm', rotationMode: 'XYZ' }],
          channels: [
            {
              bone: 'RightArm',
              component: 'rotation',
              keyframes: [
                { time: 0, value: [0, 0, 60], easing: 'linear' },
                { time: 1, value: [0, 0, 60], easing: 'linear' },
              ],
            },
          ],
        },
      },
      {
        type: 'connect',
        from: { node: 'other', socket: 'pose' },
        to: { node: 'motion', socket: 'pose' },
      },
      {
        type: 'connect',
        from: { node: 'motion', socket: 'out' },
        to: { node: 'rt_0', socket: 'source' },
      },
    ] as Op[]) {
      state = applyOp(state, op).next;
    }
    useDagStore.getState().hydrate(state);
    const armTurn = () => {
      const now = useDagStore.getState().state;
      const at = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } }, socket: 'posed' };
      const wire = evaluate(now, 'rt_0', at).value as PosedSkeletonValue;
      const i = bones(skeleton).findIndex((b) => b.name === 'Arm_R');
      const rest = restBonePose(bones(skeleton)[i]).quaternion;
      return new Quaternion(...wire.sample(0)[i].quaternion).angleTo(new Quaternion(...rest));
    };
    expect(symmetrize(object).ok).toBe(true);
    expect(mapOf().RightArm).toBe('Arm_R');
    expect(armTurn()).toBeGreaterThan(0.5);
    // Without the entry the twin stands at rest: the entry is what carries the motion.
    const { RightArm: _gone, ...without } = mapOf();
    void _gone;
    useDagStore.getState().hydrate(
      applyOp(useDagStore.getState().state, {
        type: 'setParam',
        nodeId: 'm',
        paramPath: 'map',
        value: without,
      } as Op).next,
    );
    expect(armTurn()).toBeLessThan(1e-6);
  });

  it('a twin that exists but was not symmetrized this time gets no entry', () => {
    const { object } = rigged(OTHER, MAP, [{ source: 'other', target: 'body' }]);
    expect(symmetrize(object).ok).toBe(true);
    // Both right bones exist now. Drop their entries, then symmetrize the arm alone.
    useDagStore.getState().hydrate(
      applyOp(useDagStore.getState().state, {
        type: 'setParam',
        nodeId: 'm',
        paramPath: 'map',
        value: MAP,
      } as Op).next,
    );
    expect(symmetrize(object, ['Arm_L']).ok).toBe(true);
    expect(mapOf()).toEqual({ ...MAP, RightArm: 'Arm_R' });
  });

  it('a source bone already mapped elsewhere keeps its entry', () => {
    const taken = { ...MAP, RightArm: 'Spine' };
    const { object } = rigged(OTHER, taken, [{ source: 'other', target: 'body' }]);
    expect(symmetrize(object).ok).toBe(true);
    expect(mapOf()).toEqual({ ...taken, RightHand: 'Hand_R' });
  });

  it('this rig as the motion: the twin is the key, the target’s flipped bone the value', () => {
    const { object } = rigged(
      ['Hips', 'LeftArm', 'RightArm'],
      { Spine: 'Hips', Arm_L: 'LeftArm', Hand_L: 'Hips' },
      [{ source: 'body', target: 'other' }],
    );
    expect(symmetrize(object).ok).toBe(true);
    // Hand_L drives a bone with no side: not mirrored.
    expect(mapOf()).toEqual({ Spine: 'Hips', Arm_L: 'LeftArm', Hand_L: 'Hips', Arm_R: 'RightArm' });
  });

  it('a map another rig shares, or read from a motion the graph cannot name, is left and said', () => {
    for (const [retargets, why] of [
      [
        [
          { source: 'other', target: 'body' },
          { source: 'body', target: 'other' },
        ],
        /shared with another rig/,
      ],
      [[{ source: 'none', target: 'body' }], /graph does not say/],
    ] as const) {
      __resetRegistryForTests();
      registerAllNodes();
      const { object } = rigged(OTHER, MAP, [...retargets]);
      const state = useDagStore.getState().state;
      const after = [...BODY, bone('Arm_R'), bone('Hand_R')];
      const r = mirroredBoneMapOps(state, object, ['Arm_L', 'Hand_L'], after, flipSideName);
      expect(r.ops).toEqual([]);
      expect(r.left.map((l) => l.node)).toEqual(['m']);
      expect(r.left[0].why).toMatch(why);
      expect(symmetrize(object).ok).toBe(true);
      expect(mapOf()).toEqual(MAP);
    }
  });

  it('a symmetrize with no retarget in the graph writes the skeleton and nothing else', () => {
    const { object, skeleton } = armature();
    useDagStore.getState().hydrate(
      applyOp(useDagStore.getState().state, {
        type: 'setParam',
        nodeId: skeleton,
        paramPath: 'bones',
        value: BODY,
      } as Op).next,
    );
    const state = useDagStore.getState().state;
    expect(
      mirroredBoneMapOps(state, object, ['Arm_L'], [...BODY, bone('Arm_R')], flipSideName),
    ).toEqual({
      ops: [],
      mirrored: [],
      left: [],
    });
  });
});
