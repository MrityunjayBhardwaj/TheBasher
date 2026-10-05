// Tests for agent tool registry and the four first-party tools.
//
// Each tool is tested with a twice-call pattern (THESIS.md §48): same args →
// same Op[] output, proving tool handlers are pure functions of (args, ctx).
//
// REF: vyapti V7 (tool handlers return Op[]), THESIS.md §20.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  listNodeTypes,
  type DagState,
} from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { SCENE_OBJECT_KINDS } from '../../app/addPrimitives';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { makeSplitCube } from '../../test-utils/splitCube';
import { MemoryStorage } from '../../core/storage/MemoryStorage';

// library.import's glTF branch reads OPFS bytes via boot.getStorage() (the
// same chokepoint the UI file-drop uses). Mock boot so getStorage() returns
// a fresh per-test MemoryStorage we stage fixture bytes into. Mirrors the
// importGltf.test.ts pattern. Other tools take ctx.storage, not boot, so this
// only affects the library.import glTF path.
let currentStorage: MemoryStorage = new MemoryStorage();
vi.mock('../../app/boot', () => ({
  getStorage: async () => currentStorage,
}));

import { readFileSync } from 'node:fs';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';
import {
  registerAllTools,
  getTool,
  listTools,
  __resetToolRegistryForTests,
  characterWalkToTool,
  cameraSnapshotTool,
  libraryImportTool,
  meshAddTool,
  dagInspectTool,
  dagExecTool,
} from './index';
import type { ToolContext } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetToolRegistryForTests();
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('tool registry', () => {
  it('registers exactly the first-party catalogue — no more, no fewer', () => {
    // The list IS the assertion; the count is derived from it rather than
    // spelled, because a spelled count says nothing the list does not and goes
    // stale on its own schedule. (It did: this test was named "all fifteen" and
    // reported failure on correct code the day a sixteenth tool was registered.)
    registerAllTools();
    const tools = listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'agent.getMutator',
      'agent.getStrategy',
      'agent.identify',
      'agent.listMutators',
      'agent.listStrategies',
      'agent.proposePlan',
      'agent.render.dryRunWorkflow',
      'agent.render.summarizePass',
      'agent.render.summarizeStylized',
      'camera.snapshot',
      'character.walkTo',
      'dag.exec',
      'dag.inspect',
      'library.import',
      'mesh.add',
      'model.generate',
      'motion.generate',
    ]);
    expect(tools).toHaveLength(names.length);
  });

  it('refuses duplicate registration', () => {
    registerAllTools();
    expect(() => registerAllTools()).toThrow('Tool already registered: character.walkTo');
  });

  it('getTool returns undefined for missing tools', () => {
    expect(getTool('nonexistent')).toBeUndefined();
  });

  it('#957 — every node type a description names is a node type that exists', () => {
    // A tool description is not documentation. It is the contract the model plans
    // against, and it names node types as bare words — which makes it a
    // string-keyed surface with no compiler behind it, exactly like a socket name
    // or a param literal. Renaming or retiring a node leaves every description
    // that spells the old name green: `tsc` never reads prose, eslint never reads
    // prose, and no row read one either until this one.
    //
    // Candidates are COMPOUND PascalCase only — two or more humps. Single
    // capitalised words cannot be told from ordinary prose ('Settings', 'Returns',
    // and the node types 'Group' and 'Transform' are the same shape as a
    // sentence's first word), so including them would trade a real check for
    // false reds. The compound names are also the ones that actually churn.
    registerAllTools();
    // TWO legitimate vocabularies, not one. A description may name a registered
    // NODE TYPE, and it may name a SCENE OBJECT KIND — the director-facing word
    // for a thing to add, which the code maps onto node types. `mesh.add` builds
    // its list from `SCENE_OBJECT_KINDS` at runtime, so that half of its
    // description cannot go stale and must not be reported as if it had.
    const known = new Set<string>([...listNodeTypes(), ...SCENE_OBJECT_KINDS]);
    const named = new Map<string, string[]>();
    for (const tool of listTools()) {
      for (const token of tool.description.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) ?? []) {
        named.set(token, [...(named.get(token) ?? []), tool.name]);
      }
    }
    // The population beside the verdict: a zero here would otherwise be
    // indistinguishable from a regex that matched nothing at all.
    expect(
      named.size,
      'no compound names found in any description — check the regex',
    ).toBeGreaterThan(0);
    const unknown = [...named].filter(([token]) => !known.has(token));
    expect(
      unknown,
      `descriptions name node types that do not exist: ${JSON.stringify(unknown)}`,
    ).toEqual([]);
  });

  it('all tools have a non-empty paramSchema', () => {
    registerAllTools();
    for (const tool of listTools()) {
      expect(tool.paramSchema).toBeDefined();
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// character.walkTo
// ---------------------------------------------------------------------------

function buildBaselineCharacter(): DagState {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'time',
    nodeType: 'TimeSource',
    params: {},
  }).next;
  state = applyOp(state, { type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton', params: {} }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'clip',
    nodeType: 'AnimationClip',
    params: { name: 'walk', duration: 1, loop: 'cycle-offset', poses: [] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'nav',
    nodeType: 'Navmesh',
    params: { halfSize: [10, 10], obstacles: [] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'loco',
    nodeType: 'LocomotionState',
    params: { speed: 1, loop: true },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'char',
    nodeType: 'Character',
    params: { name: 'alice' },
  }).next;
  // Wire skeleton → clip → loco → char
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'sk', socket: 'out' },
    to: { node: 'clip', socket: 'skeleton' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'clip', socket: 'pose' },
    to: { node: 'loco', socket: 'pose' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'loco', socket: 'out' },
    to: { node: 'char', socket: 'locomotion' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'loco', socket: 'time' },
  }).next;
  return state;
}

