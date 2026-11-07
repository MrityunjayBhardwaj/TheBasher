// #1765 — v26 → v27: a light is turned by its own rotation or a Track-To, shining down its local
// −Z. The gate: every light shines exactly where it shone before the step, at every time sampled,
// for every example project and for fixtures covering each case the step handles.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { __resetRegistryForTests, type DagState } from '../dag';
import { applyOp } from '../../test-utils/committedApplyOp';
import { chainFollowUpOps } from '../dag/chainEdit';
import { applyOps } from '../dag/ops';
import { emptyDagState } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from './default';
import { CAPTURED_EXAMPLE_IDS, EXAMPLE_PROJECT_IDS, buildExampleProject } from './examples';
import { migrateLightAimToTurn } from './migrations';
import { useNotificationStore } from '../../app/stores/notificationStore';
import { buildDeleteNodesOps } from '../../app/sceneNodeActions';
import { hierarchyChildIds } from '../../app/sceneHierarchy';
import { makeSplitLight } from '../../test-utils/splitLight';
import { cameraLocalOrientation } from '../../app/cameraTrackTo';
import { resolveTrackToTarget } from '../../app/nodeConstraints';
import { resolveEvaluatedParam } from '../../app/resolveEvaluatedParam';
import { resolveParentWorldMatrix, resolveWorldTransform } from '../../app/resolveWorldTransform';
import { clockedCtx } from '../../app/subjectClock';
import { withResolvedRotation } from '../../app/resolvedRotation';
import type { RotationModeFields } from '../../nodes/types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type V3 = [number, number, number];
const run = (s: DagState, ops: object[]) => {
  for (const op of ops) s = applyOp(s, op as never).next;
  return s;
};
const migrate = (s: DagState): DagState => {
  const out = migrateLightAimToTurn({ formatVersion: 26, state: s }) as {
    formatVersion: number;
    state: DagState;
  };
  expect(out.formatVersion).toBe(27);
  // The readers take the chain. A fixture's own Track-To is on one already, so what the step added
  // joins it as a commit would.
  return applyOps(out.state, chainFollowUpOps(emptyDagState(), out.state)).next;
};
const keys = (pairs: [number, unknown][]) =>
  pairs.map(([time, value]) => ({ time, value, easing: 'linear' }));
const TIMES = [0, 0.25, 0.5, 1, 1.5, 2, 3];
const params = (s: DagState, id: string) => s.nodes[id].params as Record<string, unknown>;

/** Every Object wearing a LightData that turns (sun, spot, area), with its data id. */
function aimableLights(s: DagState): { obj: string; data: string; kind: string }[] {
  return Object.values(s.nodes).flatMap((n) => {
    const ref = (n.inputs as Record<string, { node?: string } | undefined>)?.data;
    const data = ref?.node ? s.nodes[ref.node] : undefined;
    if (data?.type !== 'LightData') return [];
    const kind = (data.params as { lightKind?: string }).lightKind ?? 'Point';
    return kind === 'Point' ? [] : [{ obj: n.id, data: data.id, kind }];
  });
}

/** Where the light is drawn at `t`, in the world, with its constraints (a Follow-Path). */
const worldPos = (s: DagState, id: string, t: number): THREE.Vector3 =>
  new THREE.Vector3(...(resolveWorldTransform(s, id, clockedCtx(t, t))!.position as V3));

/** A node's param at `t`: what overrides it (a key, a driver), else what it stores. */
const paramAt = (s: DagState, id: string, path: string, t: number): unknown =>
  resolveEvaluatedParam(s, id, path, clockedCtx(t, t))?.value ??
  (s.nodes[id].params as Record<string, unknown>)[path];

/** A light Object's own rotation at `t`, keys applied, read in its mode (euler degrees). */
function ownRotation(s: DagState, id: string, t: number): V3 {
  const read = (path: string) => paramAt(s, id, path, t);
  return withResolvedRotation({
    rotation: (read('rotation') ?? [0, 0, 0]) as V3,
    rotationMode: read('rotationMode'),
    quaternion: read('quaternion'),
  } as RotationModeFields & { rotation: V3 }).rotation;
}

