// #1339 — the agent builds a skeleton by hand through `mutator.rig.editSkeleton`, and every edit
// undoes to the graph before it exactly.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../../core/dag';
import { useDagStore } from '../../../core/dag/store';
import { buildDefaultDagState } from '../../../core/project/default';
import { registerAllNodes } from '../../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators, getMutator } from '..';
import { useDiffStore } from '../../diff/store';
import { buildAddPrimitiveOps } from '../../../app/addPrimitives';
import { dispatchMutatorFromUI } from '../../../app/animate/dispatchMutator';
import type { BoneSpec } from '../../../nodes/types';

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