describe('character.walkTo tool', () => {
  it('returns Op[] for a valid character + world point (twice-call)', () => {
    const ctx: ToolContext = { dagState: buildBaselineCharacter() };

    const result1 = characterWalkToTool.handler(
      { characterId: 'char', worldPoint: [5, 0, 3] },
      ctx,
    );
    const result2 = characterWalkToTool.handler(
      { characterId: 'char', worldPoint: [5, 0, 3] },
      ctx,
    );

    // Same inputs → same Op[] — pure function proof
    expect(result1.ops).toEqual(result2.ops);
    expect(result1.ops.length).toBeGreaterThanOrEqual(2); // at least addNode + connect

    // Every element is a valid Op shape
    for (const op of result1.ops) {
      expect(op).toMatchObject({ type: expect.any(String) });
    }
  });

  it('throws for missing character', () => {
    const ctx: ToolContext = { dagState: buildBaselineCharacter() };
    expect(() =>
      characterWalkToTool.handler({ characterId: 'nonexistent', worldPoint: [1, 0, 1] }, ctx),
    ).toThrow('character not found');
  });

  it('throws for missing navmesh', () => {
    const state = buildBaselineCharacter();
    // Remove the navmesh
    const { nav: _removed, ...rest } = state.nodes;
    void _removed;
    const ctx: ToolContext = { dagState: { ...state, nodes: rest } };
    expect(() =>
      characterWalkToTool.handler({ characterId: 'char', worldPoint: [1, 0, 1] }, ctx),
    ).toThrow('missing Navmesh');
  });
});

// ---------------------------------------------------------------------------
// camera.snapshot
// ---------------------------------------------------------------------------

