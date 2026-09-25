// #1216 — a saved clone-road character loads as exactly the nodes a fresh import writes, with the
// director's edits carried across or the character kept and each edit named.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp } from '../../core/dag/ops';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { buildGltfImportOps, hashId } from '../../core/import/gltfImportChain';
import { buildSavedCharacterOps } from '../../core/import/nativeGltfImport';
import {
  convertCloneCharacters,
  convertLoadedProject,
  reportCharacterConversion,
  type ConvertCloneCharactersDeps,
} from './convertCloneCharacters';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { composeProject, loadProject, saveProject } from '../../core/project/io';

// The native build is the only step that writes into the project (the file's images), so a
// character that is kept must never reach it. Spied, since no skinned fixture carries a texture.
vi.mock('../../core/import/nativeGltfImport', async (original) => {
  const actual = await original<typeof import('../../core/import/nativeGltfImport')>();
  return { ...actual, buildSavedCharacterOps: vi.fn(actual.buildSavedCharacterOps) };
});

const REF = 'user-imports/skinned-bar/skinned-bar.glb';

function bytesOf(fixture: string): Uint8Array {
  return new Uint8Array(readFileSync(`public/assets/${fixture}`));
}

function deps(
  fixture: string | Uint8Array | null,
  stored: string[] = [],
): ConvertCloneCharactersDeps {
  return {
    read: async (path) => {
      if (fixture === null || path !== REF) throw new Error(`no file at ${path}`);
      return typeof fixture === 'string' ? bytesOf(fixture) : fixture;
    },
    storeImage: async (_bytes, mime) => {
      stored.push(mime);
      return `img_${stored.length}`;
    },
  };
}

/** A GLB fixture with its JSON chunk rewritten; the binary chunk is carried over untouched. */
type GltfJsonForTest = {
  animations: { channels: { sampler: number; target: { node: number; path: string } }[] }[];
};

function glbWith(fixture: string, mutate: (json: GltfJsonForTest) => void): Uint8Array {
  const src = readFileSync(`public/assets/${fixture}`);
  const jsonLength = src.readUInt32LE(12);
  const json = JSON.parse(src.subarray(20, 20 + jsonLength).toString());
  mutate(json);
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonBytes = Buffer.from(text);
  const rest = src.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([header, jsonBytes, rest]));
}

function apply(state: DagState, ops: readonly Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

function argsFor(fixture: string | Uint8Array) {
  const bytes = typeof fixture === 'string' ? bytesOf(fixture) : fixture;
  return {
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: REF,
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  };
}

/** A project holding the file on the clone road, as a save from before #1205 does. */
async function savedClone(fixture: string | Uint8Array): Promise<DagState> {
  const clone = await buildGltfImportOps(argsFor(fixture), buildDefaultDagState());
  return apply(buildDefaultDagState(), clone.ops);
}

/** The same project with the file imported fresh on the native road. */
async function freshNative(fixture: string): Promise<DagState> {
  const native = await buildSavedCharacterOps(argsFor(fixture));
  if ('refused' in native) throw new Error(native.refused);
  return apply(buildDefaultDagState(), native.ops);
}

const cloneTypes = (state: DagState): string[] =>
  Object.values(state.nodes)
    .map((n) => n.type)
    .filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t));

beforeEach(() => {
  vi.mocked(buildSavedCharacterOps).mockClear();
  __resetRegistryForTests();
  registerAllNodes();
});

describe('an untouched saved character', () => {
  it.each(['skinned-bar.glb', 'skinned-bar-child-mesh.glb', 'two-skinned-bars.glb'])(
    '%s converts to exactly the nodes a fresh native import writes',
    async (fixture) => {
      const saved = await savedClone(fixture);
      expect(cloneTypes(saved).length).toBeGreaterThan(0);
      const { state, report } = await convertCloneCharacters(saved, deps(fixture));
      expect(report.kept).toEqual([]);
      expect(report.converted).toEqual([{ name: 'skinned-bar.glb', assetRef: REF, notes: [] }]);
      expect(cloneTypes(state)).toEqual([]);
      expect(state.nodes).toEqual((await freshNative(fixture)).nodes);
    },
  );
});

