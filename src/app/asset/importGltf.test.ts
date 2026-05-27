// Shared glTF import core — unit coverage for Phase 7.9 Wave A.
//
// Covers Task 2 (importGltfFromOpfs + ingestGltfFolder) and Task 3
// (suffix-on-collision policy). Storage is the in-memory MemoryStorage
// (boot.getStorage is mocked to return a fresh instance per test).
// Dispatcher is the real useDagStore; ops are real Ops produced by
// buildGltfImportOps from a synthetic GLB (mirror of the gltfImportChain
// test pattern). NO src/viewport imports — V8.
//
// REF: phase 7.9 PLAN Task 2/3; CONTEXT pre-mortem #3 (refresh-bump
// post-dispatch only); RESEARCH §4 + §6.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';

// Boot module is mocked so getStorage() returns a fresh MemoryStorage
// per test, and the cached singleton in boot.ts doesn't bleed across
// the suite. The mock factory creates a single instance up front; we
// reassign `currentStorage` between tests to swap it.
let currentStorage: MemoryStorage = new MemoryStorage();
vi.mock('../boot', () => ({
  getStorage: async () => currentStorage,
}));

// Imported AFTER vi.mock so the module gets the mocked boot.
import {
  importGltfFromOpfs,
  ingestGltfFolder,
  USER_IMPORTS_ROOT,
  type IngestFile,
} from './importGltf';

// ---------------------------------------------------------------------------
// Synthetic-GLB fixture builder (mirror of gltfImportChain.test.ts:30-50).
// ---------------------------------------------------------------------------

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function pad4(bytes: Uint8Array, padByte = 0): Uint8Array {
  if (bytes.length % 4 === 0) return bytes;
  const out = new Uint8Array(bytes.length + (4 - (bytes.length % 4)));
  out.set(bytes);
  if (padByte !== 0) out.fill(padByte, bytes.length);
  return out;
}

function makeGlb(json: object, binBytes?: Uint8Array): Uint8Array {
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const bin = binBytes ? pad4(binBytes) : null;
  const totalLength = 12 + 8 + jsonBytes.length + (bin ? 8 + bin.length : 0);
  const buf = new ArrayBuffer(totalLength);
  const v = new DataView(buf);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, totalLength, true);
  let cursor = 12;
  v.setUint32(cursor, jsonBytes.length, true);
  v.setUint32(cursor + 4, CHUNK_JSON, true);
  new Uint8Array(buf, cursor + 8, jsonBytes.length).set(jsonBytes);
  cursor += 8 + jsonBytes.length;
  if (bin) {
    v.setUint32(cursor, bin.length, true);
    v.setUint32(cursor + 4, CHUNK_BIN, true);
    new Uint8Array(buf, cursor + 8, bin.length).set(bin);
  }
  return new Uint8Array(buf);
}

/** A minimal static GLB (one node, no animations). */
function staticGlb(): Uint8Array {
  return makeGlb({ asset: { version: '2.0' }, nodes: [{ name: 'Cube' }] });
}

// ---------------------------------------------------------------------------
// Per-test reset — fresh storage, store, error banner, refresh counter.
// ---------------------------------------------------------------------------

function seedScene(): void {
  // Hydrate the DAG store with a single Scene node bound as outputs.scene
  // so importGltfFromOpfs's "no scene output" guard passes.
  useDagStore.getState().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
}

beforeEach(() => {
  registerAllNodes();
  currentStorage = new MemoryStorage();
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  seedScene();
});

// ---------------------------------------------------------------------------
// Task 2 — importGltfFromOpfs
// ---------------------------------------------------------------------------