function buildSceneWithCamera(): DagState {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'scene',
    nodeType: 'Scene',
    params: {},
  }).next;
  // Wire scene as the active output
  // #387 C4 — the fused camera node type is retired; a camera is an Object posing a
  // CameraData. `position` on the Object, the lens on the data half.
  state = makeSplitCamera(state, {
    objectId: 'cam',
    fov: 45,
    position: [3, 2, 3],
    lens: { near: 0.1, far: 1000, lookAt: [0, 0, 0] },
  }).state;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  // Also wire a render output
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'render', socket: 'scene' },
  }).next;
  // Set the scene output
  state = {
    ...state,
    outputs: { ...state.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return state;
}

describe('camera.snapshot tool', () => {
  it('returns Op[] that replaces an existing camera (twice-call)', () => {
    const ctx: ToolContext = { dagState: buildSceneWithCamera() };

    const result1 = cameraSnapshotTool.handler(
      { fov: 60, position: [5, 3, 5], lookAt: [0, 0, 0] },
      ctx,
    );
    const result2 = cameraSnapshotTool.handler(
      { fov: 60, position: [5, 3, 5], lookAt: [0, 0, 0] },
      ctx,
    );

    expect(result1.ops).toEqual(result2.ops);
    // #387 C4 — the snapshot mints the object↔data PAIR, so: disconnect old + addNode
    // (CameraData) + addNode (Object) + connect the `data` edge + connect the Object to
    // scene.camera = 5 ops. Both ids are derived from the same content hash, which is what
    // keeps the twice-call equality above meaningful for the pair as well.
    expect(result1.ops).toHaveLength(5);
    expect(result1.ops.map((o) => o.type)).toEqual([
      'disconnect',
      'addNode',
      'addNode',
      'connect',
      'connect',
    ]);
    const added = result1.ops.filter((o) => o.type === 'addNode');
    expect(added.map((o) => (o as { nodeType: string }).nodeType)).toEqual([
      'CameraData',
      'Object',
    ]);
    // scene.camera receives the OBJECT half, never the lens.
    const last = result1.ops[4] as { to: { node: string; socket: string }; from: { node: string } };
    expect(last.to.socket).toBe('camera');
    expect(last.from.node).toBe((added[1] as { nodeId: string }).nodeId);
  });

  it('returns Op[] with just addNode + connect when no camera is wired (twice-call)', () => {
    const state = buildSceneWithCamera();
    // Remove the existing camera connection
    const sceneNode = state.nodes['scene'];
    const { camera: _cam, ...restInputs } = sceneNode.inputs;
    void _cam;
    state.nodes['scene'] = { ...sceneNode, inputs: restInputs };
    const ctx: ToolContext = { dagState: state };

    const result1 = cameraSnapshotTool.handler(
      { fov: 45, position: [3, 3, 3], lookAt: [0, 0, 0] },
      ctx,
    );
    const result2 = cameraSnapshotTool.handler(
      { fov: 45, position: [3, 3, 3], lookAt: [0, 0, 0] },
      ctx,
    );

    expect(result1.ops).toEqual(result2.ops);
    // #387 C4 — the pair again: addNode (CameraData) + addNode (Object) + the `data` edge +
    // the scene.camera edge. No disconnect, because nothing was wired.
    expect(result1.ops).toHaveLength(4);
    expect(result1.ops.map((o) => o.type)).toEqual(['addNode', 'addNode', 'connect', 'connect']);
    expect(
      result1.ops
        .filter((o) => o.type === 'addNode')
        .map((o) => (o as { nodeType: string }).nodeType),
    ).toEqual(['CameraData', 'Object']);
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() =>
      cameraSnapshotTool.handler({ fov: 45, position: [0, 0, 0], lookAt: [0, 0, 0] }, ctx),
    ).toThrow('no Scene output');
  });
});

// ---------------------------------------------------------------------------
// library.import
// ---------------------------------------------------------------------------

