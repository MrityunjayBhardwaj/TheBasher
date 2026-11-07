// #1516 — a reparent keeps the object where it is drawn. Each case reads the world matrix through
// `resolveWorldTransform`, the resolver the renderer is pinned against (p1152), before and after
// the real ops are applied, so removing the compensation fails here.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp } from '../core/dag';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import {
  buildClearParentOps,
  buildMoveOps,
  buildParentToOps,
  movableHolderEdges,
  residualNotice,
} from './keepPlaceReparent';
import { resolveWorldTransform } from './resolveWorldTransform';
import { isInScene } from './sceneMembership';
import { childIdsOf } from './sceneHierarchy';
import { worldParentOf } from '../core/dag/worldChildren';

registerAllNodes();

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
type Vec3 = [number, number, number];

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);
const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});
/** `from` hangs under `to`: in the scene's list, or (#1824) naming a group or object through its
 *  own parent input. */
const wire = (from: string, to: string, socket = 'children'): Op =>
  to === 'n_scene' || socket !== 'children'
    ? { type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } }
    : {
        type: 'connect',
        from: { node: to, socket: 'world' },
        to: { node: from, socket: 'parent' },
      };
const unwire = (from: string, to: string, socket = 'children'): Op => ({
  type: 'disconnect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});

interface Pose {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  pivot?: Vec3;
}
const pose = (id: string, p: Pose): Op[] =>
  Object.entries(p).map(([path, value]) => set(id, path, value));
/** #1823 — a group made under `parent`: hung there, and a member of the scene's own list as every
 *  door that makes an object links it (parenting is not membership). */
const group = (id: string, parent: string, p: Pose = {}): Op[] => [
  { type: 'addNode', nodeId: id, nodeType: 'Group', params: {} },
  wire(id, parent),
  ...(parent === 'n_scene' ? [] : [wire(id, 'n_scene')]),
  ...pose(id, p),
];
/** The default scene, with the cube posed and hung under `parent` when one is given. #1823 — it
 *  stays in the scene's list: hanging it is not taking it out of the scene. */
function cubeUnder(parent: string | null, cube: Pose, build: Op[] = []): DagState {
  const s = apply(buildDefaultDagState(), [...build, ...pose('n_box', cube)]);
  return parent ? apply(s, [wire('n_box', parent)]) : s;
}

const world = (s: DagState, id: string): number[] => resolveWorldTransform(s, id, CTX)!.matrix;
function expectSameWorld(a: number[], b: number[], digits = 5) {
  a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, digits));
}

const TURNED: Pose = { position: [5, 1, -2], rotation: [30, 40, 50], scale: [2, 2, 2] };
const NON_UNIFORM: Pose = { position: [5, 1, -2], rotation: [0, 0, 45], scale: [3, 1, 1] };
const CUBE: Pose = { position: [1, 2, 3], rotation: [10, 20, 30], scale: [1, 1, 1] };

beforeEach(() => {
  useDagStore.getState().hydrate(buildDefaultDagState());
});

