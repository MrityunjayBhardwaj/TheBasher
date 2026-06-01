// importCommon rename/delete helpers — unit coverage, Phase 7.14 Wave B (B2).
//
// boot.getStorage is mocked to a fresh MemoryStorage per test. The real
// useDagStore holds the GltfAsset nodes whose assetRef the rename rewrites /
// the delete breaks. Asserts the FAIL-SAFE ordering's observable end state:
// new files present, old gone, assetRef repointed, refresh bumped.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import type { Node } from '../../core/dag/types';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';

let currentStorage: MemoryStorage = new MemoryStorage();
vi.mock('../boot', () => ({
  getStorage: async () => currentStorage,
}));

import {
  deleteImportedAsset,
  listFilesDeep,
  renameImportedAsset,
  USER_IMPORTS_ROOT,
} from './importCommon';

const enc = (s: string) => new TextEncoder().encode(s);

function gltfAsset(id: string, assetRef: string): Node {
  return { id, type: 'GltfAsset', version: 1, params: { assetRef }, inputs: {} };
}

function hydrate(...nodes: Node[]): void {
  const map: Record<string, Node> = {};
  for (const n of nodes) map[n.id] = n;
  useDagStore.getState().hydrate({ nodes: map, outputs: {} });
}

beforeEach(() => {
  registerAllNodes();
  currentStorage = new MemoryStorage();
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  useDagStore.getState().hydrate({ nodes: {}, outputs: {} });
});

describe('listFilesDeep', () => {
  it('collects every file under a dir as paths relative to it (nested preserved)', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/a/scene.gltf`, enc('{}'));
    await currentStorage.write(`${USER_IMPORTS_ROOT}/a/buffers/scene.bin`, enc('bin'));
    await currentStorage.write(`${USER_IMPORTS_ROOT}/a/textures/foo.png`, enc('png'));
    const rels = (await listFilesDeep(currentStorage, `${USER_IMPORTS_ROOT}/a`)).sort();
    expect(rels).toEqual(['buffers/scene.bin', 'scene.gltf', 'textures/foo.png']);
  });
});

describe('renameImportedAsset', () => {
  it('moves the OPFS folder AND rewrites the GltfAsset assetRef (one atomic), old gone', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/old/scene.gltf`, enc('{}'));
    await currentStorage.write(`${USER_IMPORTS_ROOT}/old/textures/foo.png`, enc('png'));
    hydrate(gltfAsset('g', `${USER_IMPORTS_ROOT}/old/scene.gltf`));

    const resolved = await renameImportedAsset('old', 'fresh');
    expect(resolved).toBe('fresh');

    // New tree present, old gone.
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/fresh/scene.gltf`)).toBe(true);
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/fresh/textures/foo.png`)).toBe(true);
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/old/scene.gltf`)).toBe(false);
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/old/textures/foo.png`)).toBe(false);

    // assetRef repointed to the new prefix.
    const ref = (useDagStore.getState().state.nodes['g'].params as { assetRef: string }).assetRef;
    expect(ref).toBe(`${USER_IMPORTS_ROOT}/fresh/scene.gltf`);
    expect(useImportRefreshStore.getState().tick).toBe(1);
  });

  it('suffix-on-collision when the target name is taken (V22)', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/old/x.glb`, enc('a'));
    await currentStorage.write(`${USER_IMPORTS_ROOT}/taken/keep.glb`, enc('b'));
    const resolved = await renameImportedAsset('old', 'taken');
    expect(resolved).toBe('taken-2');
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/taken-2/x.glb`)).toBe(true);
  });

  it('BVH/FBX (no persistent ref) → folder move only, no assetRef rewrite needed', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/walk/walk.bvh`, enc('HIERARCHY'));
    // No GltfAsset references it (motion leaves no ref).
    const resolved = await renameImportedAsset('walk', 'stroll');
    expect(resolved).toBe('stroll');
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/stroll/walk.bvh`)).toBe(true);
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/walk/walk.bvh`)).toBe(false);
  });

  it('no-op when the new name sanitizes to the old name', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/keep/x.glb`, enc('a'));
    const resolved = await renameImportedAsset('keep', 'keep');
    expect(resolved).toBe('keep');
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/keep/x.glb`)).toBe(true);
  });
});

describe('deleteImportedAsset', () => {
  it('unreferenced → deletes the OPFS tree immediately', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/lone/x.glb`, enc('a'));
    const res = await deleteImportedAsset('lone');
    expect(res.deleted).toBe(true);
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/lone/x.glb`)).toBe(false);
    expect(useImportRefreshStore.getState().tick).toBe(1);
  });

  it('referenced + no breakRefs → BLOCKED, OPFS intact, reports referencedBy', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/used/x.glb`, enc('a'));
    hydrate(gltfAsset('g', `${USER_IMPORTS_ROOT}/used/x.glb`));

    const res = await deleteImportedAsset('used');
    expect(res.deleted).toBe(false);
    expect(res.referencedBy).toEqual(['g']);
    // OPFS untouched.
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/used/x.glb`)).toBe(true);
    expect(useImportRefreshStore.getState().tick).toBe(0);
  });

  it('referenced + breakRefs → removes the GltfAsset (disconnecting its consumer) + deletes OPFS', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/used/x.glb`, enc('a'));
    // A Transform consumes the GltfAsset via its `target` input — exercises the
    // disconnect-before-removeNode branch (the op layer rejects removing a
    // still-consumed node).
    hydrate(gltfAsset('g', `${USER_IMPORTS_ROOT}/used/x.glb`), {
      id: 't',
      type: 'Transform',
      version: 1,
      params: {},
      inputs: { target: { node: 'g', socket: 'out' } },
    });

    const res = await deleteImportedAsset('used', { breakRefs: true });
    expect(res.deleted).toBe(true);
    // GltfAsset gone; consumer survives (its input edge was disconnected).
    expect(useDagStore.getState().state.nodes['g']).toBeUndefined();
    expect(useDagStore.getState().state.nodes['t']).toBeDefined();
    expect(await currentStorage.exists(`${USER_IMPORTS_ROOT}/used/x.glb`)).toBe(false);
  });
});