function buildSceneBaseline(): DagState {
  let state = emptyDagState();
  state = applyOp(state, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'render', socket: 'scene' },
  }).next;
  state = {
    ...state,
    outputs: { ...state.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Synthetic-GLB fixture builders for the library.import glTF branch (#105).
// Mirror of gltfImportChain.test.ts:27-59,88-113 (the GLB encoder + an
// animated single-translation clip). Staged into the mocked OPFS storage.
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

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
  v.setUint32(0, GLB_MAGIC, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, totalLength, true);
  let cursor = 12;
  v.setUint32(cursor, jsonBytes.length, true);
  v.setUint32(cursor + 4, GLB_CHUNK_JSON, true);
  new Uint8Array(buf, cursor + 8, jsonBytes.length).set(jsonBytes);
  cursor += 8 + jsonBytes.length;
  if (bin) {
    v.setUint32(cursor, bin.length, true);
    v.setUint32(cursor + 4, GLB_CHUNK_BIN, true);
    new Uint8Array(buf, cursor + 8, bin.length).set(bin);
  }
  return new Uint8Array(buf);
}

function f32Bytes(values: number[]): Uint8Array {
  const arr = new Float32Array(values);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  return out;
}

/** Animated GLB: one Cube node, one "bob" clip translating Y over t∈[0,1]. */
function animatedGlb(): Uint8Array {
  const timesBytes = f32Bytes([0, 1]);
  const valuesBytes = f32Bytes([0, 0, 0, 0, 1, 0]);
  const bin = concatBytes(timesBytes, valuesBytes);
  return makeGlb(
    {
      asset: { version: '2.0' },
      nodes: [{ name: 'Cube' }],
      accessors: [
        // An animation input carries its min and max — the glTF spec requires them, and the
        // native reader refuses one without (#1063).
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: timesBytes.length },
        { buffer: 0, byteOffset: timesBytes.length, byteLength: valuesBytes.length },
      ],
      buffers: [{ byteLength: bin.length }],
      animations: [
        {
          name: 'bob',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    },
    bin,
  );
}

/** Static GLB: one Cube node, NO animations (falsification fixture). */
function staticGlb(): Uint8Array {
  return makeGlb({ asset: { version: '2.0' }, nodes: [{ name: 'Cube' }] });
}

function nodeTypesOf(ops: { type: string; nodeType?: string }[]): string[] {
  return ops.filter((o) => o.type === 'addNode').map((o) => o.nodeType as string);
}

describe('library.import tool', () => {
  beforeEach(() => {
    currentStorage = new MemoryStorage();
  });

  // #1307 — a motion file used to fall through to a static chain and become a GltfAsset reading
  // it, reported "Imported". It now takes the chain the UI's motion import dispatches.
  it.each([
    ['assets/motion/walk.bvh', 'public/assets/motion/walk.bvh'],
    ['user-imports/rig/rig.fbx', 'public/fixtures/anim/rig.fbx'],
  ])(
    '%s imports as a motion: skeleton, base pose layer, the Object that stands it',
    async (assetRef, file) => {
      await currentStorage.write(assetRef, new Uint8Array(readFileSync(file)));
      const result = await libraryImportTool.handler(
        { assetRef, position: [1, 0, 1] },
        { dagState: buildSceneBaseline() },
      );
      const types = nodeTypesOf(result.ops);
      expect(types).toContain('Skeleton');
      expect(types).toContain('PoseLayer');
      expect(types).toContain('Object');
      expect(types).not.toContain('GltfAsset');
      // #1451 — the Object stands in the scene the agent's fork holds, with no wrapper Group, as
      // Blender's importer stands it; no collection is active, so it is linked into none.
      // They apply to the fork as they stand — the Diff the user accepts is this.
      let applied = buildSceneBaseline();
      for (const op of result.ops) applied = applyOp(applied, op).next;
      const objects = Object.values(applied.nodes).filter((n) => n.type === 'Object');
      expect(objects).toHaveLength(1);
      expect(Object.values(applied.nodes).some((n) => n.type === 'Group')).toBe(false);
      expect(applied.nodes.scene.inputs.children).toContainEqual({
        node: objects[0].id,
        socket: 'out',
      });
      expect(result.text).toMatch(/as a motion/);
      expect(result.text).not.toMatch(/Group|collection/);
      expect(result.text).toMatch(/not bound to a character/);
    },
  );

  // #1434 — an FBX with no bone is a model: the text says so, and the ops hold no rig.
  it('an FBX with no bone imports as a model, standing in the scene, with no skeleton', async () => {
    const assetRef = 'user-imports/rigless/rigless.fbx';
    await currentStorage.write(
      assetRef,
      new Uint8Array(
        readFileSync('src/core/import/__fixtures__/rigless-hierarchy-blender-default.fbx'),
      ),
    );
    const result = await libraryImportTool.handler(
      { assetRef, position: [0, 0, 0] },
      { dagState: buildSceneBaseline() },
    );
    const types = nodeTypesOf(result.ops);
    expect(types).not.toContain('Skeleton');
    expect(types).not.toContain('PoseLayer');
    expect(result.text).toMatch(
      /^Imported user-imports\/rigless\/rigless\.fbx as a model: 3 meshes/,
    );
    expect(result.text).toMatch(/It has no skeleton\.$/);
    let applied = buildSceneBaseline();
    for (const op of result.ops) applied = applyOp(applied, op).next;
    expect(Object.values(applied.nodes).filter((n) => n.type === 'Object')).toHaveLength(3);
  });

  it('a file in no import format is refused by name, with no ops', async () => {
    const result = await libraryImportTool.handler(
      { assetRef: 'library/rock.png', position: [0, 0, 0] },
      { dagState: buildSceneBaseline() },
    );
    expect(result.ops).toEqual([]);
    expect(result.text).toMatch(
      /^Error: library\/rock\.png was not imported .*\.gltf, \.glb, \.bvh, \.fbx/,
    );
  });

  // #105 — the core parity proof: an animated glTF imported via the agent
  // tool now extracts TransformClip + ClipSelect, exactly like the UI drop
  // (buildGltfImportOps). Before the fix the tool emitted only the static
  // chain (silent #81-class drop on the agent surface).
  it('animated glTF → its keys land as a channel on the node they animate (parity with UI drop)', async () => {
    const assetRef = 'assets/animated-cube.glb';
    await currentStorage.write(assetRef, animatedGlb());
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result = await libraryImportTool.handler({ assetRef, position: [0, 0, 0] }, ctx);

    // #1053 — the agent surface takes the same one road the UI drop does (both go through
    // `buildGltfImportOpsFromOpfs`), so the same file gives the same nodes. A file's animation
    // arrives as a keyframe channel on the node it animates (#1051), never as a clip on an asset.
    expect(result.text).toMatch(/^Imported /);
    const nodeTypes = nodeTypesOf(result.ops);
    expect(nodeTypes).toContain('KeyframeChannelVec3');
    expect(nodeTypes).not.toContain('GltfAsset');
    expect(nodeTypes).not.toContain('TransformClip');
    // A channel names the node it animates by its `target` param, as Auto-Key's does.
    const added = result.ops.flatMap((o) => (o.type === 'addNode' ? [o] : []));
    const channel = added.find((o) => o.nodeType === 'KeyframeChannelVec3')!;
    const { target, paramPath } = channel.params as { target: string; paramPath: string };
    expect(added.find((o) => o.nodeId === target)?.nodeType).toBe('Group');
    expect(paramPath).toBe('position');
  });

  // Falsification — a STATIC glTF yields NO keyframe channel.
  it('static glTF → no keyframe channel (falsification)', async () => {
    const assetRef = 'assets/static-cube.glb';
    await currentStorage.write(assetRef, staticGlb());
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result = await libraryImportTool.handler({ assetRef }, ctx);

    const nodeTypes = nodeTypesOf(result.ops);
    expect(nodeTypes.filter((t) => t.startsWith('KeyframeChannel'))).toEqual([]);
    expect(nodeTypes).not.toContain('GltfAsset');
    expect(nodeTypes).toContain('Group');
  });

  // #1452 — `position` moves the import: what lands stands that far from where the file puts it,
  // read off the WORLD the applied ops resolve to (never the text, which echoes the argument).
  it('a glTF imported at a position lands there, its hierarchy riding along', async () => {
    const assetRef = 'assets/placed.glb';
    await currentStorage.write(
      assetRef,
      makeGlb({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
          { name: 'Root', translation: [1, 2, 3], children: [1] },
          { name: 'Leaf', translation: [0, 1, 0] },
        ],
      }),
    );
    const at = { time: { frame: 0, seconds: 0, normalized: 0 } } as never;
    const worldOf = async (position: [number, number, number]) => {
      const result = await libraryImportTool.handler(
        { assetRef, position },
        { dagState: buildSceneBaseline() },
      );
      let applied = buildSceneBaseline();
      for (const op of result.ops) applied = applyOp(applied, op).next;
      // The world is resolved off the render root, as the viewport draws it.
      applied = {
        ...applied,
        outputs: { ...applied.outputs, render: { node: 'render', socket: 'out' } },
      };
      const named = (name: string) =>
        Object.entries(applied.nodes).find(([, n]) => n.meta?.name === name)![0];
      const world = (name: string) =>
        resolveWorldTransform(applied, named(name), at)!.position.map((v) => +v.toFixed(6));
      // The text says it was moved, not that the file's objects stand at the position.
      expect(result.text).toBe(
        `Imported ${assetRef}, moved [${position}] from where the file puts it`,
      );
      return { root: world('Root'), leaf: world('Leaf') };
    };
    expect(await worldOf([0, 0, 0])).toEqual({ root: [1, 2, 3], leaf: [1, 3, 3] });
    expect(await worldOf([10, 0, -5])).toEqual({ root: [11, 2, -2], leaf: [11, 3, -2] });
  });

  // V22 — two imports of the same assetRef yield byte-identical node ids
  // (the native import is content-addressed off assetRef).
  it('deterministic ids: same assetRef → identical node ids (V22)', async () => {
    const assetRef = 'assets/animated-cube.glb';
    await currentStorage.write(assetRef, animatedGlb());
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const a = await libraryImportTool.handler({ assetRef }, ctx);
    const b = await libraryImportTool.handler({ assetRef }, ctx);

    const idsOf = (r: typeof a) =>
      r.ops.filter((o) => o.type === 'addNode').map((o) => (o as { nodeId: string }).nodeId);
    // Non-empty first: two refusals would also compare equal, and say nothing about ids.
    expect(idsOf(a).length).toBeGreaterThan(0);
    expect(idsOf(a)).toEqual(idsOf(b));
  });

  it('throws when scene output is missing', async () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    await expect(libraryImportTool.handler({ assetRef: 'assets/cube.gltf' }, ctx)).rejects.toThrow(
      'no Scene output',
    );
  });
});

// ---------------------------------------------------------------------------
// mesh.add
// ---------------------------------------------------------------------------

describe('mesh.add tool', () => {
  it('returns Op[] for a Cube (twice-call — structural check)', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result1 = meshAddTool.handler({ kind: 'Cube', position: [0, 1, 0] }, ctx);
    const result2 = meshAddTool.handler({ kind: 'Cube', position: [0, 1, 0] }, ctx);

    // IDs are random so we check structural equality
    expect(result1.ops.length).toBe(result2.ops.length);
    const types1 = result1.ops.map((o) => o.type);
    const types2 = result2.ops.map((o) => o.type);
    expect(types2).toEqual(types1);

    // #365 Phase 5a (Slice 1b) — a Cube is the object↔data split: addNode(BoxData) +
    // addNode(Object) + connect(data→object) + connect(object→scene.children) = 4 ops.
    expect(result1.ops).toHaveLength(4);
    expect(result1.ops[0].type).toBe('addNode');
    expect(result1.ops[1].type).toBe('addNode');
    // The same node types in both calls (data leaf then the posable Object).
    expect((result1.ops[0] as { nodeType: string }).nodeType).toBe('BoxData');
    expect((result1.ops[1] as { nodeType: string }).nodeType).toBe('Object');
    expect((result2.ops[0] as { nodeType: string }).nodeType).toBe('BoxData');
    expect((result2.ops[1] as { nodeType: string }).nodeType).toBe('Object');
  });

  it('returns Op[] for a PointLight with no connect (twice-call — structural check)', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result1 = meshAddTool.handler({ kind: 'PointLight', position: [0, 5, 0] }, ctx);
    const result2 = meshAddTool.handler({ kind: 'PointLight', position: [0, 5, 0] }, ctx);

    expect(result1.ops.length).toBe(result2.ops.length);
    const types1 = result1.ops.map((o) => o.type);
    const types2 = result2.ops.map((o) => o.type);
    expect(types2).toEqual(types1);

    // #386 C3 — a PointLight is now the Object+LightData split: LightData + Object + two
    // connects (data→object.data, object→scene.lights). The director still selects the Object.
    expect(result1.ops).toHaveLength(4);
    expect((result1.ops[0] as { nodeType: string }).nodeType).toBe('LightData');
    expect((result1.ops[1] as { nodeType: string }).nodeType).toBe('Object');
    const sceneConnect = result1.ops.find((o) => o.type === 'connect' && o.to.socket === 'lights');
    expect(sceneConnect).toBeDefined();
  });

  it('returns a single Op for cameras and empties', () => {
    const ctx: ToolContext = { dagState: buildSceneBaseline() };

    const result = meshAddTool.handler({ kind: 'Group', position: [0, 0, 0] }, ctx);
    // Group/Transform/PerspectiveCamera have no auto-connect to scene
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].type).toBe('addNode');
  });

  it('throws when scene output is missing', () => {
    const ctx: ToolContext = { dagState: emptyDagState() };
    expect(() => meshAddTool.handler({ kind: 'Cube', position: [0, 0, 0] }, ctx)).toThrow(
      'no Scene output',
    );
  });
});