/**
 * What a light shone along at `t` BEFORE the step, in the world: the rules the step replaces,
 * as `SceneFromDAG` drew them at 2f6a34e6 (`useLightTargetAim`, `useAreaLightAim`,
 * `DirectionalLightR`, `SpotLightR`). A winning Track-To's world aim point; else a spot toward its
 * `target`, an area light toward its `lookAt`, and a sun down its rotation × (0, −1, 0) — or, at
 * rotation exactly 0, from its position toward the origin. Every aim was a WORLD point (three's
 * `target` sits in no group, and `Object3D.lookAt` takes a world point). An area light was turned
 * by three's `lookAt`, world +Y up, so its whole orientation is returned with its direction.
 */
function oldTurn(
  s: DagState,
  light: { obj: string; data: string; kind: string },
  t: number,
): { dir: THREE.Vector3; quat: THREE.Quaternion | null } {
  const ctx = clockedCtx(t, t);
  const p = worldPos(s, light.obj, t);
  // Only an area light's whole orientation shows (its rectangle's roll); a sun or spot shines the
  // same at any roll about its direction, and its shadow camera keeps its own up.
  const aimAt = (aim: V3) => {
    const dir = new THREE.Vector3(...aim).sub(p).normalize();
    if (light.kind !== 'Area') return { dir, quat: null };
    const m = new THREE.Matrix4().lookAt(p, new THREE.Vector3(...aim), new THREE.Vector3(0, 1, 0));
    return { dir, quat: new THREE.Quaternion().setFromRotationMatrix(m) };
  };
  const tracked = resolveTrackToTarget(s, light.obj, ctx);
  if (tracked) return aimAt(tracked as V3);
  if (light.kind === 'Spot') return aimAt(paramAt(s, light.data, 'target', t) as V3);
  if (light.kind === 'Area') return aimAt(paramAt(s, light.data, 'lookAt', t) as V3);
  const r = ownRotation(s, light.obj, t);
  if (r.every((v) => v === 0)) return { dir: p.clone().negate().normalize(), quat: null };
  const e = new THREE.Euler(...(r.map(THREE.MathUtils.degToRad) as V3));
  return { dir: new THREE.Vector3(0, -1, 0).applyEuler(e), quat: null };
}

/** What a light shines along at `t` AFTER the step: its turn (`cameraLocalOrientation`, the one
 *  `useLightTurn` draws with) lifted by its parent, down its local −Z. */
function newTurn(
  s: DagState,
  light: { obj: string },
  t: number,
): { dir: THREE.Vector3; quat: THREE.Quaternion } {
  const ctx = clockedCtx(t, t);
  const parent = resolveParentWorldMatrix(s, light.obj, ctx);
  const local = worldPos(s, light.obj, t);
  if (parent) local.applyMatrix4(parent.clone().invert());
  const rotation = ownRotation(s, light.obj, t);
  const { quaternion } = cameraLocalOrientation(s, light.obj, { rotation }, ctx);
  const quat = new THREE.Quaternion(...quaternion);
  if (parent) quat.premultiply(new THREE.Quaternion().setFromRotationMatrix(parent));
  return { dir: new THREE.Vector3(0, 0, -1).applyQuaternion(quat), quat };
}

/** Every turning light in `b` (the converted state) shines as in `a` (the saved one), at every
 *  sampled time: the same direction, and for an area light the same whole orientation (its
 *  rectangle's roll). Returns how many samples were compared. */
function expectSameTurns(a: DagState, b: DagState): number {
  let n = 0;
  for (const light of aimableLights(a))
    for (const t of TIMES) {
      const before = oldTurn(a, light, t);
      const after = newTurn(b, light, t);
      const label = `${light.obj} (${light.kind}) @ ${t}s`;
      expect(after.dir.dot(before.dir), `${label} direction`).toBeCloseTo(1, 9);
      if (before.quat)
        expect(Math.abs(after.quat.dot(before.quat)), `${label} orientation`).toBeCloseTo(1, 9);
      n++;
    }
  return n;
}

/** `state` with light data `dataId` holding a v26 aim RAW (`target` / `lookAt`), as a v26 file holds
 *  it: the v27 schema (and so the shared builder) has no such fields. */
