// #1842 — a light a band draws stays on its band and stands at its world, parent included. Blender
// 5.1.1 keeps the same two things apart: parenting a light moved it from (0, 0, 3) to (4, 0, 3) and
// left its collection alone. What the viewport draws is in p1842-band-light-parent.spec.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, evaluate, type DagState } from '../core/dag';
import type { NodeRef } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp as committedApplyOp } from '../test-utils/committedApplyOp';
import { makeSplitLight } from '../test-utils/splitLight';
import { resolveDrawnWorldTransform } from './drawnWorldTransform';
import { buildClearParentOps, buildParentToOps } from './keepPlaceReparent';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';
import { sceneDrawOf } from './sceneMembership';

beforeAll(() => registerAllNodes());

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
const run = (s: DagState, ops: readonly object[]) => {
  for (const op of ops) s = applyOp(s, op as never).next;
  return s;
};
const wire = (from: string, socket: string, to: string, toSocket: string) => ({
  type: 'connect',
  from: { node: from, socket },
  to: { node: to, socket: toSocket },
});
const group = (s: DagState, params: object = { position: [5, 1, 0] }) =>
  run(s, [
    { type: 'addNode', nodeId: 'G', nodeType: 'Object', params },
    wire('G', 'out', 'n_scene', 'children'),
  ]);
const refs = (v: unknown) =>
  ((Array.isArray(v) ? v : v ? [v] : []) as NodeRef[]).map((r) => r.node);

/** A point light at (5, 5, 3) on the scene's `lights`. */
function onSceneLights(): DagState {
  const s = makeSplitLight(buildDefaultDagState(), {
    objectId: 'l',
    lightKind: 'Point',
    position: [5, 5, 3],
  }).state;
  return group(run(s, [wire('l', 'out', 'n_scene', 'lights')]));
}

/** The same light on the active rig's `lights`. */
function onRig(): DagState {
  const s = makeSplitLight(buildDefaultDagState(), {
    objectId: 'l',
    lightKind: 'Point',
    position: [5, 5, 3],
  }).state;
  return group(
    run(s, [
      { type: 'addNode', nodeId: 'rig', nodeType: 'LightRig', params: { name: 'Key' } },
      wire('l', 'out', 'rig', 'lights'),
      wire('rig', 'out', 'n_scene', 'lightRig'),
    ]),
  );
}

const worldAt = (s: DagState, id: string) => resolveWorldTransform(s, id, CTX)!.position;
const worldOutput = (s: DagState, id: string) => {
  const m = evaluate(s, id, { ctx: CTX, socket: 'world' }).value as number[];
  const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(m));
  return [p.x, p.y, p.z];
};
const close = (got: readonly number[], want: readonly number[]) =>
  got.forEach((x, i) => expect(x, `axis ${i}`).toBeCloseTo(want[i], 6));

describe('a light on a band, hung from something', () => {
  for (const [name, build] of [
    ['the scene list', onSceneLights],
    ['the active rig', onRig],
  ] as const) {
    it(`on ${name}, by a raw parent wire: its world is the parent's, and the two reads agree`, () => {
      const s = run(build(), [wire('G', 'world', 'l', 'parent')]);
      close(worldAt(s, 'l'), [10, 6, 3]);
      close(worldOutput(s, 'l'), [10, 6, 3]);
      expect(resolveParentWorldMatrix(s, 'l', CTX)).not.toBeNull();
    });

    it(`on ${name}, with no parent: its own place, and no parent world (control)`, () => {
      const s = build();
      close(worldAt(s, 'l'), [5, 5, 3]);
      expect(resolveParentWorldMatrix(s, 'l', CTX)).toBeNull();
    });

    it(`on ${name}, under a turned parent: the parent's turn reaches it`, () => {
      const s = run(build(), [
        { type: 'setParam', nodeId: 'G', paramPath: 'rotation', value: [0, 0, 90] },
        wire('G', 'world', 'l', 'parent'),
      ]);
      close(worldAt(s, 'l'), [0, 6, 3]);
      close(worldOutput(s, 'l'), [0, 6, 3]);
    });

    it(`on ${name}: it is not in the drawn tree, so it is drawn once`, () => {
      const s = run(build(), [wire('G', 'world', 'l', 'parent')]);
      expect(sceneDrawOf(s as never)!.drawn.has('l')).toBe(false);
    });
  }
});

describe('under an aimed parent', () => {
  // Through the commit step: a constraint is on its object's chain only after it.
  const aimed = (build: () => DagState) => {
    let s = run(build(), [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [2, 3, 1] },
      { type: 'setParam', nodeId: 'l', paramPath: 'position', value: [2, 3, 1] },
      wire('G', 'world', 'n_box', 'parent'),
      wire('G', 'world', 'l', 'parent'),
    ]);
    s = committedApplyOp(s, {
      type: 'addNode',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      params: { target: 'G', aimNode: '', aimPoint: [5, 9, 0], up: [0, 0, 1] },
    } as never).next;
    return s;
  };

  for (const [name, build] of [
    ['the scene list', onSceneLights],
    ['the active rig', onRig],
  ] as const) {
    it(`on ${name}: the drawn read lands it where a cube hung the same way lands`, () => {
      const s = aimed(build);
      // Unturned, both would be at (7, 4, 1): the aim has to be in this.
      const box = resolveDrawnWorldTransform(s, 'n_box', CTX)!.position;
      close(box, [7, 0, 3]);
      close(resolveDrawnWorldTransform(s, 'l', CTX)!.position, box);
      close(worldOutput(s, 'l'), box);
    });

    it(`on ${name}: the input road leaves the aim out, as it does for the cube`, () => {
      const s = aimed(build);
      close(worldAt(s, 'n_box'), [7, 4, 1]);
      close(worldAt(s, 'l'), [7, 4, 1]);
    });
  }
});

describe('the doors on a rig light', () => {
  it('Ctrl+P keeps it where it stands, on its rig, and the parent then carries it', () => {
    const before = onRig();
    const r = buildParentToOps(before, ['l'], 'G', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const s = run(before, r.ops);
    expect(refs(s.nodes.l.inputs.parent)).toEqual(['G']);
    expect(refs(s.nodes.rig.inputs.lights)).toContain('l');
    close(worldAt(s, 'l'), [5, 5, 3]);
    const moved = run(s, [
      { type: 'setParam', nodeId: 'G', paramPath: 'position', value: [8, 1, 0] },
    ]);
    close(worldAt(moved, 'l'), [8, 5, 3]);
  });

  it('Alt+P keeps it where it stands, on its rig and off the scene list', () => {
    const before = onRig();
    const hung = buildParentToOps(before, ['l'], 'G', { ctx: CTX });
    if (!hung.ok) throw new Error(hung.reason);
    const s = run(before, hung.ops);
    const r = buildClearParentOps(s, ['l'], { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const cleared = run(s, r.ops);
    expect(cleared.nodes.l.inputs.parent).toBeUndefined();
    expect(refs(cleared.nodes.rig.inputs.lights)).toContain('l');
    expect(refs(cleared.nodes.n_scene.inputs.lights)).not.toContain('l');
    close(worldAt(cleared, 'l'), [5, 5, 3]);
  });
});
