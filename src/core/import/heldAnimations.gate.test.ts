// #1154 — a glTF file with several animations comes across whole: the first plays, the rest are held
// muted, and each one, played alone, moves the scene where Blender 5.1.1 moves it.
//
// Blender's importer stashes every animation on a muted NLA track of each object or armature it drives
// and makes the first the active action (`io_scene_gltf2/blender/imp/animation_utils.py:20-29`,
// `scene.py:86-89`); names are made unique with `.001` (`blender_gltf.py:237-244`). Here a held
// animation's Object channels are a muted `Track` of `Strip`s placing `Action`s, and its bone channels
// a muted override `PoseLayer` above the base (design D-C: NLA for scene parameters, pose layers for
// bones).
//
// Oracle: `ref/probes/blender-native-character/q1154_two_clips_oracle.py` builds both fixtures
// (byte-reproducible) and, for each animation, re-imports, puts every object and bone at rest, makes
// that animation active the importer's own way (`restore_animation_on_object`) and dumps world points
// (objects) and every deformed vertex (bar) at frames 0/6/12/18/24 — key times and segment midpoints
// only, where Blender's quaternion interpolation and ours agree (Blender lerps components, we slerp).
// Stored in `__fixtures__/blender-oracle-1154.json`.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { applyOp, evaluate, __resetRegistryForTests } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildNativeGltfImportOps } from './nativeGltfImport';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import type { ModifiedDataValue } from '../../nodes/types';
import oracle from './__fixtures__/blender-oracle-1154.json';
import { sceneOnlyState } from '../../test-utils/sceneOnlyState';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const FRAMES = [0, 6, 12, 18, 24] as const;
const at = (frame: number) => ({ time: { frame, seconds: frame / 24, normalized: 0 } }) as never;

