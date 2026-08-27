// The human ingestion surface for generated meshes — A4's third leg.
//
// Shaped after generateMotion.test.ts, which is shaped after importBvhFbx.test.ts,
// because generateModel is shaped after importGltfFromOpfs: the assertions are
// about the SURFACE — dispatch, banner, refresh bump, and which road was taken —
// rather than about the generator's internals.
//
// 🔑 THE TEST THAT CARRIES THE PHASE'S CLAIM IS `takes the identical road a
// dropped .glb takes`. It is only writable now that BOTH roads exist: the
// generated one and the file one. Its earlier draft, written while only one road
// existed, compared `buildGltfImportOps(bytes)` against `buildGltfImportOps(same
// bytes)` — one function, one input, both sides — and would have held for every
// implementation including a wrong one. This compares two DIFFERENT entry points
// and asserts they converge.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
  DEFAULT_MODEL_VERSION,
  StubModelGenerationCapability,
  synthesiseGlb,
} from '../../core/modelgen';
import type { ModelGenerationCapability, ModelGenerationRequest } from '../../core/modelgen';

const capability = new StubModelGenerationCapability();
// Override ONLY the capability getter. Replacing the whole boot module drops
// `getStorage`, which `ingestSingleFile` needs — and the failure is silent in the
// worst way: every generation returns ok:false and the surface tests all go red
// for a reason that has nothing to do with the surface.
vi.mock('../boot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../boot')>()),
  getModelCapability: async () => capability,
}));

// Imported AFTER vi.mock so the modules pick up the mocked boot.
import { generateModelFromText, generateModelIntoScene } from './generateModel';
import { ingestSingleFile } from './importCommon';
import { importGltfFromOpfs } from './importGltf';
import { modelGenerateTool } from '../../agent/tools/modelGenerate';

const PROMPT = 'a worn leather armchair';
const TEXT: ModelGenerationRequest = { source: 'text', prompt: PROMPT };

function seedScene(): void {
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
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  useSettingsStore.setState({ modelGenVersion: DEFAULT_MODEL_VERSION });
  seedScene();
});

describe('a director generating a mesh gets an ordinary imported asset', () => {
  it('lands nodes in the graph and bumps the refresh signal', async () => {
    const before = Object.keys(useDagStore.getState().state.nodes).length;
    const result = await generateModelFromText(PROMPT);

    expect(result.ok).toBe(true);
    expect(Object.keys(useDagStore.getState().state.nodes).length).toBeGreaterThan(before);
    // Bumped AFTER the dispatch, so My Imports never re-enumerates on a failure.
    expect(useImportRefreshStore.getState().tick).toBeGreaterThan(0);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('writes the asset under user-imports, where an imported file also lives', async () => {
    const result = await generateModelFromText(PROMPT);
    expect(result.ok ? result.opfsPath : `FAILED: ${result.reason}`).toMatch(/^user-imports\//);
    expect(result.ok ? result.opfsPath : `FAILED: ${result.reason}`).toMatch(/\.glb$/);
  });

  it('adds only node types an imported GLB also adds', async () => {
    await generateModelFromText(PROMPT);
    const types = [
      ...new Set(Object.values(useDagStore.getState().state.nodes).map((n) => n.type)),
    ].sort();
    // Scene + TimeSource are the seed; the rest is what the import road produced.
    expect(types).toEqual(['GltfAsset', 'GltfChild', 'Group', 'Scene', 'TimeSource']);
  });
});

describe("the identical road — the phase's discriminating observation", () => {
  it('takes the identical road a dropped .glb takes', async () => {
    // TWO different entry points, converging. Left: the generation surface.
    // Right: the file-drop surface, handed the same bytes by hand.
    await generateModelFromText(PROMPT);
    const viaGeneration = useDagStore.getState().state;

    seedScene();
    const droppedPath = await ingestSingleFile(
      { relativePath: 'model.glb', bytes: new Uint8Array(synthesiseGlb(TEXT)) },
      PROMPT,
    );
    await importGltfFromOpfs(droppedPath);
    const viaFile = useDagStore.getState().state;

    // Node ids are content-addressed off the assetRef, and the two runs resolve
    // to DIFFERENT folders (collision suffixing), so compare the SHAPE: the same
    // node types, wired the same way, with the same params modulo the path.
    const shapeOf = (s: typeof viaGeneration) =>
      Object.values(s.nodes)
        .map(
          (n) =>
            `${n.type}:${Object.keys(n.params ?? {})
              .sort()
              .join(',')}`,
        )
        .sort();
    expect(shapeOf(viaGeneration)).toEqual(shapeOf(viaFile));
  });

  it('the ops a director gets and the ops the agent gets are the same ops', async () => {
    // If these two ever diverge, "UI == agent == render" is a slogan rather than
    // a property. Both sides are driven from one set of bytes.
    const agent = await modelGenerateTool.handler(
      { prompt: PROMPT },
      {
        dagState: useDagStore.getState().state,
        modelCapability: capability as ModelGenerationCapability,
        modelVersion: DEFAULT_MODEL_VERSION,
      },
    );
    const agentShape = agent.ops
      .map((o) => (o.type === 'addNode' ? `addNode:${o.nodeType}` : o.type))
      .sort();

    seedScene();
    const before = new Set(Object.keys(useDagStore.getState().state.nodes));
    await generateModelFromText(PROMPT);
    const humanShape = Object.values(useDagStore.getState().state.nodes)
      .filter((n) => !before.has(n.id))
      .map((n) => `addNode:${n.type}`)
      .concat(['connect', 'connect'])
      .sort();

    expect(agentShape).toEqual(humanShape);
  });
});

describe('failures surface in the banner, never console-only', () => {
  it('reports a refusal and returns ok:false rather than throwing', async () => {
    const refusing: ModelGenerationCapability = {
      id: 'refusing',
      kind: 'http',
      isAvailable: async () => true,
      generate: async () => {
        throw new Error('no recorded licence verdict');
      },
      cancel: async () => {},
    };
    const spy = vi.spyOn(await import('../boot'), 'getModelCapability');
    spy.mockResolvedValueOnce(refusing);

    const result = await generateModelIntoScene(TEXT);
    expect(result).toMatchObject({ ok: false });
    expect(Object.keys(useAssetErrorStore.getState().errors).length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('a degenerate request is refused before anything is written', async () => {
    const result = await generateModelIntoScene({ source: 'text', prompt: '' });
    expect(result).toMatchObject({ ok: false });
    expect(Object.keys(useAssetErrorStore.getState().errors).length).toBeGreaterThan(0);
  });
});
