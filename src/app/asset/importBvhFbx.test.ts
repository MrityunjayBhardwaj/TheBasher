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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useSelectionStore } from '../stores/selectionStore';

let currentStorage: MemoryStorage = new MemoryStorage();
vi.mock('../boot', () => ({
  getStorage: async () => currentStorage,
}));

// Imported AFTER vi.mock so the modules pick up the mocked boot.
import { importBvhFromOpfs, importFbxFromOpfs, routeImportByExtension } from './importBvhFbx';
import { ingestSingleFile, USER_IMPORTS_ROOT } from './importCommon';
import { chooseMotionTarget } from './bindMotionToCharacter';
import { nodeDisplayName } from '../sceneTreeWalk';
import { applyOp } from '../../core/dag';
import { composeProject, loadProject, saveProject } from '../../core/project/io';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';

// The committed ASCII FBX fixture (public/fixtures/anim/rig.fbx — 2-bone
// skeleton, the same file the e2e fetches). Read as bytes so we exercise the
// real binary ArrayBuffer decode path through FBXLoader.
const RIG_FBX_BYTES = new Uint8Array(
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim/rig.fbx')),
);

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

/** A glTF character with a two-bone rig the synthetic BVH's names match — something to bind to. */
function seedCharacter(): void {
  const names = ['Hips', 'Spine'];
  let s = useDagStore.getState().state;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_char',
    nodeType: 'GltfAsset',
    params: {
      assetRef: 'assets/char.glb',
      nodeNameMap: {},
      childHierarchy: {},
      skins: [
        {
          jointKeys: names,
          bindTRS: names.map(() => ({
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          })),
          parentJointIndex: [-1, 0],
          inverseBindMatrices: [],
        },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_char_skel',
    nodeType: 'GltfSkeleton',
    params: { skinIndex: 0 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_char', socket: 'out' },
    to: { node: 'n_char_skel', socket: 'asset' },
  }).next;
  useDagStore.getState().hydrate(s);
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

  // The OLD trigger for this guard — "no TimeSource in the DAG" — is gone (#920):
  // AnimationClip is time-free, so an empty DAG is a valid import target. That
  // retires the TRIGGER, not the GUARD, and these are two rows for that reason.
  it('imports into an EMPTY DAG — the TimeSource precondition is retired', async () => {
    useDagStore.getState().hydrate({ nodes: {}, outputs: {} });
    const path = `${USER_IMPORTS_ROOT}/notime/x.bvh`;
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const result = await importBvhFromOpfs(path);

    expect(result).not.toBeNull();
    expect(dispatchSpy).toHaveBeenCalled();
    expect(useAssetErrorStore.getState().errors[path]).toBeUndefined();
  });

  // 🔴 THE GUARD ITSELF, kept with a trigger that still exists. This was the only
  // row exercising this function's catch, so retiring it with its precondition
  // would have left a swallowed-failure path with nothing watching it — a
  // silent no-op is exactly what it was written to forbid.
  it('reports to the banner and skips dispatch when the file will not parse', async () => {
    const path = `${USER_IMPORTS_ROOT}/broken/x.bvh`;
    await currentStorage.write(path, new TextEncoder().encode('this is not a BVH file'));

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const result = await importBvhFromOpfs(path);

    expect(result).toBeNull();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useAssetErrorStore.getState().errors[path]).toBeDefined();
  });
});

