// #1718 — the Generated tab's graph edits and runs: four variants with distinct seeds, keeping
// one, "Use as first frame of Shot N" as exactly one wire, and the shot's video workflows read
// off its frames. Counted on the stub: no real ComfyUI.

import { beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability, type ComfyWorkflowJson } from '../../core/comfy';
import { scanBasherControllers } from '../../core/comfy/basherControllers';
import type { ComfyApiJson } from '../../core/comfy/comfyGraph';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { NodeRef, Op } from '../../core/dag/types';
import { MemoryStorage } from '../../core/storage';
import { madeStateOf as workflowMadeState } from '../render/workflowMadeFrom';
import { registerAllNodes } from '../../nodes/registerAll';
import { compileWorkflowFrame } from '../../render/compileWorkflowFrame';
import { VIDEO_FILE, stillAndShots } from '../../test-utils/stillAndShots';
import {
  feedRenderOps,
  firstFrameInputOf,
  firstFrameOps,
  keepVariantPlan,
  promptOps,
  renderPathFor,
  runStillVariants,
  shotVideoWorkflows,
  stillWorkflowsOf,
} from './generatedStill';
import { socketsOfWorkflow } from '../../core/comfy/workflowSockets';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

/** Shot 1 is frames 0..2 (0 s to 0.1 s at 30 fps), shot 2 frames 3..5. */
const SHOT_1 = { start: 0, end: 0.1 };
const SHOT_2 = { start: 0.1, end: 0.2 };

const RENDER = Uint8Array.of(137, 80, 78, 71, 1);

/** The fixture, unwired, with Basher's render fed into the still. */
async function fed(): Promise<{ state: DagState; storage: MemoryStorage }> {
  const storage = new MemoryStorage();
  const path = renderPathFor('sw', RENDER);
  await storage.write(path, RENDER);
  const s = stillAndShots({ wired: false });
  return { state: apply(s, feedRenderOps(s, 'sw', path, { width: 64, height: 36 })), storage };
}

function countingStub() {
  const capability = new StubComfyUICapability();
  const seeds: unknown[] = [];
  const submitBatch = capability.submitBatch.bind(capability);
  capability.submitBatch = async (wf: ComfyWorkflowJson, inputs, onEvent) => {
    const seed = scanBasherControllers(wf as ComfyApiJson).find((c) => c.name === 'seed');
    seeds.push(seed?.defaultValue);
    return submitBatch(wf, inputs, onEvent);
  };
  return { capability, seeds };
}

describe('#1718 — four variants of a still', () => {
  it('runs the still four times with four distinct seeds, each to its own picture', async () => {
    const { state, storage } = await fed();
    const { capability, seeds } = countingStub();
    const variants = await runStillVariants(state, 'sw', {
      capability,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
    });
    expect(variants.map((v) => v.seed)).toEqual([7, 8, 9, 10]);
    expect(seeds).toEqual([7, 8, 9, 10]);
    expect(new Set(variants.map((v) => v.path)).size).toBe(4);
    const bytes = await Promise.all(variants.map((v) => storage.read(v.path)));
    expect(new Set(bytes.map((b) => Array.from(b).join(','))).size).toBe(4);
    // Making variants changes nothing in the graph.
    expect(workflowMadeState(state, 'sw')).toBe('unmade');
  });

  it('keeping one writes its seed into the file, puts its picture where the still lands, and reads current', async () => {
    const { state, storage } = await fed();
    const { capability } = countingStub();
    const variants = await runStillVariants(state, 'sw', {
      capability,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
    });
    const plan = keepVariantPlan(state, 'sw', variants.find((v) => v.seed === 9)!);
    if (!plan.ok) throw new Error(plan.reason);
    const kept = apply(state, plan.ops);
    const graph = (kept.nodes.sw.params as { graph: { apiJson: ComfyApiJson } }).graph;
    const seed = socketsOfWorkflow(graph.apiJson).inputs.find((i) => i.socket === 'seed');
    expect(seed?.defaultValue).toBe(9);
    expect(workflowMadeState(kept, 'sw')).toBe('current');
    expect(plan.stillPath).toBe('renders/generated/still_0000.png');
    // The picture a fresh run of the kept still makes is the variant's.
    const fresh = await runStillVariants(kept, 'sw', {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
    });
    expect(await storage.read(fresh[0].path)).toEqual(
      await storage.read(variants.find((v) => v.seed === 9)!.path),
    );
  });

  it('the prompt box edits the still workflow and leaves it stale once it was made', async () => {
    const { state, storage } = await fed();
    const [first] = await runStillVariants(state, 'sw', {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
    });
    const plan = keepVariantPlan(state, 'sw', first);
    if (!plan.ok) throw new Error(plan.reason);
    const kept = apply(state, plan.ops);
    const edited = apply(kept, promptOps(kept, 'sw', 'a castle at dawn'));
    expect(workflowMadeState(edited, 'sw')).toBe('stale');
    expect(promptOps(edited, 'sw', 'a castle at dawn')).toEqual([]);
  });
  it('a variant made before the prompt changed is not kept as current', async () => {
    const { state, storage } = await fed();
    const variants = await runStillVariants(state, 'sw', {
      capability: new StubComfyUICapability(),
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
    });
    const edited = apply(state, promptOps(state, 'sw', 'a castle at dawn'));
    const plan = keepVariantPlan(edited, 'sw', variants[0]);
    expect(plan.ok).toBe(false);
    expect(plan.ok ? '' : plan.reason).toMatch(/Generate again/);
  });
});

