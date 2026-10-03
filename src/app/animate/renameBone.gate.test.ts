// #1201 — renaming a bone renames every record that names it, and the rig moves exactly as before, as
// Blender's rename leaves it.
//
// Oracle: `ref/probes/blender-native-character/q1201_bone_rename_oracle.py` (Blender 5.1.1) imports
// `skinned-bar-two-clips.glb` (#1154) and renames Bone1 through RNA, as the UI name field does, four
// ways: plainly, to a dotted name, to another bone's name (Blender makes it `Bone0.001`), and to a name
// the bar already has a vertex group for (Blender leaves every group alone and warns). For each it
// dumps the bones, the bar's groups, the action paths and every deformed vertex at frames 0/12/24 —
// stored in `src/core/import/__fixtures__/blender-oracle-1201.json`. The first three deform exactly as
// before the rename; the fourth does not, and ours must not either.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { uniqueBoneName } from '../../core/import/nativeGltfSkeleton';
import { registerAllNodes } from '../../nodes/registerAll';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import type { ModifiedDataValue } from '../../nodes/types';
import { resolveWorldTransform } from '../resolveWorldTransform';
import { renameBone } from './renameBone';
import { renameBoneMutator } from '../../agent/mutators/builders/renameBone';
import { validatePlan } from '../../agent/mutators/validate';
import oracle from '../../core/import/__fixtures__/blender-oracle-1201.json';
import { sceneOnlyState } from '../../test-utils/sceneOnlyState';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

type Arm = {
  bones: string[];
  groups: string[];
  deform: Record<string, number[][][]>;
  deform_wave?: Record<string, number[][][]>;
};
const ORACLE = oracle as unknown as Record<string, Arm>;
const FRAMES = [0, 12, 24] as const;
const at = (frame: number) => ({ time: { frame, seconds: frame / 24, normalized: 0 } }) as never;