describe('#1056 — every imported motion stands in the scene as an Object', () => {
  const path = `${USER_IMPORTS_ROOT}/wave/wave.bvh`;

  it('the SAME dispatch adds an Object pointed at the skeleton', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const result = await importBvhFromOpfs(path);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const ops = dispatchSpy.mock.calls[0][0];
    const objectId = `${result!.skeletonId}_object`;
    expect(ops).toContainEqual(
      expect.objectContaining({ type: 'addNode', nodeId: objectId, nodeType: 'Object' }),
    );
    expect(ops).toContainEqual({
      type: 'connect',
      from: { node: result!.skeletonId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    });
    expect(ops).toContainEqual({
      type: 'connect',
      from: { node: objectId, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    });
    // And it landed: the Object is in the graph, a child of the scene.
    const state = useDagStore.getState().state;
    expect(state.nodes[objectId]?.type).toBe('Object');
    expect(state.nodes.n_scene.inputs.children).toEqual([{ node: objectId, socket: 'out' }]);
  });

  // #1103 — the toast a director reads, through the road a drop, the picker and the
  // Library all take. The chooser's rows pin the wording; these pin that the bind
  // actually shows it at the level the chooser picked.
  it('#1103 — with no character, the toast names that Object, as a notice', async () => {
    useNotificationStore.setState({ toasts: [] });
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    await routeImportByExtension(path);

    const objectId = Object.values(useDagStore.getState().state.nodes).find(
      (n) => n.type === 'Object',
    )?.id;
    expect(objectId, 'the import stood no Object — the toast check would be vacuous').toBeDefined();
    const toasts = useNotificationStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('info');
    // #1101 — by the name of the file the director dropped, never by the internal id.
    expect(toasts[0].message).toContain('stands in the scene as wave until');
    expect(toasts[0].message).not.toContain(objectId!);
  });

  it('#1101 — the Object is named after the file, the same name its clip carries', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    const state = useDagStore.getState().state;
    const objectId = `${result!.skeletonId}_object`;
    expect(state.nodes[objectId]?.meta?.name).toBe('wave');
    expect((state.nodes[result!.clipId].params as { name?: string }).name).toBe('wave');
    expect(nodeDisplayName(state.nodes, objectId)).toBe('wave');
  });

  it('#1101 — renaming the Object in the outliner is the name the next notice uses', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    const objectId = `${result!.skeletonId}_object`;
    // The outliner's rename is this op (`RenameInput.tsx`).
    useDagStore
      .getState()
      .dispatch({ type: 'setMeta', nodeId: objectId, name: 'hero walk' }, 'user', 'rename');
    const choice = chooseMotionTarget(
      useDagStore.getState().state,
      null,
      'imported',
      result!.skeletonId,
    );
    expect(choice.ok).toBe(false);
    expect(choice.ok ? '' : choice.reason).toContain('stands in the scene as hero walk until');
  });

  it('#1101 — one undo takes the Object and its name away with the rest of the import', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    const objectId = `${result!.skeletonId}_object`;
    expect(useDagStore.getState().state.nodes[objectId]?.meta?.name).toBe('wave');
    useDagStore.getState().undo();
    const state = useDagStore.getState().state;
    expect(state.nodes[objectId]).toBeUndefined();
    expect(state.nodes[result!.skeletonId]).toBeUndefined();
  });

  // #1122 — the Object reads as its motion until a director names it otherwise. Through the
  // real store, so the undo is the one Cmd+Z runs, and through the ops the two gestures send:
  // the inspector's name field is a `setParam` on the clip, the outliner's rename a `setMeta`.
  it('#1122 — renaming the clip renames the Object that stands it', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    const objectId = `${result!.skeletonId}_object`;
    const store = useDagStore.getState();
    store.dispatch(
      { type: 'setParam', nodeId: result!.clipId, paramPath: 'name', value: 'hero walk' },
      'user',
      'set name',
    );
    const state = useDagStore.getState().state;
    expect(nodeDisplayName(state.nodes, result!.clipId)).toBe('hero walk');
    expect(nodeDisplayName(state.nodes, objectId)).toBe('hero walk');
    // The field every direct reader uses, not only the resolver.
    expect(state.nodes[objectId].meta).toEqual({ name: 'hero walk', nameFrom: result!.clipId });
  });

  it('#1122 — once the Object is renamed, the clip’s next rename leaves it alone; undo resumes', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    const objectId = `${result!.skeletonId}_object`;
    const store = useDagStore.getState();
    store.dispatch({ type: 'setMeta', nodeId: objectId, name: 'my rig' }, 'user', 'rename');
    store.dispatch(
      { type: 'setParam', nodeId: result!.clipId, paramPath: 'name', value: 'hero walk' },
      'user',
      'set name',
    );
    expect(nodeDisplayName(useDagStore.getState().state.nodes, objectId)).toBe('my rig');

    store.undo(); // the clip's rename
    store.undo(); // the Object's rename — following resumes
    let nodes = useDagStore.getState().state.nodes;
    expect(nodes[objectId].meta).toEqual({ name: 'wave', nameFrom: result!.clipId });
    store.dispatch(
      { type: 'setParam', nodeId: result!.clipId, paramPath: 'name', value: 'jog' },
      'user',
      'set name',
    );
    nodes = useDagStore.getState().state.nodes;
    expect(nodeDisplayName(nodes, objectId)).toBe('jog');
  });

  it('#1122 — the link survives a save and a load, and still follows afterwards', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    const objectId = `${result!.skeletonId}_object`;
    const storage = new MemoryStorage();
    await saveProject(
      storage,
      composeProject({ id: 'p1122', name: 'p1122', state: useDagStore.getState().state }),
    );
    const loaded = await loadProject(storage, 'p1122');
    expect(loaded.state.nodes[objectId].meta).toEqual({ name: 'wave', nameFrom: result!.clipId });
    useDagStore.getState().hydrate(loaded.state);
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: result!.clipId, paramPath: 'name', value: 'hero walk' },
        'user',
        'set name',
      );
    expect(useDagStore.getState().state.nodes[objectId].meta?.name).toBe('hero walk');
  });

  it('#1103 — with no scene to stand it in, the warning stays', async () => {
    useDagStore.getState().hydrate({ nodes: {}, outputs: {} });
    useNotificationStore.setState({ toasts: [] });
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    await routeImportByExtension(path);

    const toasts = useNotificationStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('warn');
    expect(toasts[0].message).toContain('no character in the scene');
  });

  it('a project with a character to bind to gets the Object too — the import does not read the scene', async () => {
    // The row the old "only when nothing binds" rule fails. A character is seeded and the
    // bind's own choice is asserted to pick it FIRST, so this is not an Object added to a
    // scene that had nothing to bind to.
    seedCharacter();
    expect(
      chooseMotionTarget(useDagStore.getState().state, null, 'imported', 'skel_not_in_graph').ok,
    ).toBe(true);

    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const result = await importBvhFromOpfs(path);
    expect(dispatchSpy.mock.calls[0][0]).toContainEqual(
      expect.objectContaining({ nodeId: `${result!.skeletonId}_object`, nodeType: 'Object' }),
    );
  });

  it('a project with no scene aggregator gets the import alone', async () => {
    useDagStore.getState().hydrate({ nodes: {}, outputs: {} });
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await importBvhFromOpfs(path);
    const types = dispatchSpy.mock.calls[0][0]
      .filter((o) => o.type === 'addNode')
      .map((o) => o.nodeType);
    expect(types).not.toContain('Object');
  });

  it('an FBX gets the same Object', async () => {
    const fbxPath = `${USER_IMPORTS_ROOT}/rig/rig.fbx`;
    await currentStorage.write(fbxPath, RIG_FBX_BYTES);
    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const result = await importFbxFromOpfs(fbxPath);
    const ops = dispatchSpy.mock.calls[0][0];
    expect(ops).toContainEqual(
      expect.objectContaining({ nodeId: `${result!.skeletonId}_object`, nodeType: 'Object' }),
    );
    // #1101 — named after the file, as the BVH road's is.
    expect(useDagStore.getState().state.nodes[`${result!.skeletonId}_object`]?.meta?.name).toBe(
      'rig',
    );
  });
});