// ---------------------------------------------------------------------------
// dag.inspect
// ---------------------------------------------------------------------------

describe('dag.inspect tool', () => {
  let baseCtx: ToolContext;

  beforeEach(() => {
    baseCtx = { dagState: buildSceneBaseline() };
  });

  it('returns text for scope=all', () => {
    const result = dagInspectTool.handler({ scope: 'all' }, baseCtx);
    expect(result.ops).toHaveLength(0);
    expect(result.text).toContain('nodeCount');
    expect(result.text).toContain('Scene');
  });

  it('returns text for scope=node with valid nodeId', () => {
    const result = dagInspectTool.handler({ scope: 'node', nodeId: 'scene' }, baseCtx);
    expect(result.ops).toHaveLength(0);
    expect(result.text).toContain('"Scene"');
  });

  it('returns error for scope=node with missing nodeId', () => {
    const result = dagInspectTool.handler({ scope: 'node', nodeId: 'nonexistent' }, baseCtx);
    expect(result.text).toContain('not found');
  });

  it('returns types list for scope=types', () => {
    const result = dagInspectTool.handler({ scope: 'types' }, baseCtx);
    expect(result.ops).toHaveLength(0);
    expect(result.text).toContain('BoxData');
    expect(result.text).toContain('Scene');
  });

  it('returns outputs for scope=output', () => {
    const result = dagInspectTool.handler({ scope: 'output' }, baseCtx);
    expect(result.text).toContain('scene');
  });
});