describe('importGltfFromOpfs', () => {
  it('dispatches a GltfAsset addNode and bumps the refresh signal once', async () => {
    const path = 'user-imports/cube/cube.glb';
    await currentStorage.write(path, staticGlb());

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    expect(useImportRefreshStore.getState().tick).toBe(0);

    await importGltfFromOpfs(path);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const opsArg = dispatchSpy.mock.calls[0][0];
    const gltfAssetAdd = opsArg.find((o) => o.type === 'addNode' && o.nodeType === 'GltfAsset');
    expect(gltfAssetAdd).toBeDefined();
    expect(useImportRefreshStore.getState().tick).toBe(1);
    expect(useAssetErrorStore.getState().errors[path]).toBeUndefined();
  });

  it('reports + skips dispatch when project has no scene output', async () => {
    useDagStore.getState().hydrate({ nodes: {}, outputs: {} });
    const path = 'user-imports/nope/cube.glb';
    await currentStorage.write(path, staticGlb());

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await importGltfFromOpfs(path);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useImportRefreshStore.getState().tick).toBe(0);
    expect(useAssetErrorStore.getState().errors[path]).toMatch(/no scene output/);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — ingestGltfFolder
// ---------------------------------------------------------------------------

describe('ingestGltfFolder', () => {
  it('reports + throws when no .gltf/.glb is in the file set', async () => {
    const files: IngestFile[] = [{ relativePath: 'readme.txt', bytes: new Uint8Array([1, 2, 3]) }];
    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');

    await expect(ingestGltfFolder(files, 'foo')).rejects.toThrow(/no glTF/);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useImportRefreshStore.getState().tick).toBe(0);
    expect(useAssetErrorStore.getState().errors['foo']).toMatch(/no glTF/);
  });

  it('preserves full nesting: nested-entry .gltf + siblings land under user-imports/<name>/', async () => {
    const files: IngestFile[] = [
      {
        relativePath: 'gltf/scene.gltf',
        bytes: new TextEncoder().encode(
          JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'Cube' }] }),
        ),
      },
      { relativePath: 'textures/foo.png', bytes: new Uint8Array([137, 80, 78, 71]) },
      { relativePath: 'buffers/scene.bin', bytes: new Uint8Array([0, 1, 2, 3]) },
    ];

    const entryPath = await ingestGltfFolder(files, 'myasset');

    expect(entryPath).toBe(`${USER_IMPORTS_ROOT}/myasset/gltf/scene.gltf`);
    // Each file readable at the preserved relative path.
    expect(await currentStorage.read(`${USER_IMPORTS_ROOT}/myasset/gltf/scene.gltf`)).toBeDefined();
    expect(
      await currentStorage.read(`${USER_IMPORTS_ROOT}/myasset/textures/foo.png`),
    ).toBeDefined();
    expect(
      await currentStorage.read(`${USER_IMPORTS_ROOT}/myasset/buffers/scene.bin`),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 3 — suffix-on-collision policy
// ---------------------------------------------------------------------------

describe('ingestGltfFolder — collision policy', () => {
  it('returns <name>-2 when <name> already exists under user-imports/', async () => {
    // Seed the collision: a pre-existing user-imports/foo/ subdir.
    await currentStorage.write(`${USER_IMPORTS_ROOT}/foo/marker.txt`, new Uint8Array([1]));

    const files: IngestFile[] = [{ relativePath: 'foo.glb', bytes: staticGlb() }];
    const entryPath = await ingestGltfFolder(files, 'foo');

    expect(entryPath).toBe(`${USER_IMPORTS_ROOT}/foo-2/foo.glb`);
    // Existing dir untouched.
    expect(await currentStorage.read(`${USER_IMPORTS_ROOT}/foo/marker.txt`)).toBeDefined();
  });

  it('list throws on missing user-imports root → first ingest is <name> (no suffix)', async () => {
    // currentStorage is fresh, so user-imports/ does not exist yet —
    // resolveFreeImportName's try/catch must yield [] (not throw).
    const files: IngestFile[] = [{ relativePath: 'first.glb', bytes: staticGlb() }];
    const entryPath = await ingestGltfFolder(files, 'first');
    expect(entryPath).toBe(`${USER_IMPORTS_ROOT}/first/first.glb`);
  });
});