// #791 — BVH declares no unit, so the rig stands at file scale and the director sets it. The
// reference offers a scale defaulted to 1.0 and never guesses (Blender's `io_anim_bvh`), then
// selects what it imported. The synthetic clip stands ~1 unit tall, so the old fit would have
// scaled it by ~1.8: a scale of exactly 1 separates "no guess" from "guessed".
describe('#791 — a dropped BVH stands at file scale, and its Object is selected', () => {
  const path = `${USER_IMPORTS_ROOT}/wave/wave.bvh`;
  const objectScale = (skeletonId: string): number[] | undefined =>
    (useDagStore.getState().state.nodes[`${skeletonId}_object`]?.params as { scale?: number[] })
      ?.scale;

  beforeEach(() => {
    // The bind runs through `mutator.animation.retarget`; without the catalogue it is refused,
    // and a refused bind is the no-character case — the row about a bind that TAKES would
    // then pass or fail for the wrong reason.
    __resetMutatorRegistryForTests();
    registerAllMutators();
    useSelectionStore.getState().select(null);
  });

  it("the Object that stands a BVH is at scale 1 — the file's own size", async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    const result = await importBvhFromOpfs(path);
    expect(objectScale(result!.skeletonId)).toEqual([1, 1, 1]);
  });

  it('an FBX still gets the fit — its declared unit is not read yet, so 1 would be a guess too', async () => {
    const fbxPath = `${USER_IMPORTS_ROOT}/rig/rig.fbx`;
    await currentStorage.write(fbxPath, RIG_FBX_BYTES);
    const result = await importFbxFromOpfs(fbxPath);
    expect(objectScale(result!.skeletonId)?.[0]).not.toBe(1);
  });

  it('with nothing to bind to, the drop selects the Object, so its Scale is in the inspector', async () => {
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    await routeImportByExtension(path);
    const objects = Object.values(useDagStore.getState().state.nodes).filter(
      (n) => n.type === 'Object',
    );
    expect(objects).toHaveLength(1);
    expect(useSelectionStore.getState().selectedNodeId).toBe(objects[0].id);
  });

  it('when a character takes the motion, the selection is left where the bind found it', async () => {
    seedCharacter();
    useSelectionStore.getState().select('n_char');
    await currentStorage.write(path, new TextEncoder().encode(SYNTHETIC_BVH));
    await routeImportByExtension(path);
    // The bind took it — the character's clip exists — so the stand-in was hidden, not selected.
    expect(
      Object.values(useDagStore.getState().state.nodes).some((n) => n.type === 'RetargetClip'),
    ).toBe(true);
    expect(useSelectionStore.getState().selectedNodeId).toBe('n_char');
  });

  it('an import that fails selects nothing — there is no Object to show', async () => {
    await currentStorage.write(path, new TextEncoder().encode('not a bvh'));
    await routeImportByExtension(path);
    expect(useSelectionStore.getState().selectedNodeId).toBeNull();
  });
});

describe('importFbxFromOpfs', () => {
  it('decodes the committed ASCII FBX (binary path) into Skeleton + AnimationClip', async () => {
    const path = `${USER_IMPORTS_ROOT}/rig/rig.fbx`;
    await currentStorage.write(path, RIG_FBX_BYTES);

    const dispatchSpy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    await importFbxFromOpfs(path);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const types = dispatchSpy.mock.calls[0][0]
      .filter((o) => o.type === 'addNode')
      .map((o) => o.nodeType);
    expect(types).toContain('Skeleton');
    expect(types).toContain('AnimationClip');
    expect(types).not.toContain('Mesh');
    expect(useImportRefreshStore.getState().tick).toBe(1);
    expect(useAssetErrorStore.getState().errors[path]).toBeUndefined();
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