// ---------------------------------------------------------------------------
// dag.exec
// ---------------------------------------------------------------------------

describe('dag.exec tool', () => {
  it('returns the ops unchanged in a tool result', () => {
    const ops: import('../../core/dag/types').Op[] = [
      { type: 'addNode', nodeId: 'test', nodeType: 'Object', params: {} },
    ];
    const result = dagExecTool.handler(
      { description: 'add test cube', ops },
      { dagState: emptyDagState() },
    );
    expect(result.ops).toEqual(ops);
    expect(result.text).toContain('add test cube');
  });

  it('rejects empty ops array via zod', () => {
    const parsed = dagExecTool.paramSchema.safeParse({
      description: 'empty',
      ops: [],
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4 Wave C — agent.render.summarizePass
// ---------------------------------------------------------------------------

import { renderSummarizePassTool } from './renderSummarizePass';

function buildJobScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  // #387 C4 — a camera is an Object posing a CameraData (see above).
  s = makeSplitCamera(s, { objectId: 'cam', fov: 45, position: [0, 0, 5] }).state;
  s = makeSplitCube(s, { objectId: 'box', size: [1, 1, 1] }).state;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job',
    nodeType: 'RenderJob',
    params: { jobId: 'jobA', frameStart: 0, frameEnd: 60, fps: 30, outputPath: 'renders/jobA' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job', socket: 'time' },
  }).next;
  for (const [passId, nodeType] of [
    ['beauty', 'BeautyPass'],
    ['idp', 'IDPass'],
  ] as const) {
    s = applyOp(s, { type: 'addNode', nodeId: passId, nodeType, params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: passId, socket: 'scene' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: passId, socket: 'camera' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: passId, socket: 'time' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: passId, socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    }).next;
  }
  return s;
}

describe('agent.render.summarizePass tool', () => {
  it('returns descriptor + sourceHash + storage path for a beauty pass at frame 0', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const r = renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 0 }, ctx);
    expect(r.ops).toHaveLength(0);
    expect(r.text).toBeTruthy();
    const summary = JSON.parse(r.text!);
    expect(summary.jobId).toBe('jobA');
    expect(summary.passId).toBe('beauty');
    expect(summary.passKind).toBe('beauty');
    expect(summary.frame).toBe(0);
    expect(summary.fps).toBe(30);
    expect(summary.descriptor.format).toBe('rgba8');
    expect(summary.outputPath).toBe('renders/jobA/beauty_0000.png');
    expect(summary.sourceHash).toMatch(/^[0-9a-f]{8}$/);
    // #608 — `ambiguous` is GONE, not merely false. A job can hold at most one
    // pass of a role, so there is no ambiguity left for the reader to report.
    expect(summary).not.toHaveProperty('ambiguous');
  });

  it('sourceHash flips between frames at different times', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const f0 = JSON.parse(
      renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 0 }, ctx).text!,
    );
    const f30 = JSON.parse(
      renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 30 }, ctx).text!,
    );
    expect(f0.sourceHash).not.toBe(f30.sourceHash);
    expect(f30.outputPath).toBe('renders/jobA/beauty_0030.png');
  });

  it('id pass returns rgba16f format', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const r = renderSummarizePassTool.handler({ jobId: 'job', passKind: 'id', frame: 0 }, ctx);
    const summary = JSON.parse(r.text!);
    expect(summary.passKind).toBe('id');
    expect(summary.descriptor.format).toBe('rgba16f');
    expect(summary.outputPath).toBe('renders/jobA/id_0000.png');
  });

  it('errors when jobId is unknown', () => {
    const ctx: ToolContext = { dagState: buildJobScene() };
    const r = renderSummarizePassTool.handler({ jobId: 'nope', passKind: 'beauty', frame: 0 }, ctx);
    expect(r.text).toContain('not found');
  });

  it('errors when no pass of the requested kind is connected', () => {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'job',
      nodeType: 'RenderJob',
      params: { jobId: 'lonely' },
    }).next;
    const r = renderSummarizePassTool.handler(
      { jobId: 'job', passKind: 'beauty', frame: 0 },
      { dagState: s },
    );
    expect(r.text).toContain('no passes connected');
  });
});
