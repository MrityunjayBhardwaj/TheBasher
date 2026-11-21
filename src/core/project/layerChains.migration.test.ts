// #1879 — a composition's layer list becomes a chain on the Image lane, and a layer's `enabled`
// becomes `muted`.
//
// The claim that matters is that a saved composition shows the same frame after the conversion:
// the same layers, in the same order, each shown or hidden as before. So the main case goes
// through the real loader and reads the stack back the way the viewer and the export do
// (`collectCompositeInputs`), against what the old list said.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, emptyDagState } from '../dag';
import { MemoryStorage } from '../storage/MemoryStorage';
import { composeProject, loadProject, projectPath } from './io';
import {
  LAYER_CHAINS_FORMAT,
  WORKFLOW_FILES_FORMAT,
  migrateLayerListsToChains,
  migrateProjectFormat,
} from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';
import { collectCompositeInputs } from '../../app/video/compositeDecode';
import { compositionLayerIds } from '../../app/video/videoLayers';
import { workflowSocketsOf } from '../../nodes/ComfyUIWorkflow';

type RawNode = {
  id: string;
  type: string;
  version?: number;
  params: Record<string, unknown>;
  inputs?: Record<string, unknown>;
};
type RawProject = { formatVersion: number; id: string; state: { nodes: Record<string, RawNode> } };

const clip = (id: string): RawNode => ({
  id,
  type: 'MediaClip',
  version: 1,
  params: { src: `media/${id}.png`, mediaKind: 'image', srcFrames: 1 },
  inputs: {},
});
const layer = (id: string, params: Record<string, unknown> = {}): RawNode => ({
  id,
  type: 'Layer',
  version: 1,
  params: { name: id, ...params },
  inputs: { source: { node: `clip_${id}`, socket: 'out' } },
});
const comp = (id: string, layerIds: string[]): RawNode => ({
  id,
  type: 'Composition',
  version: 1,
  params: { name: id },
  inputs: { layers: layerIds.map((node) => ({ node, socket: 'out' })) },
});

/** A v31 project as the app saved it: a comp holding `bg` (shown), `mid` (hidden) and `fg`. */
function savedV31(): RawProject {
  const nodes = [
    clip('clip_bg'),
    clip('clip_mid'),
    clip('clip_fg'),
    layer('bg', { enabled: true }),
    layer('mid', { enabled: false, opacity: 0.5 }),
    layer('fg'),
    comp('comp', ['bg', 'mid', 'fg']),
  ];
  const project = composeProject({ id: 'p1879', name: 'Comp', state: emptyDagState() });
  return JSON.parse(
    JSON.stringify({
      ...project,
      formatVersion: LAYER_CHAINS_FORMAT - 1,
      state: { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), outputs: {} },
    }),
  ) as RawProject;
}

const raw = (nodes: RawNode[]) => ({
  formatVersion: LAYER_CHAINS_FORMAT - 1,
  state: { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) },
});
const nodesOf = (p: unknown) => (p as RawProject).state.nodes;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("v31 → v32: a composition's layer list becomes a chain (#1879)", () => {
  it('the step is reached by a file saved at v31', () => {
    expect(PROJECT_FORMAT_VERSION).toBeGreaterThanOrEqual(LAYER_CHAINS_FORMAT);
    const after = migrateProjectFormat(raw([layer('a'), clip('clip_a'), comp('c', ['a'])]));
    expect((after as { formatVersion: number }).formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(nodesOf(after).c.inputs).toEqual({ in: { node: 'a', socket: 'out' } });
  });

  it('a saved comp loads through the real loader showing the same layers, in order, shown as before', async () => {
    const storage = new MemoryStorage();
    const saved = savedV31();
    await storage.write(projectPath(saved.id), new TextEncoder().encode(JSON.stringify(saved)));
    const project = await loadProject(storage, saved.id);

    expect(compositionLayerIds(project.state, 'comp')).toEqual(['bg', 'mid', 'fg']);
    // What the viewer and the export composite: order and visibility exactly as the list had them.
    const plan = collectCompositeInputs(project.state, 'comp', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    }).map((i) => [i.layerId, i.enabled, i.opacity]);
    expect(plan).toEqual([
      ['bg', true, 1],
      ['mid', false, 0.5],
      ['fg', true, 1],
    ]);
  });

  it('each layer reads the one behind it, and the comp reads the front one', () => {
    const after = nodesOf(
      migrateLayerListsToChains(
        raw([clip('clip_a'), clip('clip_b'), layer('a'), layer('b'), comp('c', ['a', 'b'])]),
      ),
    );
    expect(after.c.inputs).toEqual({ in: { node: 'b', socket: 'out' } });
    expect(after.b.inputs?.below).toEqual({ node: 'a', socket: 'out' });
    expect(after.a.inputs?.below).toBeUndefined();
    // Its own picture stays its own.
    expect(after.b.inputs?.source).toEqual({ node: 'clip_b', socket: 'out' });
  });

  it('`enabled` becomes `muted`, inverted, and a layer that never said stays at the default', () => {
    const after = nodesOf(
      migrateLayerListsToChains(
        raw([
          layer('shown', { enabled: true }),
          layer('hidden', { enabled: false }),
          layer('quiet'),
          comp('c', ['shown', 'hidden', 'quiet']),
        ]),
      ),
    );
    expect(after.shown.params).toMatchObject({ muted: false });
    expect(after.hidden.params).toMatchObject({ muted: true });
    expect('enabled' in after.shown.params).toBe(false);
    expect('muted' in after.quiet.params).toBe(false);
  });

  it('a ref to a missing or non-Layer node is dropped, and said so', () => {
    const after = nodesOf(
      migrateLayerListsToChains(
        raw([clip('clip_a'), layer('a'), comp('c', ['ghost', 'a', 'clip_a'])]),
      ),
    );
    expect(after.c.inputs).toEqual({ in: { node: 'a', socket: 'out' } });
    expect(after.a.inputs?.below).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2 layer ref'));
  });

  it('a layer in two places keeps its first, and the second is dropped and said so', () => {
    const after = nodesOf(
      migrateLayerListsToChains(
        raw([layer('a'), layer('b'), comp('c1', ['a', 'b']), comp('c2', ['b'])]),
      ),
    );
    expect(after.c1.inputs).toEqual({ in: { node: 'b', socket: 'out' } });
    expect(after.c2.inputs).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('1 repeat appearance'));
  });

  it("a key on a layer's `enabled` moves to `muted`, its values inverted", () => {
    const key = {
      id: 'k',
      type: 'KeyframeChannelNumber',
      params: {
        target: 'a',
        paramPath: 'enabled',
        keyframes: [
          { time: 0, value: 1 },
          { time: 1, value: 0 },
        ],
      },
    };
    const after = nodesOf(migrateLayerListsToChains(raw([layer('a'), comp('c', ['a']), key])));
    expect(after.k.params).toMatchObject({
      paramPath: 'muted',
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
    });
  });

  it('a file with no composition is unchanged but its version', () => {
    const before = raw([clip('clip_a')]);
    const after = migrateLayerListsToChains(before) as RawProject;
    expect(after.state).toEqual(before.state);
    expect(after.formatVersion).toBe(LAYER_CHAINS_FORMAT);
  });
});