/** The clone child Object standing for the file's node named `key`. */
function cloneChild(state: DagState, key: string): string {
  const asset = Object.values(state.nodes).find((n) => n.type === 'GltfAsset')!;
  return (asset.params as { nodeNameMap: Record<string, string> }).nodeNameMap[key];
}

describe('edits carried across', () => {
  it('keeps the placement, the name, the parent and the place among its siblings', async () => {
    let saved = await savedClone('skinned-bar.glb');
    const grp = hashId('grp', REF);
    saved = apply(saved, [
      { type: 'addNode', nodeId: 'n_holder', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'n_holder', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'disconnect',
        from: { node: grp, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      { type: 'addNode', nodeId: 'n_sib', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'n_sib', socket: 'out' },
        to: { node: 'n_holder', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: grp, socket: 'out' },
        to: { node: 'n_holder', socket: 'children' },
        index: 0,
      },
      { type: 'setParam', nodeId: grp, paramPath: 'position', value: [3, 0, -2] },
      { type: 'setParam', nodeId: grp, paramPath: 'rotation', value: [0, 90, 0] },
      { type: 'setMeta', nodeId: grp, name: 'Hero' },
      { type: 'setHidden', nodeId: grp, hidden: true },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(report.converted).toEqual([{ name: 'Hero', assetRef: REF, notes: [] }]);
    const nativeGrp = hashId('nativeGrp', REF);
    expect(state.nodes.n_holder.inputs.children).toEqual([
      { node: nativeGrp, socket: 'out' },
      { node: 'n_sib', socket: 'out' },
    ]);
    const sceneChildren = [state.nodes.n_scene.inputs.children].flat().map((r) => r?.node);
    expect(sceneChildren).not.toContain(nativeGrp);
    const params = state.nodes[nativeGrp].params as { position: number[]; rotation: number[] };
    expect(params.position).toEqual([3, 0, -2]);
    expect(params.rotation).toEqual([0, 90, 0]);
    expect(state.nodes[nativeGrp].meta).toEqual({ name: 'Hero', hidden: true });
  });

  it('keeps a child the director hung under the character', async () => {
    let saved = await savedClone('skinned-bar.glb');
    const grp = hashId('grp', REF);
    saved = apply(saved, [
      { type: 'addNode', nodeId: 'n_hat', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'n_hat', socket: 'out' },
        to: { node: grp, socket: 'children' },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(report.kept).toEqual([]);
    const children = [state.nodes[hashId('nativeGrp', REF)].inputs.children].flat();
    expect(children).toContainEqual({ node: 'n_hat', socket: 'out' });
  });

  it("moves the file's empty where the director moved it, as the same rotation in quaternion mode", async () => {
    let saved = await savedClone('skinned-bar-child-mesh.glb');
    const armature = cloneChild(saved, 'SkinnedBar');
    saved = apply(saved, [
      { type: 'setParam', nodeId: armature, paramPath: 'position', value: [1, 2, 3] },
      { type: 'setParam', nodeId: armature, paramPath: 'rotation', value: [0, 0, 90] },
      {
        type: 'setParam',
        nodeId: armature,
        paramPath: 'overridden',
        value: { position: true, rotation: true },
      },
    ]);
    const { state, report } = await convertCloneCharacters(
      saved,
      deps('skinned-bar-child-mesh.glb'),
    );
    expect(report.kept).toEqual([]);
    const empty = state.nodes[hashId('nativeEmpty', REF, 'SkinnedBar')].params as {
      position: number[];
      quaternion: number[];
    };
    expect(empty.position).toEqual([1, 2, 3]);
    const s = Math.SQRT1_2;
    [0, 0, s, s].forEach((v, i) => expect(empty.quaternion[i]).toBeCloseTo(v, 12));
  });

  it("re-targets a position channel on the file's empty", async () => {
    let saved = await savedClone('skinned-bar-child-mesh.glb');
    const armature = cloneChild(saved, 'SkinnedBar');
    saved = apply(saved, [
      {
        type: 'addNode',
        nodeId: 'n_ch',
        nodeType: 'KeyframeChannelVec3',
        params: { name: 'position', target: armature, paramPath: 'position', keyframes: [] },
      },
    ]);
    const { state, report } = await convertCloneCharacters(
      saved,
      deps('skinned-bar-child-mesh.glb'),
    );
    expect(report.kept).toEqual([]);
    expect((state.nodes.n_ch.params as { target: string }).target).toBe(
      hashId('nativeEmpty', REF, 'SkinnedBar'),
    );
  });
});

describe('a moved child the file animates (the clone let the gizmo outrank the clip)', () => {
  // The file's empty, animated by the same keys as its first channel (a rotation).
  const animatedEmpty = () =>
    glbWith('skinned-bar-child-mesh.glb', (json) => {
      const first = json.animations[0].channels[0];
      json.animations[0].channels.push({
        sampler: first.sampler,
        target: { node: 3, path: first.target.path },
      });
    });

  it("converts: the moved value is written, the file's keys play over it (Blender), and the load says so", async () => {
    const fixture = animatedEmpty();
    let saved = await savedClone(fixture);
    const armature = cloneChild(saved, 'SkinnedBar');
    saved = apply(saved, [
      { type: 'setParam', nodeId: armature, paramPath: 'position', value: [1, 0, 0] },
      { type: 'setParam', nodeId: armature, paramPath: 'rotation', value: [0, 0, 90] },
      {
        type: 'setParam',
        nodeId: armature,
        paramPath: 'overridden',
        value: { position: true, rotation: true },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps(fixture));
    expect(report.kept).toEqual([]);
    expect(report.converted[0].notes).toEqual([
      `the file's animation now plays "SkinnedBar"'s rotation over the value it was moved to, as a value set under an F-curve is in Blender`,
    ]);
    const empty = hashId('nativeEmpty', REF, 'SkinnedBar');
    const params = state.nodes[empty].params as { position: number[]; quaternion: number[] };
    // The position is not keyed by the file: it stays where it was moved.
    expect(params.position).toEqual([1, 0, 0]);
    const s = Math.SQRT1_2;
    [0, 0, s, s].forEach((v, i) => expect(params.quaternion[i]).toBeCloseTo(v, 12));
    // The rotation is: the file's channel on it is there, and plays.
    expect(state.nodes[`${empty}_quaternion_channel`]?.type).toBe('KeyframeChannelQuat');
  });

  it('a value moved without its override bit is not carried: the clone drew the clip there', async () => {
    const fixture = animatedEmpty();
    let saved = await savedClone(fixture);
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: cloneChild(saved, 'SkinnedBar'),
        paramPath: 'position',
        value: [1, 0, 0],
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps(fixture));
    expect(report.converted[0].notes).toEqual([]);
    const native = await buildSavedCharacterOps(argsFor(fixture));
    if ('refused' in native) throw new Error(native.refused);
    expect(state.nodes).toEqual(apply(buildDefaultDagState(), native.ops).nodes);
  });
});

describe('a character that is kept, and says why', () => {
  it('a renamed bone: kept as saved, named, and nothing written', async () => {
    let saved = await savedClone('skinned-bar.glb');
    const bone = cloneChild(saved, 'Bone1');
    saved = apply(saved, [{ type: 'setMeta', nodeId: bone, name: 'Forearm' }]);
    const stored: string[] = [];
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb', stored));
    expect(state).toBe(saved);
    expect(report.converted).toEqual([]);
    expect(report.kept).toEqual([
      {
        name: 'skinned-bar.glb',
        assetRef: REF,
        why: ['"Forearm" was renamed, and it is a bone, which has no node of its own natively'],
      },
    ]);
    expect(stored).toEqual([]);
    expect(buildSavedCharacterOps).not.toHaveBeenCalled();
  });

  it('a hidden bone: kept, and named (a bone has no node of its own natively)', async () => {
    let saved = await savedClone('skinned-bar.glb');
    saved = apply(saved, [{ type: 'setHidden', nodeId: cloneChild(saved, 'Bone0'), hidden: true }]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([
      '"Bone0" was hidden, and it is a bone, which has no node of its own natively',
    ]);
  });

  it('a rotation channel on a child: kept (euler degrees have no place on a quaternion-mode node)', async () => {
    let saved = await savedClone('skinned-bar-child-mesh.glb');
    const armature = cloneChild(saved, 'SkinnedBar');
    saved = apply(saved, [
      {
        type: 'addNode',
        nodeId: 'n_rot',
        nodeType: 'KeyframeChannelVec3',
        params: { name: 'rotation', target: armature, paramPath: 'rotation', keyframes: [] },
      },
    ]);
    const { state, report } = await convertCloneCharacters(
      saved,
      deps('skinned-bar-child-mesh.glb'),
    );
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([expect.stringContaining('"rotation"')]);
  });

  it('an edge of the import itself removed: kept, and named', async () => {
    let saved = await savedClone('skinned-bar.glb');
    const grp = hashId('grp', REF);
    saved = apply(saved, [
      {
        type: 'disconnect',
        from: { node: hashId('gltf', REF), socket: 'out' },
        to: { node: grp, socket: 'children' },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toContainEqual(expect.stringMatching(/lost its "children" input/));
  });

  it('a missing file: kept, and the load says so', async () => {
    const saved = await savedClone('skinned-bar.glb');
    const { state, report } = await convertCloneCharacters(saved, deps(null));
    expect(state).toBe(saved);
    expect(report.kept).toEqual([
      {
        name: 'skinned-bar.glb',
        assetRef: REF,
        why: [`its file (${REF}) is no longer in this browser's storage`],
      },
    ]);
  });

  it('a clone import that is not a character is not touched', async () => {
    const bytes = bytesOf('specgloss-quad.glb');
    const clone = await buildGltfImportOps(
      { ...argsFor('specgloss-quad.glb'), buffer: bytes.buffer.slice(0) as ArrayBuffer },
      buildDefaultDagState(),
    );
    const saved = apply(buildDefaultDagState(), clone.ops);
    const { state, report } = await convertCloneCharacters(saved, deps(null));
    expect(state).toBe(saved);
    expect(report).toEqual({ converted: [], kept: [] });
  });
});

describe('the load door: saved to storage, loaded back, converted', () => {
  it('a project saved with a clone character loads converted, and the notice says so', async () => {
    const storage = new MemoryStorage();
    await storage.write(REF, bytesOf('skinned-bar.glb'));
    const clone = await savedClone('skinned-bar.glb');
    await saveProject(storage, composeProject({ id: 'proj_saved', name: 'Saved', state: clone }));
    const loaded = await loadProject(storage, 'proj_saved');

    const { project, report } = await convertLoadedProject(loaded, storage);
    expect(report).toEqual({
      converted: [{ name: 'skinned-bar.glb', assetRef: REF, notes: [] }],
      kept: [],
    });
    expect(project.id).toBe('proj_saved');
    expect(project.state.nodes).toEqual((await freshNative('skinned-bar.glb')).nodes);

    const notices: string[][] = [];
    reportCharacterConversion(report, (...row) => notices.push(row));
    expect(notices).toEqual([
      [REF, expect.stringContaining('now loads as a native character'), 'character converted:'],
    ]);

    // Saved once converted, it loads as it is: nothing is left to convert.
    await saveProject(storage, project);
    const again = await convertLoadedProject(await loadProject(storage, 'proj_saved'), storage);
    expect(again.report).toEqual({ converted: [], kept: [] });
  });

  it('a project whose file is gone loads as saved, and the notice names the character', async () => {
    const storage = new MemoryStorage();
    await saveProject(
      storage,
      composeProject({ id: 'proj_gone', name: 'Gone', state: await savedClone('skinned-bar.glb') }),
    );
    const loaded = await loadProject(storage, 'proj_gone');
    const { project, report } = await convertLoadedProject(loaded, storage);
    expect(project).toBe(loaded);
    const notices: string[][] = [];
    reportCharacterConversion(report, (...row) => notices.push(row));
    expect(notices).toEqual([
      [
        REF,
        `"skinned-bar.glb" still loads on the old imported-file structure: its file (${REF}) is no longer in this browser's storage.`,
        'character not converted:',
      ],
    ]);
  });
});

describe('converting never stops a project from opening', () => {
  it('a file that throws while being read: kept as saved, with the error named', async () => {
    const saved = await savedClone('skinned-bar.glb');
    const { state, report } = await convertCloneCharacters(saved, deps(new Uint8Array([1, 2, 3])));
    expect(state).toBe(saved);
    expect(report.kept).toEqual([
      {
        name: 'skinned-bar.glb',
        assetRef: REF,
        why: [expect.stringMatching(/^it could not be converted \(/)],
      },
    ]);
  });
});
