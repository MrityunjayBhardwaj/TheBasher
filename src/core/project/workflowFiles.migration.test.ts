// #1715 — v30 → v31: the ComfyUI preset enum is gone; a preset node holds the preset's file.
//
// What must hold, read through the real loader:
//   - a preset node (every preset: there was one, `stylizedRealism`) becomes the generic node
//     holding that preset's workflow file, with no `presetId`;
//   - its pass wires land on the sockets named after each pass, `prompt` and `time` keep theirs,
//     and NO wire is dropped: one with no socket of its kind stays on `pass-input`, broken;
//   - the negative text the preset read off the Prompt is in the file's `negative` input;
//   - every wire read off the node's `out` (a stitch, the render output) reads `stylized`;
//   - an imported file keeps its file; wires off its `out` read its first output;
//   - the migrated nodes are ones the restore door accepts, and saving and loading again
//     changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetRegistryForTests, applyOps, emptyDagState, type Op } from '../dag';
import { MemoryStorage } from '../storage/MemoryStorage';
import { loadProject, projectPath, saveProject } from './io';
import { WORKFLOW_FILES_FORMAT, migratePresetsToWorkflowFiles } from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';
import { socketsOfWorkflow } from '../comfy/workflowSockets';
import type { ComfyApiJson } from '../comfy/comfyGraph';
import { STYLIZED_REALISM_WORKFLOW } from '../comfy/builtinWorkflows';
import { workflowSocketsOf } from '../../nodes/ComfyUIWorkflow';
import { workflowMadeState } from '../../nodes/comfyWorkflowMade';

type Ref = { node: string; socket: string };
type RawNode = {
  id: string;
  type: string;
  version: number;
  params: Record<string, unknown>;
  inputs: Record<string, Ref | Ref[]>;
};

const n = (
  id: string,
  type: string,
  params: Record<string, unknown> = {},
  inputs: RawNode['inputs'] = {},
): RawNode => ({ id, type, version: 1, params, inputs });
const r = (node: string, socket = 'out'): Ref => ({ node, socket });

const IMPORTED: ComfyApiJson = {
  '1': { class_type: 'basher_controller', inputs: { name: 'seed', kind: 'int' } },
  '2': { class_type: 'basher_export', inputs: { name: 'clip', kind: 'video', images: ['9', 0] } },
};

/** A v30 project: the preset node every AI pass made (addAIPass), an imported-file node, a stitch
 *  reading the preset's `out`, and the render output on it. */
function v30Project() {
  const nodes: RawNode[] = [
    n('time', 'TimeSource'),
    n('prompt', 'Prompt', { text: 'golden hour', negative: 'lowres, blurry', tags: [] }),
    n('beauty', 'BeautyPass'),
    n('depth', 'DepthPass'),
    n('normal', 'NormalPass'),
    n('ids', 'IDPass'),
    n(
      'wf',
      'ComfyUIWorkflow',
      {
        presetId: 'stylizedRealism',
        graph: null,
        frameStart: 0,
        frameEnd: 10,
        lastGoodFrame: -1,
        outputPath: 'renders/job/stylized_stylizedRealism',
      },
      {
        prompt: r('prompt'),
        'pass-input': [r('beauty'), r('depth'), r('normal'), r('ids')],
        time: r('time'),
      },
    ),
    n(
      'imported',
      'ComfyUIWorkflow',
      { presetId: 'stylizedRealism', graph: { apiJson: IMPORTED, meta: META } },
      { prompt: r('prompt') },
    ),
    n('stitch', 'VideoStitch', {}, { 'pass-input': [r('wf'), r('imported')] }),
  ];
  return {
    formatVersion: WORKFLOW_FILES_FORMAT - 1,
    id: 'p1715',
    name: 'old AI pass',
    createdAt: 1,
    updatedAt: 1,
    nodeVersions: {},
    state: {
      nodes: Object.fromEntries(nodes.map((x) => [x.id, x])),
      outputs: { render: r('wf') },
    },
  };
}
const META = { name: 'imported', importedAt: 'x', fps: 30, frames: 1 };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function loaded() {
  const storage = new MemoryStorage();
  const old = v30Project();
  await storage.write(projectPath(old.id), new TextEncoder().encode(JSON.stringify(old)));
  return { storage, project: await loadProject(storage, old.id) };
}