// #1715 numbered its preset-to-file step v30 → v31 and this one follows it as v31 → v32. A file
// saved at v30 holds BOTH old shapes: a preset ComfyUI node whose layer reads its `out`, and a
// composition holding a list. It has to go through the preset step first and this one second;
// either step skipped, or the two run out of order, leaves one old shape in the loaded file.
describe('a v30 file goes through the workflow-file step, then the layer-chain step (#1715, #1879)', () => {
  /** A v30 project: a preset AI pass shown as a layer over a clip layer, in one composition. */
  function savedV30(): RawProject {
    const nodes: RawNode[] = [
      {
        id: 'prompt',
        type: 'Prompt',
        version: 1,
        params: { text: 'dusk', negative: '', tags: [] },
        inputs: {},
      },
      { id: 'beauty', type: 'BeautyPass', version: 1, params: {}, inputs: {} },
      {
        id: 'wf',
        type: 'ComfyUIWorkflow',
        version: 1,
        params: { presetId: 'stylizedRealism', graph: null, frameStart: 0, frameEnd: 10 },
        inputs: {
          prompt: { node: 'prompt', socket: 'out' },
          'pass-input': [{ node: 'beauty', socket: 'out' }],
        },
      },
      clip('clip_plate'),
      {
        ...layer('plate', { enabled: false }),
        inputs: { source: { node: 'clip_plate', socket: 'out' } },
      },
      { ...layer('ai'), inputs: { source: { node: 'wf', socket: 'out' } } },
      comp('comp', ['plate', 'ai']),
    ];
    const project = composeProject({ id: 'p1715x1879', name: 'Both', state: emptyDagState() });
    return JSON.parse(
      JSON.stringify({
        ...project,
        formatVersion: WORKFLOW_FILES_FORMAT - 1,
        state: { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), outputs: {} },
      }),
    ) as RawProject;
  }

  it('the two steps are v30 → v31 and v31 → v32, in that order', () => {
    expect(WORKFLOW_FILES_FORMAT).toBe(31);
    expect(LAYER_CHAINS_FORMAT).toBe(32);
    expect(PROJECT_FORMAT_VERSION).toBe(LAYER_CHAINS_FORMAT);
  });

  it('loads with the preset as a workflow file and the list as a chain, the AI layer reading the file’s output', async () => {
    const storage = new MemoryStorage();
    const saved = savedV30();
    await storage.write(projectPath(saved.id), new TextEncoder().encode(JSON.stringify(saved)));
    const project = await loadProject(storage, saved.id);
    const { nodes } = project.state;

    // The workflow-file step ran: no preset, the preset's file, its output named.
    expect(nodes.wf.params as object).not.toHaveProperty('presetId');
    const outputs = workflowSocketsOf(nodes.wf.params).outputs.map((o) => o.socket);
    expect(outputs).toEqual(['stylized']);
    // The layer that read the preset's `out` reads the file's first output.
    expect(nodes.ai.inputs.source).toEqual({ node: 'wf', socket: 'stylized' });

    // The layer-chain step ran: the comp reads the front layer, which stands on the plate.
    expect(nodes.comp.inputs).toEqual({ in: { node: 'ai', socket: 'out' } });
    expect(nodes.ai.inputs.below).toEqual({ node: 'plate', socket: 'out' });
    expect(compositionLayerIds(project.state, 'comp')).toEqual(['plate', 'ai']);
    expect(nodes.plate.params as object).toMatchObject({ muted: true });
    expect(nodes.plate.params as object).not.toHaveProperty('enabled');
  });
});