function bytesOf(file: string): ArrayBuffer {
  const bytes = readFileSync(`public/assets/${file}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const nodesOf = (state: DagState, type: string) =>
  Object.values(state.nodes).filter((n) => n.type === type);
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const setParam = (state: DagState, nodeId: string, paramPath: string, value: unknown) =>
  applyOp(state, { type: 'setParam', nodeId, paramPath, value } as never).next;

async function importBar(): Promise<{ state: DagState; armature: string; data: string }> {
  const result = await buildNativeGltfImportOps({
    buffer: bytesOf('skinned-bar-two-clips.glb'),
    assetRef: 'user-imports/native/skinned-bar-two-clips.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  const state = apply(sceneOnlyState(), result.ops);
  const armature = nodesOf(state, 'Object').find(
    (n) => state.nodes[(n.inputs.data as { node: string }).node]?.type === 'Skeleton',
  )!.id;
  const data = nodesOf(state, 'PolyMeshData')[0].id;
  return { state, armature, data };
}

const skeletonOf = (state: DagState) =>
  (nodesOf(state, 'Skeleton')[0].params as { bones: { name: string }[] }).bones.map((b) => b.name);
const groupsOf = (state: DagState, data: string) =>
  (state.nodes[data].params as { mesh: { vertexGroups: string[] } }).mesh.vertexGroups;

/** Only layer `name` playing. */
function playOnly(state: DagState, name: string): DagState {
  let s = state;
  for (const layer of nodesOf(s, 'PoseLayer')) {
    s = setParam(s, layer.id, 'mute', (layer.params as { name: string }).name !== name);
  }
  return s;
}

/** Every deformed vertex against the oracle, looked up by its rest point. Returns how many compared. */
function expectDeformLike(state: DagState, want: Record<string, number[][][]>, label: string) {
  const modifierId = nodesOf(state, 'ArmatureModifier')[0].id;
  const value = evaluate(state, modifierId, { ctx: at(0) }).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh' || !value.skin) throw new Error('no skinned mesh');
  const mesh = descriptor.data;
  const key = (p: ArrayLike<number>, i: number) =>
    [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]
      .map((v) => String(Math.round(v * 1e4) / 1e4 + 0))
      .join(',');
  let compared = 0;
  for (const frame of FRAMES) {
    const out = sampleSkinDeform(value.skin, mesh, frame / 24);
    const byRest = new Map<string, number[]>();
    for (let i = 0; i < mesh.points.length / 3; i++) {
      byRest.set(key(mesh.points, i), [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    }
    for (const [rest, w] of want[String(frame)]) {
      const v = byRest.get(key(rest, 0));
      expect(v, `${label}: vertex resting at ${rest}`).toBeDefined();
      w.forEach((c, k) => expect(v![k], `${label} f${frame} ${rest} axis ${k}`).toBeCloseTo(c, 5));
      compared++;
    }
  }
  return compared;
}

function renamed(state: DagState, armature: string, from: string, to: string) {
  const result = renameBone(state, armature, from, to);
  if (!result.ok) throw new Error(result.reason);
  return { state: apply(state, result.ops), report: result.report };
}

describe('uniqueBoneName — Blender’s BLI_uniquename_cb', () => {
  const taken = (names: string[]) => (n: string) => names.includes(n);
  it.each([
    ['Renamed', [], 'Renamed'],
    ['Bone0', ['Bone0'], 'Bone0.001'],
    ['Bone0', ['Bone0', 'Bone0.001'], 'Bone0.002'],
    ['Bone0.005', ['Bone0.005'], 'Bone0.006'],
    ['Arm.L', ['Arm.L'], 'Arm.L.001'],
    ['', [], 'Bone'],
    ['', ['Bone'], 'Bone.001'],
  ])('%s among %j → %s', (name, names, want) => {
    expect(uniqueBoneName(name as string, taken(names as string[]))).toBe(want);
  });
});

describe('#1201 — a bone rename, against Blender', () => {
  it('the rig deforms as Blender’s before any rename (the oracle’s own control)', async () => {
    const { state } = await importBar();
    expect(expectDeformLike(playOnly(state, 'bend'), ORACLE.base.deform, 'base')).toBe(18);
    expect(expectDeformLike(playOnly(state, 'Wave'), ORACLE.base.deform_wave!, 'base Wave')).toBe(
      18,
    );
  });

  it.each([
    ['rename', 'Renamed'],
    ['dotted', 'Arm.L'],
    ['bonehit', 'Bone0'],
  ])(
    '%s (Bone1 → %s): Blender’s names, and every vertex where Blender puts it',
    async (arm, asked) => {
      const bar = await importBar();
      const { state, report } = renamed(bar.state, bar.armature, 'Bone1', asked);
      const want = ORACLE[arm];
      expect(skeletonOf(state)).toEqual(want.bones);
      expect(groupsOf(state, bar.data)).toEqual(want.groups);
      expect(report.name).toBe(want.bones[1]);
      expect(report.left).toEqual([]);
      // Both layers — the one playing and the held Wave — now key the bone under its new name.
      expect(report.layers).toHaveLength(2);
      for (const layer of nodesOf(state, 'PoseLayer')) {
        const p = layer.params as { members: { bone: string }[]; channels: { bone: string }[] };
        const named = [...p.members, ...p.channels].map((r) => r.bone).filter((b) => b !== '');
        expect(named, `layer ${(layer.params as { name: string }).name}`).not.toContain('Bone1');
        expect(named).toContain(report.name);
      }
      expect(expectDeformLike(playOnly(state, 'bend'), want.deform, arm)).toBe(18);
      if (want.deform_wave) {
        expect(expectDeformLike(playOnly(state, 'Wave'), want.deform_wave, `${arm} Wave`)).toBe(18);
      }
    },
  );

  it('grouphit: a mesh that already has a group of the new name keeps its groups, and moves as Blender’s does', async () => {
    const bar = await importBar();
    const mesh = (bar.state.nodes[bar.data].params as { mesh: { vertexGroups: string[] } }).mesh;
    const withExtra = setParam(bar.state, bar.data, 'mesh', {
      ...mesh,
      vertexGroups: [...mesh.vertexGroups, 'Extra'],
    });
    const { state, report } = renamed(withExtra, bar.armature, 'Bone1', 'Extra');
    const want = ORACLE.grouphit;
    expect(skeletonOf(state)).toEqual(want.bones);
    expect(groupsOf(state, bar.data)).toEqual(want.groups);
    expect(report.meshes).toEqual([]);
    expect(report.left).toEqual([{ node: bar.data, why: expect.stringContaining('“Extra”') }]);
    // Blender's deform changes here (up to 1.18): Bone1's vertices no longer find their bone.
    expect(expectDeformLike(playOnly(state, 'bend'), want.deform, 'grouphit')).toBe(18);
  });

  it('is one step: every op sets a whole list or record, never a path into one', async () => {
    const bar = await importBar();
    const result = renameBone(bar.state, bar.armature, 'Bone1', 'Renamed');
    if (!result.ok) throw new Error(result.reason);
    expect(result.ops.map((op) => (op as { paramPath: string }).paramPath).sort()).toEqual([
      'bones',
      'channels',
      'channels',
      'members',
      'members',
      'mesh',
    ]);
  });

  it('asking for the name it has is no rename; an unknown bone and a non-armature are refused', async () => {
    const bar = await importBar();
    const same = renameBone(bar.state, bar.armature, 'Bone1', 'Bone1');
    expect(same.ok && same.ops).toEqual([]);
    const missing = renameBone(bar.state, bar.armature, 'Nope', 'X');
    expect(missing.ok).toBe(false);
    const notArmature = renameBone(bar.state, bar.data, 'Bone1', 'X');
    expect(notArmature.ok).toBe(false);
  });
});

describe('#1201 — an Object parented to the bone follows the rename', () => {
  it('the prop keeps standing on Bone1 under its new name, at every frame', async () => {
    const bytes = readFileSync('public/assets/skinned-bar-bone-prop.glb');
    let state = buildDefaultDagState();
    const result = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      assetRef: 'user-imports/native/skinned-bar-bone-prop.glb',
      sceneNodeId: state.outputs.scene!.node,
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    state = apply(state, result.ops);
    const prop = Object.values(state.nodes).find((n) => n.meta?.name === 'Prop')!.id;
    const armature = nodesOf(state, 'Object').find(
      (n) => state.nodes[(n.inputs.data as { node: string }).node]?.type === 'Skeleton',
    )!.id;
    const before = FRAMES.map((f) => resolveWorldTransform(state, prop, at(f))!.matrix);
    const { state: after, report } = renamed(state, armature, 'Bone1', 'Forearm');
    expect(report.parented).toEqual([prop]);
    expect((after.nodes[prop].params as { parentBone: string }).parentBone).toBe('Forearm');
    FRAMES.forEach((f, i) => {
      const m = resolveWorldTransform(after, prop, at(f))!.matrix;
      m.forEach((c, k) => expect(c, `f${f} [${k}]`).toBeCloseTo(before[i][k], 9));
    });
    // Control: the prop moves across the clip, so a prop left at the armature origin would show.
    expect(
      new THREE.Matrix4().fromArray(before[0]).equals(new THREE.Matrix4().fromArray(before[2])),
    ).toBe(false);
  });
});

describe('#1201 — a bone map follows on the side this rig stands on', () => {
  /** The bar, plus a second rig and retargets between them, each reading `map`. */
  async function withRetargets(
    retargets: { source: 'bar' | 'other'; target: 'bar' | 'other'; map: string }[],
    maps: Record<string, Record<string, string>>,
  ) {
    const bar = await importBar();
    const barSkeleton = nodesOf(bar.state, 'Skeleton')[0].id;
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'other_sk', nodeType: 'Skeleton', params: {} } as Op,
    ];
    for (const [id, map] of Object.entries(maps)) {
      ops.push({ type: 'addNode', nodeId: id, nodeType: 'BoneNameMap', params: { map } } as Op);
    }
    const sk = (side: 'bar' | 'other') => (side === 'bar' ? barSkeleton : 'other_sk');
    retargets.forEach((r, i) => {
      const id = `rt_${i}`;
      ops.push(
        { type: 'addNode', nodeId: id, nodeType: 'RetargetClip', params: {} } as Op,
        {
          type: 'connect',
          from: { node: sk(r.source), socket: 'pose' },
          to: { node: id, socket: 'source' },
        },
        {
          type: 'connect',
          from: { node: sk(r.target), socket: 'out' },
          to: { node: id, socket: 'skeleton' },
        },
        {
          type: 'connect',
          from: { node: r.map, socket: 'out' },
          to: { node: id, socket: 'boneMap' },
        },
      );
    });
    return { ...bar, state: apply(bar.state, ops) };
  }
  const mapOf = (state: DagState, id: string) => (state.nodes[id].params as { map: object }).map;

  it('this rig as the target: the value follows', async () => {
    const r = await withRetargets([{ source: 'other', target: 'bar', map: 'm' }], {
      m: { torso: 'Bone1', root: 'Bone0' },
    });
    const { state, report } = renamed(r.state, r.armature, 'Bone1', 'Renamed');
    expect(mapOf(state, 'm')).toEqual({ torso: 'Renamed', root: 'Bone0' });
    expect(report.maps).toEqual(['m']);
  });

  it('a value spelled as the retarget resolves it (separator- and case-free) follows too', async () => {
    // The retarget binds `BONE_1` to Bone1 (`resolveBoneNames`: canonical key when no exact name);
    // an exact-match rewrite would leave it naming a bone that is gone, and the bind would drop it.
    const r = await withRetargets([{ source: 'other', target: 'bar', map: 'm' }], {
      m: { torso: 'BONE_1', root: 'Bone0' },
    });
    const { state } = renamed(r.state, r.armature, 'Bone1', 'Renamed');
    expect(mapOf(state, 'm')).toEqual({ torso: 'Renamed', root: 'Bone0' });
  });

  it('this rig as the source: the key follows', async () => {
    const r = await withRetargets([{ source: 'bar', target: 'other', map: 'm' }], {
      m: { Bone1: 'torso', Bone0: 'root' },
    });
    const { state } = renamed(r.state, r.armature, 'Bone1', 'Renamed');
    expect(mapOf(state, 'm')).toEqual({ Renamed: 'torso', Bone0: 'root' });
  });

  it('a map another rig also reads is left, and said', async () => {
    const r = await withRetargets(
      [
        { source: 'other', target: 'bar', map: 'm' },
        { source: 'bar', target: 'other', map: 'm' },
      ],
      { m: { Bone1: 'Bone1' } },
    );
    // Both retargets read `m`, but on opposite sides: keys follow only if every reader has this rig as
    // its source, and one does not.
    const { state, report } = renamed(r.state, r.armature, 'Bone1', 'Renamed');
    expect(mapOf(state, 'm')).toEqual({ Bone1: 'Bone1' });
    expect(report.maps).toEqual([]);
    expect(report.left.map((l) => l.node)).toEqual(['m']);
  });

  it('#1253 — a key naming the bone, read from a motion whose rig cannot be told, is left and said', async () => {
    const bar = await importBar();
    const state = apply(bar.state, [
      { type: 'addNode', nodeId: 'other', nodeType: 'Skeleton', params: {} } as Op,
      // A clip with no rig edge: which rig its pose wire carries is not in the graph.
      { type: 'addNode', nodeId: 'clip', nodeType: 'AnimationClip', params: {} } as Op,
      {
        type: 'addNode',
        nodeId: 'm',
        nodeType: 'BoneNameMap',
        params: { map: { Bone1: 'torso' } },
      } as Op,
      { type: 'addNode', nodeId: 'rt', nodeType: 'RetargetClip', params: {} } as Op,
      {
        type: 'connect',
        from: { node: 'clip', socket: 'pose' },
        to: { node: 'rt', socket: 'source' },
      },
      {
        type: 'connect',
        from: { node: 'other', socket: 'out' },
        to: { node: 'rt', socket: 'skeleton' },
      },
      {
        type: 'connect',
        from: { node: 'm', socket: 'out' },
        to: { node: 'rt', socket: 'boneMap' },
      },
    ]);
    const { state: after, report } = renamed(state, bar.armature, 'Bone1', 'Renamed');
    // Not guessed: the key stays.
    expect(mapOf(after, 'm')).toEqual({ Bone1: 'torso' });
    expect(report.left).toEqual([{ node: 'm', why: expect.stringMatching(/cannot be told/) }]);
  });

  it('a map that does not name the bone is not touched', async () => {
    const r = await withRetargets([{ source: 'other', target: 'bar', map: 'm' }], {
      m: { root: 'Bone0' },
    });
    const result = renameBone(r.state, r.armature, 'Bone1', 'Renamed');
    expect(result.ok && result.report.maps).toEqual([]);
  });
});

describe('#1201 — a generated rig is refused', () => {
  it('a skeleton a motion generator re-cooks would lose the rename, so it is refused with why', async () => {
    const bar = await importBar();
    const skeleton = nodesOf(bar.state, 'Skeleton')[0].id;
    const state = apply(bar.state, [
      {
        type: 'addNode',
        nodeId: 'gen',
        nodeType: 'MotionGenerate',
        params: { prompt: 'walk', seed: 1, model: 'kimodo' },
      } as Op,
      { type: 'addNode', nodeId: 'clip', nodeType: 'AnimationClip', params: {} } as Op,
      {
        type: 'connect',
        from: { node: 'gen', socket: 'out' },
        to: { node: 'clip', socket: 'source' },
      },
      {
        type: 'connect',
        from: { node: skeleton, socket: 'out' },
        to: { node: 'clip', socket: 'skeleton' },
      },
    ]);
    const result = renameBone(state, bar.armature, 'Bone1', 'Renamed');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/generated/);
    // Control: the same rig without the generator renames.
    expect(renameBone(bar.state, bar.armature, 'Bone1', 'Renamed').ok).toBe(true);
  });
});

describe('#1201 — the agent renames through the same function, inside its declared scope', () => {
  it('on the imported bar with a retarget reading a map, every gate passes and the ops are the rename’s', async () => {
    const bar = await importBar();
    const skeleton = nodesOf(bar.state, 'Skeleton')[0].id;
    const state = apply(bar.state, [
      { type: 'addNode', nodeId: 'other', nodeType: 'Skeleton', params: {} } as Op,
      {
        type: 'addNode',
        nodeId: 'm',
        nodeType: 'BoneNameMap',
        params: { map: { torso: 'Bone1' } },
      } as Op,
      { type: 'addNode', nodeId: 'rt', nodeType: 'RetargetClip', params: {} } as Op,
      {
        type: 'connect',
        from: { node: 'other', socket: 'pose' },
        to: { node: 'rt', socket: 'source' },
      },
      {
        type: 'connect',
        from: { node: skeleton, socket: 'out' },
        to: { node: 'rt', socket: 'skeleton' },
      },
      {
        type: 'connect',
        from: { node: 'm', socket: 'out' },
        to: { node: 'rt', socket: 'boneMap' },
      },
    ]);
    const spec = { object: bar.armature, bone: 'Bone1', name: 'Bone0' };
    const plan = validatePlan(renameBoneMutator, spec, state, 'rename the forearm');
    if (!plan.ok) throw new Error(JSON.stringify(plan));
    const direct = renameBone(state, bar.armature, 'Bone1', 'Bone0');
    if (!direct.ok) throw new Error(direct.reason);
    expect(plan.ops).toEqual(direct.ops);
    // Skeleton, both layers (members + channels), the bar's mesh data and the map.
    expect(new Set(plan.ops.map((op) => (op as { nodeId: string }).nodeId)).size).toBe(5);
    expect(plan.warnings).toContain('the bone is named “Bone0.001”: “Bone0” was taken');
  });
});