describe('v30 → v31: a preset node holds the preset’s workflow file (#1715)', () => {
  it('is a step on the way to the current format', () => {
    // #1879's layer chains (v32) landed after it, so it is no longer the last step.
    expect(PROJECT_FORMAT_VERSION).toBeGreaterThanOrEqual(WORKFLOW_FILES_FORMAT);
  });

  it('the stylizedRealism preset becomes the generic node with its file, and no preset', async () => {
    const { project } = await loaded();
    const wf = project.state.nodes.wf;
    expect(wf.params as object).not.toHaveProperty('presetId');
    const sockets = workflowSocketsOf(wf.params);
    expect(sockets.inputs.map((i) => `${i.socket}:${i.type}`)).toEqual([
      'beauty:frames',
      'depth:frames',
      'normal:frames',
      'prompt:text',
      'negative:text',
    ]);
    expect(sockets.fed.map((f) => f.label)).toEqual(['previous frame of stylized']);
    expect(sockets.outputs.map((o) => `${o.socket}:${o.type}`)).toEqual(['stylized:frames']);
    // The same graph the preset ran, apart from the negative written into its input.
    const file = (wf.params as { graph: { apiJson: ComfyApiJson } }).graph.apiJson;
    expect(Object.keys(file)).toEqual(Object.keys(STYLIZED_REALISM_WORKFLOW));
  });

  it('keeps every wire: passes by kind, prompt and time by name, the rest on pass-input', async () => {
    const { project } = await loaded();
    expect(project.state.nodes.wf.inputs).toEqual({
      prompt: r('prompt'),
      time: r('time'),
      beauty: r('beauty'),
      depth: r('depth'),
      normal: r('normal'),
      // An ID pass has no socket in this file: kept, broken, never dropped.
      'pass-input': [r('ids')],
    });
  });

  it('the negative the preset read off the Prompt is in the file', async () => {
    const { project } = await loaded();
    const neg = workflowSocketsOf(project.state.nodes.wf.params).inputs.find(
      (i) => i.socket === 'negative',
    );
    expect(neg?.defaultValue).toBe('lowres, blurry');
  });

  it('wires off out read the first output: stylized for the preset, the file’s for an import', async () => {
    const { project } = await loaded();
    expect(project.state.nodes.stitch.inputs['pass-input']).toEqual([
      r('wf', 'stylized'),
      r('imported', 'clip'),
    ]);
    expect(project.state.outputs.render).toEqual(r('wf', 'stylized'));
    const imported = project.state.nodes.imported;
    expect(imported.params as object).not.toHaveProperty('presetId');
    expect((imported.params as { graph: { apiJson: unknown } }).graph.apiJson).toEqual(IMPORTED);
    expect(imported.inputs).toEqual({ prompt: r('prompt') });
  });

  it('the restore door accepts every migrated node, broken wires included', async () => {
    const { project } = await loaded();
    const ops: Op[] = Object.values(project.state.nodes).map((node) => ({
      type: 'addNode',
      nodeId: node.id,
      nodeType: node.type,
      params: node.params as Record<string, unknown>,
      inputs: node.inputs,
    }));
    const order = [
      'time',
      'prompt',
      'beauty',
      'depth',
      'normal',
      'ids',
      'wf',
      'imported',
      'stitch',
    ];
    ops.sort(
      (a, b) =>
        order.indexOf((a as { nodeId: string }).nodeId) -
        order.indexOf((b as { nodeId: string }).nodeId),
    );
    const state = applyOps(emptyDagState(), ops).next;
    expect(state.nodes.wf.inputs['pass-input']).toEqual([r('ids')]);
  });

  // #1718 — a node records the hash its pictures landed from (`madeFrom`), and nothing before
  // v31 recorded one. A migrated node must read "not generated yet": not current (that would
  // claim pictures nobody can trace to this file), and not stale (nothing changed under it).
  it('a migrated workflow reads not generated yet, through every later step and a save', async () => {
    const { storage, project } = await loaded();
    for (const id of ['wf', 'imported']) {
      expect((project.state.nodes[id].params as { madeFrom?: unknown }).madeFrom ?? null).toBe(
        null,
      );
      expect(workflowMadeState(project.state, id), id).toBe('unmade');
    }
    await saveProject(storage, project);
    const again = await loadProject(storage, project.id);
    expect(workflowMadeState(again.state, 'wf')).toBe('unmade');
  });

  it('saving and loading again changes nothing', async () => {
    const { storage, project } = await loaded();
    await saveProject(storage, project);
    const again = await loadProject(storage, project.id);
    expect(again.state).toEqual(project.state);
  });

  it('a file with no workflow node is only renumbered', () => {
    const out = migratePresetsToWorkflowFiles({
      formatVersion: WORKFLOW_FILES_FORMAT - 1,
      state: { nodes: { t: n('t', 'TimeSource') }, outputs: {} },
    }) as { formatVersion: number; state: { nodes: object } };
    expect(out.formatVersion).toBe(WORKFLOW_FILES_FORMAT);
    expect(out.state.nodes).toEqual({ t: n('t', 'TimeSource') });
  });

  it('the shipped file is the one every migrated preset gets, and it parses to these sockets', () => {
    expect(socketsOfWorkflow(STYLIZED_REALISM_WORKFLOW).problems).toEqual([]);
  });
});
