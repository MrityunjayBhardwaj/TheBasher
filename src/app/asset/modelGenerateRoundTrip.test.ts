// #1720 — a Model generate node survives a save and a load, and still regenerates after it.
//
// `roundTrip.test.ts` proves the project file keeps the node's params byte for byte. It cannot see
// the node's own schema: a project stores params as `unknown`, so a field the schema stopped
// declaring would still round-trip there and then vanish the moment the road parses the node.
// This reads the node back THROUGH the road (`modelGenerateParamsIn`, the parse every action
// uses) and compares it with the params written, field for field. Then it regenerates from the
// reloaded graph: the new variant must land on the same node with a seed none of the four used.
//
// Offline stub only — asserted, so no row can reach a paid service.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';
import { composeProject, loadProject, saveProject } from '../../core/project/io';
import { PROJECT_FORMAT_VERSION } from '../../core/project/schema';
import { useProjectStore } from '../../core/project/store';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { StubModelGenerationCapability } from '../../core/modelgen';
import { StubRiggingCapability } from '../../core/rigging';
import { useModelGenerationStore } from '../stores/modelGenerationStore';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import type { ModelGenerateParams } from '../../nodes/ModelGenerate';

const capability = new StubModelGenerationCapability();
const rigging = new StubRiggingCapability();

vi.mock('../boot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../boot')>()),
  getModelCapability: async () => capability,
  getRiggingCapability: async () => rigging,
}));

import { modelGenerateParamsIn, regenerateModel, storeReferenceImage } from './generateModel';

const PROJECT_ID = 'p1720rt';

/** The params as written: four variants with one kept, a reference, every optional setting. */
function written(reference: string): ModelGenerateParams {
  return {
    prompt: '',
    references: [reference],
    seed: 100,
    provider: 'stub-modelgen',
    rig: true,
    count: 4,
    negativePrompt: 'no text',
    faceLimit: 20000,
    quad: true,
    texture: true,
    pbr: false,
    variants: [100, 101, 102, 103].map((seed) => ({
      seed,
      path: `model-variants/mg/seed-${seed}.glb`,
      taskId: `task-${seed}`,
      kept: seed === 102,
    })),
  };
}

async function saveAndReload(state: DagState): Promise<DagState> {
  const storage = new MemoryStorage();
  const header = { id: PROJECT_ID, name: 'round trip', createdAt: 1, updatedAt: 2 };
  await saveProject(storage, composeProject({ ...header, state }));
  return (await loadProject(storage, PROJECT_ID)).state as DagState;
}

beforeEach(() => {
  registerAllNodes();
  useAssetErrorStore.getState().clearAll();
  useModelGenerationStore.setState({ activeNodeId: null, run: null });
  useProjectStore.setState({
    current: {
      formatVersion: PROJECT_FORMAT_VERSION as typeof PROJECT_FORMAT_VERSION,
      id: PROJECT_ID,
      name: 'round trip',
      createdAt: 1,
      updatedAt: 2,
      nodeVersions: {},
      state: { nodes: {}, outputs: {} },
    },
  });
});

describe('#1720 — a Model generate node after a save and a reload', () => {
  it('runs on the offline stub', () => {
    expect([capability.kind, capability.id]).toEqual(['stub', 'stub-modelgen']);
  });

  it('reads back, through the road, exactly the params that were written', async () => {
    const reference = await storeReferenceImage({
      bytes: new Uint8Array([137, 80, 78, 71, 9, 9, 9]),
      mimeType: 'image/png',
    });
    const params = written(reference);
    const state = useDagStore.getState();
    state.hydrate(buildDefaultDagState());
    useDagStore
      .getState()
      .dispatchAtomic([{ type: 'addNode', nodeId: 'mg', nodeType: 'ModelGenerate', params }]);

    const loaded = await saveAndReload(useDagStore.getState().state);
    expect(modelGenerateParamsIn(loaded, 'mg')).toEqual(params);
  });

  it('Regenerate after the reload adds a variant to the same node, with an unused seed', async () => {
    const reference = await storeReferenceImage({
      bytes: new Uint8Array([137, 80, 78, 71, 9, 9, 9]),
      mimeType: 'image/png',
    });
    useDagStore.getState().hydrate(buildDefaultDagState());
    useDagStore
      .getState()
      .dispatchAtomic([
        { type: 'addNode', nodeId: 'mg', nodeType: 'ModelGenerate', params: written(reference) },
      ]);
    const loaded = await saveAndReload(useDagStore.getState().state);
    useDagStore.getState().hydrate(loaded);

    const out = await regenerateModel('mg');
    expect(out).toMatchObject({ ok: true, nodeId: 'mg', added: 1 });
    const after = modelGenerateParamsIn(useDagStore.getState().state, 'mg')!;
    const nodes = Object.values(useDagStore.getState().state.nodes).filter(
      (n) => n.type === 'ModelGenerate',
    );
    expect(nodes.map((n) => n.id)).toEqual(['mg']);
    expect(after.variants).toHaveLength(5);
    const fresh = after.variants[4];
    expect([100, 101, 102, 103]).not.toContain(fresh.seed);
    expect(fresh.seed).toBe(104);
    // The four that came back are untouched, the kept one still kept.
    expect(after.variants.slice(0, 4)).toEqual(written(reference).variants);
  });
});
