// BVH/FBX OPFS import chokepoints + dispatcher — unit coverage, Phase 7.14 A2.
//
// Mirrors importGltf.test.ts: boot.getStorage is mocked to a fresh
// MemoryStorage per test; the real useDagStore is seeded with a TimeSource
// (BVH/FBX clips wire to it). We assert the SURFACE behavior — bytes on OPFS →
// Skeleton + AnimationClip ops dispatched + refresh bumped — not the parser
// internals (those are covered by bvhImportChain.test.ts / fbx.test.ts).
//
// FBX is exercised end-to-end (real ASCII fixture → FBXLoader) by the
// p7.14 e2e; here we cover the dispatcher routing + the BVH text path + the
// silent-failure guard (no TimeSource → banner, no dispatch).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';

let currentStorage: MemoryStorage = new MemoryStorage();
vi.mock('../boot', () => ({
  getStorage: async () => currentStorage,
}));

// Imported AFTER vi.mock so the modules pick up the mocked boot.
import { importBvhFromOpfs, routeImportByExtension } from './importBvhFbx';
import { ingestSingleFile, USER_IMPORTS_ROOT } from './importCommon';

const SYNTHETIC_BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site
    {
      OFFSET 0.0 0.5 0.0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0.0 1.0 0.0 0.0 0.0 0.0 0.0 45.0 0.0
0.0 1.0 0.0 0.0 0.0 0.0 0.0 -45.0 0.0
`;

function seedTime(): void {
  // BVH/FBX clips connect to a TimeSource; default projects seed `n_time`.
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
  seedTime();
});

describe('importBvhFromOpfs', () => {
  it('dispatches Skeleton + AnimationClip addNode ops (no mesh) and bumps once', async () => {
    const path = `${USER_IMPORTS_ROOT}/wave/wave.bvh`;
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await importBvhFromOpfs(path);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const ops = dispatchSpy.mock.calls[0][0];
    const types = ops.filter((o) => o.type === 'addNode').map((o) => o.nodeType);
    expect(types).toContain('Skeleton');
    expect(types).toContain('AnimationClip');
    // Motion, not model — never a Mesh/GltfAsset.
    expect(types).not.toContain('Mesh');
    expect(types).not.toContain('GltfAsset');
    expect(useImportRefreshStore.getState().tick).toBe(1);
    expect(useAssetErrorStore.getState().errors[path]).toBeUndefined();
  });

  it('reports to the banner and skips dispatch when no TimeSource exists', async () => {
    useDagStore.getState().hydrate({ nodes: {}, outputs: {} });
    const path = `${USER_IMPORTS_ROOT}/notime/x.bvh`;
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await importBvhFromOpfs(path);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useImportRefreshStore.getState().tick).toBe(0);
    expect(useAssetErrorStore.getState().errors[path]).toMatch(/TimeSource/);
  });
});

describe('routeImportByExtension', () => {
  it('routes a .bvh entry to the BVH importer', async () => {
    const path = `${USER_IMPORTS_ROOT}/clip/clip.bvh`;
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await routeImportByExtension(path);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const types = dispatchSpy.mock.calls[0][0]
      .filter((o) => o.type === 'addNode')
      .map((o) => o.nodeType);
    expect(types).toEqual(expect.arrayContaining(['Skeleton', 'AnimationClip']));
  });

  it('reports (never silently no-ops) on an unsupported extension', async () => {
    const path = `${USER_IMPORTS_ROOT}/junk/readme.txt`;
    await currentStorage.write(path, new TextEncoder().encode('not a model'));

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await routeImportByExtension(path);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useAssetErrorStore.getState().errors[path]).toMatch(/unsupported format/);
  });
});

describe('ingestSingleFile', () => {
  it('writes a single file under user-imports/<name>/<basename> and returns its path', async () => {
    const out = await ingestSingleFile(
      { relativePath: 'anim/walk.bvh', bytes: new TextEncoder().encode(SYNTHETIC_BVH) },
      'walk',
    );
    expect(out).toBe(`${USER_IMPORTS_ROOT}/walk/walk.bvh`);
    expect(await currentStorage.exists(out)).toBe(true);
  });

  it('applies suffix-on-collision (V22) when the name is taken', async () => {
    await currentStorage.write(`${USER_IMPORTS_ROOT}/walk/keep.bvh`, new Uint8Array([1]));
    const out = await ingestSingleFile(
      { relativePath: 'walk.bvh', bytes: new Uint8Array([2]) },
      'walk',
    );
    expect(out).toBe(`${USER_IMPORTS_ROOT}/walk-2/walk.bvh`);
  });
});
