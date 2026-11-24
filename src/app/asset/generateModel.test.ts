// The Model generate road — a generated model keeps a `ModelGenerate` node (#1720), and its mesh
// still arrives by the import road (phase A4).
//
// 🔑 TWO CLAIMS CARRY THIS FILE.
//   1. `takes the identical road a dropped .glb takes` — the kept variant's import is the import a
//      dropped file gets: two DIFFERENT entry points converging, not one function compared with
//      itself.
//   2. `Regenerate adds a new variant to the SAME node` — the issue's done-when, at the unit tier:
//      one node before and after, one more variant, a seed it had not used, and new bytes.
//
// Every test runs on the offline stub, asserted rather than assumed (`the capability is the
// stub`), so no row can reach a paid service.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { listNodeTypes } from '../../core/dag';
import { newCollectionOps, setActiveCollectionOp } from '../collections';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useModelGenerationStore } from '../stores/modelGenerationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useProjectStore } from '../../core/project/store';
import { PROJECT_FORMAT_VERSION } from '../../core/project/schema';
import { DEFAULT_MODEL_VERSION, StubModelGenerationCapability } from '../../core/modelgen';
import type { ModelGenerationCapability } from '../../core/modelgen';
import { StubRiggingCapability } from '../../core/rigging';
import type { ModelGenerateParams } from '../../nodes/ModelGenerate';

const capability = new StubModelGenerationCapability();
const rigging = new StubRiggingCapability();
let current: ModelGenerationCapability = capability;

// Override ONLY the capability getters. Replacing the whole boot module drops `getStorage`,
// which the ingest needs — and every row would go red for a reason unrelated to the road.
vi.mock('../boot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../boot')>()),
  getModelCapability: async () => current,
  getRiggingCapability: async () => rigging,
}));

// Imported AFTER vi.mock so the modules pick up the mocked boot.
import {
  GENERATION_RECORD_FILE,
  MODEL_VARIANTS_ROOT,
  assetFolderOf,
  keepModelVariant,
  mintModelGenerateOps,
  modelGenerateParamsIn,
  readGenerationRecord,
  regenerateModel,
  requestForVariant,
  startModelGeneration,
  storeReferenceImage,
  type GenerationRecord,
} from './generateModel';
import { ingestSingleFile } from './importCommon';
import { importGltfFromOpfs } from './importGltf';
import { getStorage } from '../boot';
import { modelGenerateTool } from '../../agent/tools/modelGenerate';

const PROMPT = 'a worn leather armchair';

function seedScene(): void {
  useDagStore.getState().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
}

function modelNodes(): { id: string; params: ModelGenerateParams }[] {
  const state = useDagStore.getState().state;
  return Object.values(state.nodes)
    .filter((n) => n.type === 'ModelGenerate')
    .map((n) => ({ id: n.id, params: modelGenerateParamsIn(state, n.id)! }));
}

function types(): string[] {
  return Object.values(useDagStore.getState().state.nodes)
    .map((n) => n.type)
    .sort();
}

beforeEach(() => {
  registerAllNodes();
  current = capability;
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  useModelGenerationStore.setState({ activeNodeId: null, run: null });
  useSettingsStore.setState({ modelGenVersion: DEFAULT_MODEL_VERSION });
  seedScene();
});

describe('no row here can reach a paid service', () => {
  it('the capability every row uses is the offline stub', () => {
    expect(capability.kind).toBe('stub');
    expect(capability.id).toBe('stub-modelgen');
  });
});

