// #1317 — a saved clone-road import with no skin (a plain model) loads as exactly the nodes a fresh
// native import writes, the same way a saved character does (#1216): the director's edits carried
// across, or the model kept as saved and each reason named. Nothing is converted with a loss.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../../core/dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp } from '../../core/dag/ops';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { buildGltfImportOps, hashId } from '../../core/import/gltfImportChain';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import {
  convertCloneCharacters,
  convertLoadedProject,
  reportCharacterConversion,
  type ConvertCloneCharactersDeps,
} from './convertCloneCharacters';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { composeProject, loadProject, saveProject } from '../../core/project/io';

const refOf = (fixture: string) => `user-imports/${fixture.split('.')[0]}/${fixture}`;
const bytesOf = (fixture: string) => new Uint8Array(readFileSync(`public/assets/${fixture}`));

function argsFor(fixture: string) {
  const bytes = bytesOf(fixture);
  return {
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: refOf(fixture),
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  };
}

function deps(fixture: string, stored: string[] = []): ConvertCloneCharactersDeps {
  return {
    read: async (path) => {
      if (path !== refOf(fixture)) throw new Error(`no file at ${path}`);
      return bytesOf(fixture);
    },
    storeImage: async (_bytes, mime) => {
      stored.push(mime);
      return 'img';
    },
  };
}

function apply(state: DagState, ops: readonly Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/** A project holding the file on the clone road, as a save from before #1053 does. */
async function savedClone(fixture: string): Promise<DagState> {
  const clone = await buildGltfImportOps(argsFor(fixture), buildDefaultDagState());
  return apply(buildDefaultDagState(), clone.ops);
}

/** The same project with the file imported fresh on the native road. */
async function freshNative(fixture: string): Promise<DagState> {
  const native = await buildNativeGltfImportOps(argsFor(fixture));
  if ('refused' in native) throw new Error(native.refused);
  return apply(buildDefaultDagState(), native.ops);
}

const cloneTypes = (state: DagState): string[] =>
  Object.values(state.nodes)
    .map((n) => n.type)
    .filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t));

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('an untouched saved model', () => {
  it.each([
    'cube.gltf',
    'two-material-quad.gltf',
    'vertex-color-quad.gltf',
    'albedo-textured-quad.gltf',
    'anim-nested.gltf',
  ])('%s converts to exactly the nodes a fresh native import writes', async (fixture) => {
    const saved = await savedClone(fixture);
    expect(cloneTypes(saved).length).toBeGreaterThan(0);
    const { state, report } = await convertCloneCharacters(saved, deps(fixture));
    expect(report.kept).toEqual([]);
    expect(report.converted).toEqual([
      { kind: 'model', name: fixture, assetRef: refOf(fixture), notes: [] },
    ]);
    expect(cloneTypes(state)).toEqual([]);
    expect(state.nodes).toEqual((await freshNative(fixture)).nodes);
  });
});

describe('a saved model the native reader refuses', () => {
  it('is kept exactly as saved, with the refusal and its issue named, and writes nothing', async () => {
    const saved = await savedClone('iridescence-quad.gltf');
    const stored: string[] = [];
    const { state, report } = await convertCloneCharacters(
      saved,
      deps('iridescence-quad.gltf', stored),
    );
    expect(state).toBe(saved);
    expect(report.converted).toEqual([]);
    expect(report.kept).toEqual([
      {
        kind: 'model',
        name: 'iridescence-quad.gltf',
        assetRef: refOf('iridescence-quad.gltf'),
        why: [
          expect.stringMatching(
            /^the native reader refuses it: .*KHR_materials_iridescence.*#1123/,
          ),
        ],
      },
    ]);
    expect(stored).toEqual([]);
  });
});

describe('a saved model with edits', () => {
  it('carries a moved, renamed, hidden import onto the native Group', async () => {
    const fixture = 'cube.gltf';
    const grp = hashId('grp', refOf(fixture));
    const saved = apply(await savedClone(fixture), [
      { type: 'setParam', nodeId: grp, paramPath: 'position', value: [3, 0, -2] },
      { type: 'setMeta', nodeId: grp, name: 'Crate' },
      { type: 'setHidden', nodeId: grp, hidden: true },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps(fixture));
    expect(report.converted).toEqual([
      { kind: 'model', name: 'Crate', assetRef: refOf(fixture), notes: [] },
    ]);
    const nativeGrp = hashId('nativeGrp', refOf(fixture));
    expect((state.nodes[nativeGrp].params as { position: number[] }).position).toEqual([3, 0, -2]);
    expect(state.nodes[nativeGrp].meta).toEqual({ name: 'Crate', hidden: true });
    expect(cloneTypes(state)).toEqual([]);
  });
});

describe('the load door', () => {
  it('a project saved with a clone model loads converted, and the notice says so', async () => {
    const fixture = 'cube.gltf';
    const storage = new MemoryStorage();
    await storage.write(refOf(fixture), bytesOf(fixture));
    await saveProject(
      storage,
      composeProject({ id: 'proj_model', name: 'Model', state: await savedClone(fixture) }),
    );
    const { project, report } = await convertLoadedProject(
      await loadProject(storage, 'proj_model'),
      storage,
    );
    expect(project.state.nodes).toEqual((await freshNative(fixture)).nodes);

    const notices: string[][] = [];
    reportCharacterConversion(report, (...row) => notices.push(row));
    expect(notices).toEqual([
      [
        `model:${refOf(fixture)}`,
        expect.stringContaining('now loads as native geometry'),
        'model converted:',
      ],
    ]);
  });
});