describe('keep the place: dragging into and out of a group (#1516)', () => {
  it('into an offset, turned, scaled group', () => {
    const s = cubeUnder(null, CUBE, group('G', 'n_scene', TURNED));
    const before = world(s, 'n_box');
    const r = buildMoveOps(
      s,
      [{ childId: 'n_box', from: movableHolderEdges(s, 'n_box'), to: 'G' }],
      { ctx: CTX, verb: 'Parent' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = apply(s, r.ops);
    // #1824 — it hangs from G by its own parent input, not by a wire in G's list.
    expect(childIdsOf(after, 'G')).toEqual(['n_box']);
    expect(worldParentOf(after, 'n_box')).toBe('G');
    expect(after.nodes.G.inputs.children).toBeUndefined();
    expectSameWorld(before, world(after, 'n_box'));
    expect(r.residuals).toEqual([]);
    // The values really changed: nothing else could be holding it there.
    expect((after.nodes.n_box.params as { position: Vec3 }).position).not.toEqual(CUBE.position);
  });

  it('out of a group, back to the scene', () => {
    const s = cubeUnder('G', CUBE, group('G', 'n_scene', TURNED));
    const before = world(s, 'n_box');
    const r = buildClearParentOps(s, ['n_box'], { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = apply(s, r.ops);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'n_box', socket: 'out' });
    expect(after.nodes.G.inputs.children ?? []).toEqual([]);
    expectSameWorld(before, world(after, 'n_box'));
  });

  it('between two groups, nested and far apart', () => {
    const s = cubeUnder('B', CUBE, [
      ...group('A', 'n_scene', TURNED),
      ...group('B', 'A', { position: [0, 3, 0], rotation: [0, 90, 0] }),
      ...group('C', 'n_scene', { position: [-4, 0, 0], rotation: [0, 0, 20], scale: [2, 2, 2] }),
    ]);
    const before = world(s, 'n_box');
    const r = buildParentToOps(s, ['n_box'], 'C', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    expectSameWorld(before, world(apply(s, r.ops), 'n_box'));
  });

  it('a group’s own pivot on either side of the move is accounted for', () => {
    const s = cubeUnder('G', CUBE, [
      ...group('G', 'n_scene', { rotation: [0, 0, 90], pivot: [1, 0, 0] }),
      ...group('H', 'n_scene', { position: [2, 0, 0], pivot: [0, 4, 0] }),
    ]);
    const before = world(s, 'n_box');
    const r = buildParentToOps(s, ['n_box'], 'H', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    expectSameWorld(before, world(apply(s, r.ops), 'n_box'));
  });

  it('a group moved keeps its pivot value and its place', () => {
    const s = apply(buildDefaultDagState(), [
      ...group('G', 'n_scene', { position: [1, 0, 0], rotation: [0, 0, 30], pivot: [2, 0, 0] }),
      ...group('H', 'n_scene', { position: [-3, 1, 0], rotation: [0, 90, 0] }),
    ]);
    const before = world(s, 'G');
    const r = buildParentToOps(s, ['G'], 'H', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = apply(s, r.ops);
    expect((after.nodes.G.params as Pose).pivot).toEqual([2, 0, 0]);
    expectSameWorld(before, world(after, 'G'));
  });

  it('a quaternion-mode cube stays in quaternion mode and in place', () => {
    const s = apply(cubeUnder(null, { position: [1, 2, 3] }, group('G', 'n_scene', TURNED)), [
      set('n_box', 'rotationMode', 'quaternion'),
      set(
        'n_box',
        'quaternion',
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1).toArray(),
      ),
    ]);
    const before = world(s, 'n_box');
    const r = buildParentToOps(s, ['n_box'], 'G', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ops.some((o) => o.type === 'setParam' && o.paramPath === 'quaternion')).toBe(true);
    expect(r.ops.some((o) => o.type === 'setParam' && o.paramPath === 'rotation')).toBe(false);
    expectSameWorld(before, world(apply(s, r.ops), 'n_box'));
  });

  it('Alt: the values stay as they are, and the object goes where they put it', () => {
    const s = cubeUnder(null, CUBE, group('G', 'n_scene', TURNED));
    const before = world(s, 'n_box');
    const r = buildMoveOps(
      s,
      [{ childId: 'n_box', from: movableHolderEdges(s, 'n_box'), to: 'G' }],
      { keepTransform: false, ctx: CTX, verb: 'Parent' },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.ops.every((o) => o.type !== 'setParam')).toBe(true);
    const after = apply(s, r.ops);
    expect((after.nodes.n_box.params as Pose).position).toEqual(CUBE.position);
    expect(world(after, 'n_box')[12]).not.toBeCloseTo(before[12], 2);
  });
});

describe('a non-uniform, turned parent shears (#1516)', () => {
  it('the position still lands, and the miss is reported rather than hidden', () => {
    const s = cubeUnder('G', CUBE, group('G', 'n_scene', NON_UNIFORM));
    const before = world(s, 'n_box');
    const r = buildClearParentOps(s, ['n_box'], { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = world(apply(s, r.ops), 'n_box');
    expect([after[12], after[13], after[14]]).toEqual([
      expect.closeTo(before[12], 5),
      expect.closeTo(before[13], 5),
      expect.closeTo(before[14], 5),
    ]);
    expect(r.residuals.map((x) => x.childId)).toEqual(['n_box']);
    expect(r.residuals[0].residual).toBeGreaterThan(0.01);
    expect(residualNotice(s, r.residuals)).toContain('sheared');
  });

  it('CONTROL: the same parent with no turn holds it exactly and reports nothing', () => {
    const s = cubeUnder(
      'G',
      { position: [1, 2, 3] },
      group('G', 'n_scene', { position: [5, 1, -2], scale: [3, 1, 1] }),
    );
    const before = world(s, 'n_box');
    const r = buildClearParentOps(s, ['n_box'], { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    expect(r.residuals).toEqual([]);
    expectSameWorld(before, world(apply(s, r.ops), 'n_box'));
  });
});

describe('Ctrl+P and Alt+P (#1516)', () => {
  it('Ctrl+P parents every selected object and keeps each', () => {
    const s = apply(buildDefaultDagState(), group('G', 'n_scene', TURNED));
    const ids = ['n_box', 'n_light'];
    const before = ids.map((id) => world(s, id));
    const r = buildParentToOps(s, ids, 'G', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = apply(s, r.ops);
    expect([...childIdsOf(after, 'G')].sort()).toEqual(['n_box', 'n_light']);
    expect(after.nodes.n_scene.inputs.lights ?? []).not.toContainEqual({
      node: 'n_light',
      socket: 'out',
    });
    ids.forEach((id, i) => expectSameWorld(before[i], world(after, id)));
  });

  it('a parent and its child selected together both keep their place', () => {
    const s = cubeUnder('A', CUBE, [
      ...group('A', 'n_scene', TURNED),
      ...group('T', 'n_scene', { position: [0, 9, 0] }),
    ]);
    const before = { a: world(s, 'A'), box: world(s, 'n_box') };
    const r = buildParentToOps(s, ['A', 'n_box'], 'T', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = apply(s, r.ops);
    expectSameWorld(before.a, world(after, 'A'));
    expectSameWorld(before.box, world(after, 'n_box'));
  });

  it('refuses a loop by name, and writes nothing', () => {
    const s = cubeUnder('A', CUBE, [
      ...group('A', 'n_scene', TURNED),
      ...group('B', 'A', { position: [1, 0, 0] }),
    ]);
    const r = buildParentToOps(s, ['A'], 'B', { ctx: CTX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('inside');
  });

  it('a light or a camera cannot be the parent', () => {
    for (const parent of ['n_light', 'n_camera']) {
      const r = buildParentToOps(buildDefaultDagState(), ['n_box'], parent, { ctx: CTX });
      expect(r.ok).toBe(false);
    }
  });

  it('Alt+P: a light goes back to the lights list, a cube to children', () => {
    const s = apply(buildDefaultDagState(), [
      ...group('G', 'n_scene', { position: [2, 0, 0] }),
      wire('n_box', 'G'),
      // #1823 — as Ctrl+P leaves it: out of the lights band, a member of the scene's own list.
      unwire('n_light', 'n_scene', 'lights'),
      wire('n_light', 'n_scene'),
      wire('n_light', 'G'),
    ]);
    const before = { box: world(s, 'n_box'), light: world(s, 'n_light') };
    const r = buildClearParentOps(s, ['n_box', 'n_light'], { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = apply(s, r.ops);
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'n_box', socket: 'out' });
    expect(after.nodes.n_scene.inputs.lights).toContainEqual({ node: 'n_light', socket: 'out' });
    expect(isInScene(after, 'n_box') && isInScene(after, 'n_light')).toBe(true);
    expectSameWorld(before.box, world(after, 'n_box'));
    expectSameWorld(before.light, world(after, 'n_light'));
  });

  it('a camera moves its group membership only, and its active wire is untouched', () => {
    const s = apply(buildDefaultDagState(), group('G', 'n_scene', TURNED));
    const before = world(s, 'n_camera');
    const inGroup = buildParentToOps(s, ['n_camera'], 'G', { ctx: CTX });
    if (!inGroup.ok) throw new Error(inGroup.reason);
    const a = apply(s, inGroup.ops);
    expect(a.nodes.n_scene.inputs.camera).toEqual(s.nodes.n_scene.inputs.camera);
    expect(childIdsOf(a, 'G')).toEqual(['n_camera']);
    const posn = (m: number[]) => [m[12], m[13], m[14]];
    posn(before).forEach((v, i) => expect(posn(world(a, 'n_camera'))[i]).toBeCloseTo(v, 5));

    const out = buildClearParentOps(a, ['n_camera'], { ctx: CTX });
    if (!out.ok) throw new Error(out.reason);
    const b = apply(a, out.ops);
    expect(childIdsOf(b, 'G')).toEqual([]);
    expect(b.nodes.n_camera.inputs.parent).toBeUndefined();
    expect(b.nodes.n_scene.inputs.camera).toEqual(s.nodes.n_scene.inputs.camera);
    expectSameWorld(before, world(b, 'n_camera'));
  });

  it('is one undo step through the store', () => {
    const s = cubeUnder(null, CUBE, group('G', 'n_scene', TURNED));
    useDagStore.getState().hydrate(s);
    const r = buildParentToOps(s, ['n_box'], 'G', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    useDagStore.getState().dispatchAtomic(r.ops, 'user', 'set parent');
    expect(childIdsOf(useDagStore.getState().state, 'G')).toHaveLength(1);
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes).toEqual(s.nodes);
  });
});

describe('an animated transform is refused, not silently moved (#1516)', () => {
  const channel = (nodeId: string, target: string, paramPath: string, type: string): Op => ({
    type: 'addNode',
    nodeId,
    nodeType: type,
    params: {
      target,
      paramPath,
      keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
    },
  });

  it('a keyed position refuses, by name, and writes no key', () => {
    const s = apply(cubeUnder(null, CUBE, group('G', 'n_scene', TURNED)), [
      channel('ch', 'n_box', 'position', 'KeyframeChannelVec3'),
    ]);
    const r = buildParentToOps(s, ['n_box'], 'G', { ctx: CTX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/animated/);
  });

  it('CONTROL: a keyed colour on the data does not refuse', () => {
    const s = apply(cubeUnder(null, CUBE, group('G', 'n_scene', TURNED)), [
      channel('ch', 'n_box_data', 'size', 'KeyframeChannelVec3'),
    ]);
    expect(buildParentToOps(s, ['n_box'], 'G', { ctx: CTX }).ok).toBe(true);
  });

  it('CONTROL: nothing to keep when the parent’s world does not change', () => {
    const s = apply(cubeUnder('A', CUBE, [...group('A', 'n_scene'), ...group('B', 'n_scene')]), [
      channel('ch', 'n_box', 'position', 'KeyframeChannelVec3'),
    ]);
    const r = buildParentToOps(s, ['n_box'], 'B', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ops.every((o) => o.type !== 'setParam')).toBe(true);
  });

  it('Alt moves it with its values and its keys as they are', () => {
    const s = apply(cubeUnder(null, CUBE, group('G', 'n_scene', TURNED)), [
      channel('ch', 'n_box', 'position', 'KeyframeChannelVec3'),
    ]);
    const r = buildParentToOps(s, ['n_box'], 'G', { keepTransform: false, ctx: CTX });
    expect(r.ok).toBe(true);
  });

  it('an empty channel holds no animation and refuses nothing', () => {
    const s = apply(cubeUnder(null, CUBE, group('G', 'n_scene', TURNED)), [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: { target: 'n_box', paramPath: 'position', keyframes: [] },
      },
    ]);
    expect(buildParentToOps(s, ['n_box'], 'G', { ctx: CTX }).ok).toBe(true);
  });
});

describe('a bone it hung from goes with the old parent (#1516)', () => {
  it('moving a bone-parented object clears the bone name', () => {
    const s = apply(cubeUnder('A', CUBE, group('A', 'n_scene', TURNED)), [
      ...group('B', 'n_scene'),
      set('n_box', 'parentBone', 'Hips'),
    ]);
    const r = buildParentToOps(s, ['n_box'], 'B', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    expect((apply(s, r.ops).nodes.n_box.params as { parentBone?: string }).parentBone).toBe(
      undefined,
    );
  });
});

describe('a constraint above the child cannot be read yet, so it is refused (#1829)', () => {
  const aim = (target: string, mute = false): Op => ({
    type: 'addNode',
    nodeId: `tt_${target}`,
    nodeType: 'TrackTo',
    params: { target, aimNode: 'n_light', order: 0, mute },
  });

  it('leaving an aimed parent refuses by its name, as does joining one', () => {
    const s = apply(cubeUnder('A', CUBE, [...group('A', 'n_scene'), ...group('B', 'n_scene')]), [
      aim('A'),
    ]);
    const leave = buildClearParentOps(s, ['n_box'], { ctx: CTX });
    expect(leave.ok).toBe(false);
    if (!leave.ok) expect(leave.reason).toMatch(/constraint/);

    const t = apply(cubeUnder(null, CUBE, group('B', 'n_scene')), [aim('B')]);
    expect(buildParentToOps(t, ['n_box'], 'B', { ctx: CTX }).ok).toBe(false);
  });

  it('so does a constraint further up the chain', () => {
    const s = apply(cubeUnder('B', CUBE, [...group('A', 'n_scene'), ...group('B', 'A')]), [
      aim('A'),
    ]);
    expect(buildClearParentOps(s, ['n_box'], { ctx: CTX }).ok).toBe(false);
  });

  it('CONTROL: a muted constraint poses nothing and refuses nothing', () => {
    const s = apply(cubeUnder('A', CUBE, group('A', 'n_scene', TURNED)), [aim('A', true)]);
    expect(buildClearParentOps(s, ['n_box'], { ctx: CTX }).ok).toBe(true);
  });

  it('CONTROL: the child’s own Track-To refuses nothing, and its position is kept', () => {
    const s = apply(cubeUnder(null, CUBE, group('G', 'n_scene', TURNED)), [aim('n_box')]);
    const before = world(s, 'n_box');
    const r = buildParentToOps(s, ['n_box'], 'G', { ctx: CTX });
    if (!r.ok) throw new Error(r.reason);
    const after = world(apply(s, r.ops), 'n_box');
    [12, 13, 14].forEach((i) => expect(after[i]).toBeCloseTo(before[i], 5));
  });

  it('Alt moves it anyway, with its values as they are', () => {
    const s = apply(cubeUnder('A', CUBE, group('A', 'n_scene')), [aim('A')]);
    expect(buildClearParentOps(s, ['n_box'], { keepTransform: false, ctx: CTX }).ok).toBe(true);
  });
});
