// #1539, #1356 — the agent's bind passes the method and its settings through to the same plan the panel
// runs, and a setting it leaves out takes the Capture node's own default.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../../../core/dag/ops';
import { __resetRegistryForTests } from '../../../core/dag/registry';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { registerAllNodes } from '../../../nodes/registerAll';
import { captureStatusOf } from '../../../app/animate/bindSkin';
import { sceneOnlyState } from '../../../test-utils/sceneOnlyState';
import { BIND, skinBindSceneOps } from '../../../test-utils/skinBindScene';
import { bindSkinMutator } from './bindSkin';

const run = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

let scene: DagState;
beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  scene = run(sceneOnlyState(), skinBindSceneOps());
});

describe('#1539 — mutator.rig.bindSkin takes the method', () => {
  it('method "voxel" with a resolution binds by the volume, and says what it bound', () => {
    const spec = bindSkinMutator.spec.parse({
      mesh: BIND.mesh,
      armature: BIND.armature,
      method: 'voxel',
      resolution: 48,
    });
    expect(bindSkinMutator.preconditions!(spec, {} as never, scene)).toEqual({ ok: true });
    const next = run(scene, bindSkinMutator.build(spec, {} as never, scene));
    const capture = Object.values(next.nodes).find((n) => n.type === 'CaptureModifier')!;
    expect(capture.params).toMatchObject({ method: 'voxel', resolution: 48, falloff: 0.2 });
    expect(captureStatusOf(next, capture.id)).toMatchObject({ kind: 'captured', method: 'voxel' });
    expect(bindSkinMutator.advisories!(spec, {} as never, scene)).toEqual([
      '104 points bound to 3 bones.',
    ]);
  });

  it('method "heat" binds along the surface: no setting of its own, and the same sentence back', () => {
    const spec = bindSkinMutator.spec.parse({
      mesh: BIND.mesh,
      armature: BIND.armature,
      method: 'heat',
    });
    expect(bindSkinMutator.preconditions!(spec, {} as never, scene)).toEqual({ ok: true });
    const next = run(scene, bindSkinMutator.build(spec, {} as never, scene));
    const capture = Object.values(next.nodes).find((n) => n.type === 'CaptureModifier')!;
    expect(capture.params).toMatchObject({ method: 'heat', maxInfluences: 4 });
    expect(captureStatusOf(next, capture.id)).toMatchObject({ kind: 'captured', method: 'heat' });
    expect(bindSkinMutator.advisories!(spec, {} as never, scene)).toEqual([
      '104 points bound to 3 bones.',
    ]);
    expect(bindSkinMutator.description).toContain('"heat"');
  });

  it('with no method named it is the proximity bind it always was', () => {
    const spec = bindSkinMutator.spec.parse({ mesh: BIND.mesh, armature: BIND.armature });
    const next = run(scene, bindSkinMutator.build(spec, {} as never, scene));
    const capture = Object.values(next.nodes).find((n) => n.type === 'CaptureModifier')!;
    expect(capture.params).toMatchObject({ method: 'proximity', maxInfluences: 4, dropoff: 4 });
  });

  it('refuses a method it does not know, and a resolution outside the node’s range', () => {
    const base = { mesh: BIND.mesh, armature: BIND.armature };
    expect(bindSkinMutator.spec.safeParse({ ...base, method: 'biharmonic' }).success).toBe(false);
    expect(bindSkinMutator.spec.safeParse({ ...base, resolution: 1024 }).success).toBe(false);
    expect(bindSkinMutator.spec.safeParse({ ...base, falloff: 2 }).success).toBe(false);
  });
});