function bytesOf(file: string): ArrayBuffer {
  const bytes = readFileSync(`public/assets/${file}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const nodesOf = (state: DagState, type: string) =>
  Object.values(state.nodes).filter((n) => n.type === type);
const setParam = (state: DagState, nodeId: string, paramPath: string, value: unknown) =>
  applyOp(state, { type: 'setParam', nodeId, paramPath, value } as never).next;

// ── Objects: three-clips-nested.gltf ─────────────────────────────────────────────────────────
async function importNested() {
  const result = await buildNativeGltfImportOps({
    buffer: bytesOf('three-clips-nested.gltf'),
    assetRef: 'user-imports/native/three-clips-nested.gltf',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'unused',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state: DagState = buildDefaultDagState();
  for (const op of result.ops) state = applyOp(state, op).next;
  const byName = (name: string) =>
    Object.values(state.nodes).find((n) => n.meta?.name === name && n.type !== 'Strip')!.id;
  return { state, ids: { A: byName('A'), B: byName('B'), C: byName('C') } };
}

/** Only animation `name` playing: the first's bare channels off unless it is the first, every track
 *  muted but its own. */
function playOnly(state: DagState, name: string, first: string): DagState {
  let s = state;
  for (const channel of Object.values(s.nodes).filter((n) =>
    n.type.startsWith('KeyframeChannel'),
  )) {
    s = setParam(s, channel.id, 'mute', name !== first);
  }
  for (const track of nodesOf(s, 'Track')) {
    s = setParam(s, track.id, 'mute', (track.params as { name: string }).name !== name);
  }
  return s;
}

describe('#1154 — three animations on nested objects, against Blender', () => {
  it('lands as Blender stashes it: the first plays as bare channels, the rest muted tracks', async () => {
    const { state, ids } = await importNested();
    const tracks = nodesOf(state, 'Track').map(
      (t) => t.params as { name: string; mute: boolean; strips: string[] },
    );
    // Blender: A = active Slide, tracks Lift + Slide; B = track Lift; C = track Slide.001.
    const heldOn = (id: string) =>
      tracks
        .filter((t) =>
          t.strips.some((s) => (state.nodes[s].params as { target: string }).target === id),
        )
        .map((t) => t.name)
        .sort();
    const blender = oracle.nested.structure as unknown as Record<
      string,
      { active: string | null; tracks: [string, boolean][] }
    >;
    for (const [name, id] of Object.entries(ids)) {
      const want = blender[name].tracks.map(([n]) => n).filter((n) => n !== blender[name].active);
      expect(heldOn(id), `held animations on ${name}`).toEqual(want.sort());
    }
    expect(tracks.every((t) => t.mute)).toBe(true);
    expect(tracks.map((t) => t.name).sort()).toEqual(['Lift', 'Slide.001']);
    // The first animation is bare channels on A alone (its translation), as Blender's active action.
    const bare = Object.values(state.nodes).filter((n) => n.type.startsWith('KeyframeChannel'));
    expect(bare.map((n) => (n.params as { target: string }).target)).toEqual([ids.A]);
  });

  it.each(['Slide', 'Lift', 'Slide.001'])(
    '%s alone: every object where Blender puts it at frames 0/6/12/18/24',
    async (name) => {
      const imported = await importNested();
      const state = playOnly(imported.state, name, 'Slide');
      const want = (
        oracle.nested.by_track as Record<string, Record<string, Record<string, number[][]>>>
      )[name];
      let compared = 0;
      for (const frame of FRAMES) {
        for (const [objectName, id] of Object.entries(imported.ids)) {
          const world = resolveWorldTransform(state, id, at(frame))!;
          const points = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)].map(
            (p) => p.applyMatrix4(new Matrix4().fromArray(world.matrix)),
          );
          want[frame][objectName].forEach((w, k) =>
            w.forEach((c, axis) =>
              expect(
                points[k].getComponent(axis),
                `${objectName} f${frame} point ${k}`,
              ).toBeCloseTo(c, 5),
            ),
          );
          compared++;
        }
      }
      expect(compared).toBe(FRAMES.length * 3);
    },
  );
});

// ── Bones: skinned-bar-two-clips.glb ─────────────────────────────────────────────────────────
async function importBar() {
  const result = await buildNativeGltfImportOps({
    buffer: bytesOf('skinned-bar-two-clips.glb'),
    assetRef: 'user-imports/native/skinned-bar-two-clips.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state = sceneOnlyState();
  for (const op of result.ops) state = applyOp(state, op).next;
  return state;
}

function deformed(state: DagState) {
  const modifierId = nodesOf(state, 'ArmatureModifier')[0].id;
  const value = evaluate(state, modifierId, { ctx: at(0) }).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh' || !value.skin) throw new Error('no skinned mesh');
  const mesh = descriptor.data;
  const key = (p: ArrayLike<number>, i: number) =>
    [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]
      .map((v) => String(Math.round(v * 1e4) / 1e4 + 0))
      .join(',');
  return (frame: number) => {
    const out = sampleSkinDeform(value.skin!, mesh, frame / 24);
    const byRest = new Map<string, number[]>();
    for (let i = 0; i < mesh.points.length / 3; i++) {
      byRest.set(key(mesh.points, i), [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    }
    return (rest: readonly number[]) => byRest.get(key(rest, 0));
  };
}

describe('#1154 — a skinned bar with two animations, against Blender', () => {
  it('the first is the base layer; the second a muted override layer above it, named after it', async () => {
    const state = await importBar();
    const layers = nodesOf(state, 'PoseLayer');
    expect(
      layers.map((l) => [
        (l.params as { name: string }).name,
        (l.params as { mute?: boolean }).mute ?? false,
      ]),
    ).toEqual([
      ['bend', false],
      ['Wave', true],
    ]);
    // Chained Skeleton.pose → bend → Wave → Object.pose.
    const [base, wave] = layers;
    expect(state.nodes[base.id].inputs.pose).toMatchObject({ socket: 'pose' });
    expect(state.nodes[wave.id].inputs.pose).toEqual({ node: base.id, socket: 'out' });
    const object = Object.values(state.nodes).find(
      (n) =>
        n.type === 'Object' && (n.inputs.pose as { node?: string } | undefined)?.node === wave.id,
    );
    expect(object, 'the armature Object reads the top of the chain').toBeDefined();
  });

  it.each(['bend', 'Wave'])('%s alone: every vertex where Blender puts it', async (name) => {
    let state = await importBar();
    for (const layer of nodesOf(state, 'PoseLayer')) {
      state = setParam(state, layer.id, 'mute', (layer.params as { name: string }).name !== name);
    }
    const ours = deformed(state);
    const want = (oracle.bar.by_track as Record<string, Record<string, number[][][]>>)[name];
    let compared = 0;
    for (const frame of FRAMES) {
      const got = ours(frame);
      for (const [rest, w] of want[frame]) {
        const v = got(rest);
        expect(v, `vertex resting at ${rest}`).toBeDefined();
        w.forEach((c, k) => expect(v![k], `${name} f${frame} ${rest} axis ${k}`).toBeCloseTo(c, 5));
        compared++;
      }
    }
    expect(compared).toBe(FRAMES.length * want[0].length);
  });
});
