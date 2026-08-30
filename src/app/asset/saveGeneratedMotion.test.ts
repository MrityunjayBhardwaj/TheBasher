// Saving a generated clip into the asset library (#819).
//
// The claim under test is a NEGATIVE one as much as a positive: the bytes reach
// storage and a row appears, AND the graph does not change. Saving is a storage
// act on a clip that is already in the scene, so a save that took the import
// road would parse the same motion again, add a second Skeleton + AnimationClip,
// and attempt a second bind the character correctly refuses — a button that
// silently duplicates the user's work while reporting success.
//
// Shaped after generateMotion.test.ts, which is shaped after importBvhFbx.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useGeneratedMotionStore } from '../stores/generatedMotionStore';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { DEFAULT_MOTIONGEN_MODEL, synthesiseBvh } from '../../core/motiongen';

// A fresh store per test: `resolveFreeImportName` suffixes on collision, so a
// leaked file from a previous case would silently change the path under test.
let storage = new MemoryStorage();
vi.mock('../boot', () => ({
  getStorage: async () => storage,
}));

// Imported AFTER vi.mock so the module picks up the mocked boot.
import { saveGeneratedMotionToLibrary, savedMotionName } from './saveGeneratedMotion';

// A clip the REAL parser accepts, not a hand-typed stub of one. Measured
// while falsifying: with an unparseable fixture, a save that wrongly took the
// import road still left the graph untouched — the import failed on its own and
// the "does not touch the graph" assertion passed for the wrong reason. The
// gate only discriminates if the bytes could actually have been imported.
const BVH = synthesiseBvh({ prompt: 'a figure walks forward', model: DEFAULT_MOTIONGEN_MODEL });

function seedTime(): void {
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
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  useGeneratedMotionStore.getState().clear();
  seedTime();
  storage = new MemoryStorage();
});

describe('savedMotionName', () => {
  it('keeps a short prompt as it is', () => {
    expect(savedMotionName('a figure walks forward')).toBe('a figure walks forward');
  });

  it('cuts a long prompt rather than hashing it, so it stays findable', () => {
    const long = 'a figure walks forward and then turns left and waves at the camera slowly';
    const out = savedMotionName(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(long.startsWith(out)).toBe(true);
  });

  it('never yields an empty name', () => {
    expect(savedMotionName('   ')).toBe('generated-motion');
  });
});

describe('saving a generated clip', () => {
  it('writes the BVH under user-imports and bumps the library', async () => {
    useGeneratedMotionStore
      .getState()
      .record({ clipId: 'n_clip', name: 'a figure walks forward', bvh: BVH, model: 'm' });

    const result = await saveGeneratedMotionToLibrary();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The FOLDER is sanitised and the FILE keeps the human name — the same
    // convention a dropped `my walk.bvh` lands under, deliberately, because a
    // generated clip that looked different in storage would be a second kind of
    // asset in the one place a director browses.
    expect(result.path).toBe('user-imports/a_figure_walks_forward/a figure walks forward.bvh');
    const written = new TextDecoder().decode(await storage.read(result.path));
    // Byte-for-byte: what is saved is what the generator produced, not a
    // re-serialisation of the parsed clip.
    expect(written).toBe(BVH);
    expect(useImportRefreshStore.getState().tick).toBe(1);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('does NOT touch the graph — the clip it saves is already in the scene', async () => {
    useGeneratedMotionStore
      .getState()
      .record({ clipId: 'n_clip', name: 'walk', bvh: BVH, model: 'm' });
    const before = JSON.stringify(useDagStore.getState().state);

    await saveGeneratedMotionToLibrary();

    // The load-bearing assertion. A save that reached `routeImportByExtension`
    // would add a Skeleton and an AnimationClip here and report success.
    expect(JSON.stringify(useDagStore.getState().state)).toBe(before);
  });

  it('retires the offer and remembers where it landed', async () => {
    useGeneratedMotionStore
      .getState()
      .record({ clipId: 'n_clip', name: 'walk', bvh: BVH, model: 'm' });

    await saveGeneratedMotionToLibrary();

    const { pending, savedPath } = useGeneratedMotionStore.getState();
    // Offering the same clip twice would write a second copy under `walk-2`,
    // which reads as two clips a director never made.
    expect(pending).toBeNull();
    expect(savedPath).toBe('user-imports/walk/walk.bvh');
  });

  it('refuses quietly when there is nothing on offer', async () => {
    const result = await saveGeneratedMotionToLibrary();
    expect(result).toEqual({ ok: false, reason: 'nothing to save' });
    // No banner: nothing failed. The affordance is not offered in this state,
    // so a message here would be about a button the director cannot see.
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('reports a storage failure in the SAVE road’s own words', async () => {
    useGeneratedMotionStore
      .getState()
      .record({ clipId: 'n_clip', name: 'walk', bvh: BVH, model: 'm' });
    const write = vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await saveGeneratedMotionToLibrary();
    expect(result.ok).toBe(false);

    const messages = Object.values(useAssetErrorStore.getState().errors).join(' ');
    // A director who pressed "Save to library" must not be told an IMPORT
    // failed — the shared write is right, inheriting its vocabulary is not.
    expect(messages).toContain('save failed:');
    expect(messages).not.toContain('import failed:');
    // The offer survives a failure, so the clip can be saved again once there
    // is room. Retiring it would strand bytes that exist nowhere else.
    expect(useGeneratedMotionStore.getState().pending).not.toBeNull();
    write.mockRestore();
  });
});