function withV26Aim(state: DagState, dataId: string, aim: Record<string, V3>): DagState {
  const n = state.nodes[dataId];
  return {
    ...state,
    nodes: {
      ...state.nodes,
      [dataId]: { ...n, params: { ...(n.params as Record<string, unknown>), ...aim } },
    },
  };
}

/** A default scene plus one light, wired to scene.lights. */
function withLight(opts: Parameters<typeof makeSplitLight>[1]): DagState {
  return makeSplitLight(buildDefaultDagState(), {
    ...opts,
    connectTo: { node: 'n_scene', socket: 'lights' },
  }).state;
}

describe('#1765 v26 → v27: every light shines where it shone', () => {
  // The default project and the examples built from ops are created at the current format, never
  // migrated: each seeds its sun aimed at the world origin by a Track-To, where a sun at rotation
  // 0 shone at v26. So each is checked against that, live, at every time.
  const shinesAtOrigin = (s: DagState): number => {
    let n = 0;
    for (const light of aimableLights(s))
      for (const t of TIMES) {
        const toOrigin = worldPos(s, light.obj, t).negate().normalize();
        expect(newTurn(s, light, t).dir.dot(toOrigin), `${light.obj} @ ${t}s`).toBeCloseTo(1, 9);
        n++;
      }
    return n;
  };

  /** Every sun, spot and area light in `s` carries a live Track-To aimed at an empty named after
   *  it ("….aim") at the world origin — not hung under the light — and still shines at the
   *  origin with the empties deleted (the Track-To's fallback point) and with every Track-To
   *  muted (its own rotation). */
  const aimedAtOrigin = (s: DagState): number => {
    const lights = aimableLights(s);
    const empties: string[] = [];
    for (const light of lights) {
      const aim = Object.values(s.nodes).find(
        (n) => n.type === 'TrackTo' && (n.params as { target: string }).target === light.obj,
      );
      expect(aim?.params, light.obj).toMatchObject({ aimPoint: [0, 0, 0], mute: false });
      const emptyId = (aim!.params as { aimNode: string }).aimNode;
      expect(s.nodes[emptyId]?.type, `${light.obj}'s aim object`).toBe('Null');
      expect(s.nodes[emptyId].meta?.name, light.obj).toMatch(/\.aim$/);
      expect(worldPos(s, emptyId, 0).toArray(), light.obj).toEqual([0, 0, 0]);
      expect(hierarchyChildIds(s.nodes[light.obj]), light.obj).not.toContain(emptyId);
      empties.push(emptyId);
    }
    shinesAtOrigin(run(s, buildDeleteNodesOps(s, empties) as Parameters<typeof run>[1]));
    const muted = run(
      s,
      Object.values(s.nodes)
        .filter((n) => n.type === 'TrackTo')
        .map((n) => ({ type: 'setParam', nodeId: n.id, paramPath: 'mute', value: true }) as const),
    );
    shinesAtOrigin(muted);
    return lights.length;
  };

  it('the default project: its sun shines at the origin, as at v26, aimed by a Track-To', () => {
    expect(shinesAtOrigin(buildDefaultDagState())).toBe(TIMES.length);
    expect(aimedAtOrigin(buildDefaultDagState())).toBe(1);
  });

  it.each(EXAMPLE_PROJECT_IDS.filter((x) => !CAPTURED_EXAMPLE_IDS.includes(x)))(
    'example %s: its lights shine at the origin, as at v26',
    async (id) => {
      const s = (await buildExampleProject(id)).state;
      expect(shinesAtOrigin(s)).toBeGreaterThan(0);
      expect(aimedAtOrigin(s)).toBeGreaterThan(0);
    },
  );

  // A captured example is stored already converted (re-captured through this step).
  // #1800 — this builds every captured example project, which alone takes about vitest's
  // default 5 s; the timeout covers that setup, not the check.
  it('the captured example is stored converted: no light data holds an aim point', async () => {
    for (const id of CAPTURED_EXAMPLE_IDS) {
      const s = (await buildExampleProject(id)).state;
      const data = Object.values(s.nodes).filter((n) => n.type === 'LightData');
      expect(data.length, id).toBeGreaterThan(0);
      for (const n of data) {
        expect(n.params, `${id} ${n.id}`).not.toHaveProperty('target');
        expect(n.params, `${id} ${n.id}`).not.toHaveProperty('lookAt');
      }
    }
  }, 30_000);

  it('a spot aimed at a point, and an area light at another', () => {
    let a = withLight({ objectId: 'spot', lightKind: 'Spot', position: [4, 6, 2] });
    a = makeSplitLight(a, {
      objectId: 'area',
      lightKind: 'Area',
      position: [-3, 4, 5],
      connectTo: { node: 'n_scene', socket: 'lights' },
    }).state;
    a = withV26Aim(withV26Aim(a, 'spot_data', { target: [-1, 0, 3] }), 'area_data', {
      lookAt: [1, 1, -2],
    });
    const b = migrate(a);
    expect(expectSameTurns(a, b)).toBe(3 * TIMES.length);
    // Both aims are now Track-Tos in world space, and the fields are gone from the data.
    const aims = Object.values(b.nodes).filter(
      (n) =>
        n.type === 'TrackTo' && ['spot', 'area'].includes((n.params as { target: string }).target),
    );
    expect(aims.map((n) => (n.params as { aimSpace: string }).aimSpace)).toEqual([
      'world',
      'world',
    ]);
    expect(params(b, 'spot_data')).not.toHaveProperty('target');
    expect(params(b, 'area_data')).not.toHaveProperty('lookAt');
  });

  it('a keyed spot target: its keys move onto the aim empty and play there', () => {
    let a = withLight({ objectId: 'spot', lightKind: 'Spot', position: [0, 5, 5] });
    a = run(a, [
      {
        type: 'addNode',
        nodeId: 'spot_target_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'target',
          target: 'spot_data',
          paramPath: 'target',
          keyframes: keys([
            [0, [0, 0, 0]],
            [2, [6, 1, -3]],
          ]),
        },
      },
    ]);
    const b = migrate(a);
    expectSameTurns(a, b);
    const moved = params(b, 'spot_target_keys');
    // The keys move the empty the Track-To aims at.
    expect(moved.target).toBe('spot_aim_target');
    expect(moved.paramPath).toBe('position');
    expect(params(b, 'spot_aim').aimNode).toBe('spot_aim_target');
  });

  it('an area light already aimed by a Track-To keeps it winning, and muting it shows the old aim', () => {
    let a = withV26Aim(
      withLight({ objectId: 'area', lightKind: 'Area', position: [0, 3, 5] }),
      'area_data',
      { lookAt: [2, 0, 0] },
    );
    a = run(a, [
      {
        type: 'addNode',
        nodeId: 'area_tt',
        nodeType: 'TrackTo',
        params: { target: 'area', aimPoint: [-1, 0, -1] },
      },
    ]);
    const b = migrate(a);
    expectSameTurns(a, b);
    const mute = (s: DagState) =>
      run(s, [{ type: 'setParam', nodeId: 'area_tt', paramPath: 'mute', value: true }]);
    expectSameTurns(mute(a), mute(b));
  });

  // The aim every new sun comes with: a world-space Track-To at the origin, and its own rotation
  // turned the same way, so muting the Track-To leaves it shining where it shone.
  it('a still sun at rotation 0 gets a Track-To at the origin, and muting it changes nothing', () => {
    const a = withLight({ objectId: 'sun', lightKind: 'Directional', position: [7, 9, -4] });
    const b = migrate(a);
    expectSameTurns(a, b);
    expect(params(b, 'sun_aim')).toMatchObject({
      target: 'sun',
      aimNode: 'sun_aim_target',
      aimPoint: [0, 0, 0],
      aimSpace: 'world',
    });
    // Its aim is an empty at the origin named after it, at the top of the scene.
    expect(b.nodes.sun_aim_target.type).toBe('Null');
    expect(b.nodes.sun_aim_target.meta?.name).toBe('Sun.aim');
    expect(params(b, 'sun_aim_target').position).toEqual([0, 0, 0]);
    expect((params(b, 'sun').rotation as number[]).some((v) => v !== 0)).toBe(true);
    const muted = run(b, [{ type: 'setParam', nodeId: 'sun_aim', paramPath: 'mute', value: true }]);
    expectSameTurns(a, muted);
    // Deleting the empty leaves it shining where it shone: the Track-To falls back to its point.
    expectSameTurns(
      a,
      run(b, buildDeleteNodesOps(b, ['sun_aim_target']) as Parameters<typeof run>[1]),
    );
  });

  it('a sun at rotation 0 whose position is keyed: its Track-To keeps it on the origin as it moves', () => {
    let a = withLight({ objectId: 'sun', lightKind: 'Directional', position: [7, 9, -4] });
    a = run(a, [
      {
        type: 'addNode',
        nodeId: 'sun_pos_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: 'sun',
          paramPath: 'position',
          keyframes: keys([
            [0, [7, 9, -4]],
            [2, [-6, 4, 5]],
          ]),
        },
      },
    ]);
    const b = migrate(a);
    expectSameTurns(a, b);
    expect(params(b, 'sun_aim').aimPoint).toEqual([0, 0, 0]);
  });

  it('a sun at rotation 0 inside a turning group gets a Track-To at the world origin', () => {
    let a = run(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'grp',
        nodeType: 'Group',
        params: { position: [3, 2, 1], rotation: [0, 30, 0] },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'addNode',
        nodeId: 'grp_rot_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'rotation',
          target: 'grp',
          paramPath: 'rotation',
          keyframes: keys([
            [0, [0, 30, 0]],
            [2, [20, 120, 0]],
          ]),
        },
      },
    ]);
    a = makeSplitLight(a, {
      objectId: 'sun',
      lightKind: 'Directional',
      position: [4, 6, 0],
      connectTo: { node: 'grp', socket: 'children' },
    }).state;
    const b = migrate(a);
    // The default scene's own sun, and the nested one.
    expect(expectSameTurns(a, b)).toBe(2 * TIMES.length);
    expect(params(b, 'sun_aim').aimSpace).toBe('world');
  });

  it('a sun turned by its rotation keeps its direction (its −Y becomes its −Z)', () => {
    const a = withLight({
      objectId: 'sun',
      lightKind: 'Directional',
      position: [1, 8, 2],
      rotation: [30, 40, 10],
    });
    expectSameTurns(a, migrate(a));
  });

  it('a quaternion-mode sun keeps its mode and its direction', () => {
    let a = withLight({ objectId: 'sun', lightKind: 'Directional', position: [1, 8, 2] });
    a = run(a, [
      { type: 'setParam', nodeId: 'sun', paramPath: 'rotationMode', value: 'quaternion' },
      { type: 'setParam', nodeId: 'sun', paramPath: 'quaternion', value: [0.2, 0.3, -0.1, 0.92] },
    ]);
    const b = migrate(a);
    expectSameTurns(a, b);
    expect(params(b, 'sun').rotationMode).toBe('quaternion');
  });

  // The user's decision: a sun with keyed rotation is not converted. Its keys stay as they were
  // and the person is told, by name, in the app's notice stack. A still sun says nothing.
  describe('a sun with keyed rotation is named in a notice', () => {
    const notices = () => useNotificationStore.getState().toasts;
    beforeEach(() => useNotificationStore.getState().clear());

    it('a keyed-rotation sun: a sticky warning names it, and its keys are kept', () => {
      let a = withLight({ objectId: 'key_sun', lightKind: 'Directional', position: [3, 7, 1] });
      a = run(a, [
        {
          type: 'addNode',
          nodeId: 'key_sun_rot',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'rotation',
            target: 'key_sun',
            paramPath: 'rotation',
            keyframes: keys([
              [0, [0, 0, 0]],
              [2, [40, 10, 0]],
            ]),
          },
        },
      ]);
      const b = migrate(a);
      expect(params(b, 'key_sun_rot')).toEqual(params(a, 'key_sun_rot'));
      const warned = notices().filter((t) => t.severity === 'warn');
      expect(warned).toHaveLength(1);
      expect(warned[0].message).toContain('"key_sun"');
      expect(warned[0].message).toMatch(/quarter turn/);
      expect(warned[0].durationMs).toBe(0);
    });

    it('a still sun: no notice', () => {
      migrate(withLight({ objectId: 'still_sun', lightKind: 'Directional', position: [3, 7, 1] }));
      expect(notices()).toEqual([]);
    });
  });
});