describe('a run mints ONE node and its variants arrive on it', () => {
  it('mints a ModelGenerate holding the request, with the provider that answers', async () => {
    const out = await startModelGeneration({ prompt: `  ${PROMPT}  `, count: 3, seed: 100 });
    expect(out).toMatchObject({ ok: true, added: 3 });
    const nodes = modelNodes();
    expect(nodes).toHaveLength(1);
    const [{ params }] = nodes;
    expect(params).toMatchObject({
      prompt: PROMPT,
      references: [],
      seed: 100,
      provider: 'stub-modelgen',
      rig: false,
      count: 3,
    });
    expect(params.variants.map((v) => v.seed)).toEqual([100, 101, 102]);
  });

  it('stores variants OUTSIDE the library and places nothing until one is kept', async () => {
    await startModelGeneration({ prompt: PROMPT, count: 2, seed: 7 });
    const [{ id, params }] = modelNodes();
    for (const v of params.variants) {
      expect(v.path.startsWith(`${MODEL_VARIANTS_ROOT}/${id}/`)).toBe(true);
      expect((await (await getStorage()).read(v.path)).byteLength).toBeGreaterThan(0);
      expect(v.kept).toBe(false);
    }
    // Only the seed nodes and the producer: no Object, no mesh, no library refresh.
    expect(types()).toEqual(['ModelGenerate', 'Scene', 'TimeSource']);
    expect(useImportRefreshStore.getState().tick).toBe(0);
  });

  it('different seeds are different variants — the stub keys its mesh on the seed', async () => {
    await startModelGeneration({ prompt: PROMPT, count: 2, seed: 1 });
    const [{ params }] = modelNodes();
    const storage = await getStorage();
    const [a, b] = await Promise.all(params.variants.map((v) => storage.read(v.path)));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('the run is over when the call returns — the placeholder has nothing to stand for', async () => {
    const seen: (string | null)[] = [];
    const unsub = useModelGenerationStore.subscribe((s) => seen.push(s.run?.nodeId ?? null));
    await startModelGeneration({ prompt: PROMPT, count: 1, seed: 1 });
    unsub();
    expect(seen.some((id) => id !== null)).toBe(true);
    expect(useModelGenerationStore.getState().run).toBeNull();
  });
});

describe('Keep saves one variant to the library and places it', () => {
  it('places the variant by the import road and marks it kept, in ONE undo entry', async () => {
    await startModelGeneration({ prompt: PROMPT, count: 2, seed: 50 });
    const [{ id }] = modelNodes();
    const undoBefore = useDagStore.getState().undoStack.length;
    const kept = await keepModelVariant(id, 51);
    expect(kept.ok ? kept.opfsPath : kept.reason).toMatch(/^user-imports\/.*\.glb$/);
    expect(types()).toEqual(['ModelGenerate', 'Object', 'PolyMeshData', 'Scene', 'TimeSource']);
    expect(modelNodes()[0].params.variants.map((v) => [v.seed, v.kept])).toEqual([
      [50, false],
      [51, true],
    ]);
    expect(useDagStore.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useImportRefreshStore.getState().tick).toBeGreaterThan(0);
  });

  it('writes the record beside the asset, naming the node, the seed and the provider', async () => {
    await startModelGeneration({ prompt: PROMPT, count: 1, seed: 9 });
    const [{ id, params }] = modelNodes();
    const kept = await keepModelVariant(id, 9);
    if (!kept.ok) throw new Error(kept.reason);
    const record = await readGenerationRecord(kept.opfsPath);
    expect(record).toEqual<GenerationRecord>({
      nodeId: id,
      projectId: useProjectStore.getState().current?.id ?? null,
      prompt: PROMPT,
      references: [],
      seed: 9,
      provider: 'stub-modelgen',
      rig: false,
      taskId: params.variants[0].taskId,
    });
    expect(
      await (
        await getStorage()
      ).exists(`${assetFolderOf(kept.opfsPath)}/${GENERATION_RECORD_FILE}`),
    ).toBe(true);
  });

  it('an ordinary import has no record', async () => {
    const path = await ingestSingleFile(
      { relativePath: 'model.glb', bytes: new Uint8Array(await synthesised(PROMPT)) },
      'dropped',
    );
    expect(await readGenerationRecord(path)).toBeNull();
  });
});

describe('Regenerate — the done-when, at the unit tier', () => {
  it('adds a new variant to the SAME node, with a seed it had not used', async () => {
    await startModelGeneration({ prompt: PROMPT, count: 2, seed: 20 });
    const [{ id }] = modelNodes();
    await keepModelVariant(id, 20);
    const out = await regenerateModel(id);
    expect(out).toMatchObject({ ok: true, nodeId: id, added: 1 });
    const after = modelNodes();
    expect(after.map((n) => n.id)).toEqual([id]);
    expect(after[0].params.variants.map((v) => v.seed)).toEqual([20, 21, 22]);
    // The kept variant stays kept; the new one waits to be chosen.
    expect(after[0].params.variants.map((v) => v.kept)).toEqual([true, false, false]);
  });
});

describe("the identical road — the phase's discriminating observation", () => {
  it('a kept variant is imported exactly as a dropped .glb is', async () => {
    await startModelGeneration({ prompt: PROMPT, count: 1, seed: 3 });
    const [{ id, params }] = modelNodes();
    const bytes = await (await getStorage()).read(params.variants[0].path);
    await keepModelVariant(id, 3);
    const viaGeneration = useDagStore.getState().state;

    seedScene();
    const dropped = await ingestSingleFile({ relativePath: 'model.glb', bytes }, PROMPT);
    await importGltfFromOpfs(dropped);
    const viaFile = useDagStore.getState().state;

    // Node ids are content-addressed off the path, which differs, so compare the SHAPE — less
    // the producer, which is the one node the generated road adds and the file road cannot.
    const shapeOf = (s: typeof viaFile) =>
      Object.values(s.nodes)
        .filter((n) => n.type !== 'ModelGenerate')
        .map(
          (n) =>
            `${n.type}:${Object.keys(n.params ?? {})
              .sort()
              .join(',')}`,
        )
        .sort();
    expect(shapeOf(viaGeneration)).toEqual(shapeOf(viaFile));
  });

  it('the ops the agent gets are the ops a director gets', async () => {
    const agent = await modelGenerateTool.handler(
      { prompt: PROMPT, seed: 5 },
      {
        dagState: useDagStore.getState().state,
        modelCapability: capability,
        modelVersion: DEFAULT_MODEL_VERSION,
      },
    );
    const agentShape = agent.ops
      .map((o) => (o.type === 'addNode' ? `addNode:${o.nodeType}` : o.type))
      .sort();

    seedScene();
    const before = new Set(Object.keys(useDagStore.getState().state.nodes));
    await startModelGeneration({ prompt: PROMPT, count: 1, seed: 5 });
    const [{ id }] = modelNodes();
    await keepModelVariant(id, 5);
    const added = Object.values(useDagStore.getState().state.nodes).filter(
      (n) => !before.has(n.id),
    );
    const humanShape = added
      .map((n) => `addNode:${n.type}`)
      // #1137 — a name the import wrote, one `setMeta` per named node, read off the nodes.
      .concat(added.filter((n) => n.meta?.name !== undefined).map(() => 'setMeta'))
      // A native import with no wrapper Group (#1451): `data → object.data` and
      // `object → scene.children`, for this fixture's one object.
      .concat(['connect', 'connect'])
      .sort();
    expect(agentShape).toEqual(humanShape);

    // And the agent's node holds the same request, with its one variant kept.
    const agentNode = agent.ops.find((o) => o.type === 'addNode' && o.nodeType === 'ModelGenerate');
    expect(agentNode?.type === 'addNode' ? agentNode.params : null).toMatchObject({
      prompt: PROMPT,
      seed: 5,
      provider: 'stub-modelgen',
      variants: [{ seed: 5, kept: true }],
    });
  });

  it('#1478 — the description names no node type the import does not add', async () => {
    const agent = await modelGenerateTool.handler(
      { prompt: PROMPT },
      {
        dagState: useDagStore.getState().state,
        modelCapability: capability,
        modelVersion: DEFAULT_MODEL_VERSION,
      },
    );
    const added = new Set(agent.ops.flatMap((o) => (o.type === 'addNode' ? [o.nodeType] : [])));
    expect(added.size, 'the premise: the import added nodes').toBeGreaterThan(0);
    const registered = new Set(listNodeTypes());
    const named = (modelGenerateTool.description.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? []).filter(
      (word) => registered.has(word),
    );
    expect(named.length, 'the premise: the description names a node type').toBeGreaterThan(0);
    expect(named.filter((type) => !added.has(type))).toEqual([]);
  });

  it('#1478 — as the description says, the objects join the active collection', async () => {
    const made = newCollectionOps(useDagStore.getState().state)!;
    useDagStore
      .getState()
      .dispatchAtomic(
        [...made.ops, setActiveCollectionOp(useDagStore.getState().state, made.collectionId)!],
        'user',
        'active collection',
      );
    const agent = await modelGenerateTool.handler(
      { prompt: PROMPT },
      {
        dagState: useDagStore.getState().state,
        modelCapability: capability,
        modelVersion: DEFAULT_MODEL_VERSION,
      },
    );
    const objects = agent.ops.flatMap((o) =>
      o.type === 'addNode' && o.nodeType === 'Object' ? [o.nodeId] : [],
    );
    const linked = agent.ops.flatMap((o) =>
      o.type === 'connect' && o.to.node === made.collectionId && o.to.socket === 'members'
        ? [o.from.node]
        : [],
    );
    expect(objects.length, 'the premise: the import made an object').toBeGreaterThan(0);
    expect(linked).toEqual(objects);
  });
});

describe('a reference image is the subject, never a prompt beside it (#837)', () => {
  it('builds an IMAGE request that carries no prompt, from the image the node names', async () => {
    useProjectStore.setState({
      current: { ...(useProjectStore.getState().current ?? fakeProject()), id: 'p1720' },
    });
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const key = await storeReferenceImage({ bytes, mimeType: 'image/png' });
    const { ops } = mintModelGenerateOps({
      prompt: '',
      references: [key],
      seed: 4,
      provider: 'stub-modelgen',
    });
    const params = (ops[0] as { params: ModelGenerateParams }).params;
    const request = await requestForVariant(params, 4, undefined);
    expect(request.source).toBe('image');
    expect(request).not.toHaveProperty('prompt');
    expect(request.source === 'image' ? Array.from(request.image.bytes) : []).toEqual(
      Array.from(bytes),
    );
    expect(request.modelSeed).toBe(4);
  });
});

describe('a rigged request runs the rigged road', () => {
  it('stores the RIGGED bytes as the variant', async () => {
    await startModelGeneration({ prompt: 'a stocky dwarf', count: 1, seed: 2, rig: true });
    const [{ params }] = modelNodes();
    expect(params.rig).toBe(true);
    const glb = await (await getStorage()).read(params.variants[0].path);
    const jsonLength = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
      skins?: unknown[];
    };
    expect(json.skins?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('failures surface in the banner, never console-only', () => {
  it('a refusal ends the run with ok:false and a banner, leaving the node to retry from', async () => {
    current = {
      id: 'refusing',
      kind: 'http',
      isAvailable: async () => true,
      generate: async () => {
        throw new Error('no recorded licence verdict');
      },
      generateTaskOnly: async () => {
        throw new Error('no recorded licence verdict');
      },
      cancel: async () => {},
    };
    const out = await startModelGeneration({ prompt: PROMPT, count: 2, seed: 1 });
    expect(out).toMatchObject({ ok: false });
    expect(Object.keys(useAssetErrorStore.getState().errors).length).toBeGreaterThan(0);
    expect(modelNodes()[0].params.variants).toEqual([]);
    expect(useModelGenerationStore.getState().run).toBeNull();
  });

  it('a request with neither a prompt nor an image is refused before anything is billed', async () => {
    const generate = vi.spyOn(capability, 'generate');
    const out = await startModelGeneration({ prompt: '   ', count: 1, seed: 1 });
    expect(out).toMatchObject({ ok: false });
    expect(Object.keys(useAssetErrorStore.getState().errors).length).toBeGreaterThan(0);
    // The stub validates like the service; nothing reached a store.
    expect(modelNodes()[0]?.params.variants ?? []).toEqual([]);
    generate.mockRestore();
  });
});

async function synthesised(prompt: string): Promise<ArrayBuffer> {
  return (await capability.generate({ source: 'text', prompt })).glb;
}

function fakeProject() {
  return {
    formatVersion: PROJECT_FORMAT_VERSION as typeof PROJECT_FORMAT_VERSION,
    id: 'p1720',
    name: 'p1720',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: {},
    state: { nodes: {}, outputs: {} },
  };
}