describe("#1718 — Basher's render into the still", () => {
  it('wires one image clip into the render input, and a new render moves its source', async () => {
    const { state } = await fed();
    const ref = state.nodes.sw.inputs.render as NodeRef;
    expect(state.nodes[ref.node].type).toBe('MediaClip');
    expect(
      feedRenderOps(state, 'sw', renderPathFor('sw', RENDER), { width: 64, height: 36 }),
    ).toEqual([]);
    const other = renderPathFor('sw', Uint8Array.of(1, 2, 3));
    const ops = feedRenderOps(state, 'sw', other, { width: 64, height: 36 });
    expect(ops).toEqual([{ type: 'setParam', nodeId: ref.node, paramPath: 'src', value: other }]);
  });
});

describe('#1718 — a shot and its video workflow', () => {
  it("a shot's video workflows are the ones whose first frame is in the shot", () => {
    const s = stillAndShots();
    expect(shotVideoWorkflows(s, SHOT_1).map((w) => w.id)).toEqual(['shot1']);
    expect(shotVideoWorkflows(s, SHOT_2).map((w) => w.id)).toEqual(['shot2']);
    expect(shotVideoWorkflows(s, SHOT_1)[0].firstFrameInput).toBe('first_frame');
  });

  it('the still workflow is offered as a still, and the video workflows are not', () => {
    expect(stillWorkflowsOf(stillAndShots()).map((w) => w.id)).toEqual(['sw']);
  });

  it('the first-frame input is the one named so, else the only still input, else none', () => {
    const two = structuredClone(VIDEO_FILE);
    two['9'] = { class_type: 'basher_controller', inputs: { name: 'style', kind: 'image' } };
    expect(firstFrameInputOf(socketsOfWorkflow(two))).toBe('first_frame');
    const unnamed = structuredClone(two);
    (unnamed['1'].inputs as { name: string }).name = 'picture';
    expect(firstFrameInputOf(socketsOfWorkflow(unnamed))).toBeNull();
    const one = structuredClone(VIDEO_FILE);
    (one['1'].inputs as { name: string }).name = 'picture';
    expect(firstFrameInputOf(socketsOfWorkflow(one))).toBe('picture');
  });

  it('Use as first frame makes exactly one wire, into the chosen still input', () => {
    let s = stillAndShots({ wired: false });
    // Something else held the input before: the still replaces it rather than joining it.
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'old',
      nodeType: 'MediaClip',
      params: { src: 'renders/old.png', mediaKind: 'image' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'old', socket: 'out' },
      to: { node: 'shot1', socket: 'first_frame' },
    }).next;
    const target = { node: 'shot1', socket: 'first_frame' };
    s = apply(s, firstFrameOps(s, 'sw', target));
    expect(s.nodes.shot1.inputs.first_frame).toEqual({ node: 'sw', socket: 'still' });
    // Wires out of the still: exactly one, and none into the other shot.
    const fromStill = Object.values(s.nodes).flatMap((n) =>
      Object.entries(n.inputs)
        .flatMap(([socket, b]) => (Array.isArray(b) ? b : [b]).map((r) => ({ n: n.id, socket, r })))
        .filter((e) => e.r.node === 'sw'),
    );
    expect(fromStill).toEqual([
      { n: 'shot1', socket: 'first_frame', r: { node: 'sw', socket: 'still' } },
    ]);
    // Asking again adds nothing.
    expect(firstFrameOps(s, 'sw', target)).toEqual([]);
  });
});
