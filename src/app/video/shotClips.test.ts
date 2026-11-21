// #1717 — the Video space's one clip per shot: made from the shots, each reading generated / stale
// / not generated, and "Generate stale shots" runs exactly the shots that need it, each once, what
// they depend on first. Counted on the stub: no real ComfyUI.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability } from '../../core/comfy';
import type { ComfyApiJson } from '../../core/comfy/comfyGraph';
import { writeBasherControllerValues } from '../../core/comfy/basherControllers';
import { __resetRegistryForTests, applyOp, type DagState } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { MemoryStorage } from '../../core/storage';
import { registerAllNodes } from '../../nodes/registerAll';
import { compileWorkflowFrame, passFramePath } from '../../render/compileWorkflowFrame';
import { FIXTURE_META, STILL_FILE, VIDEO_FILE } from '../../test-utils/stillAndShots';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import type { RegenerateDeps } from '../render/regenerateWorkflow';
import { madeStateOf } from '../render/workflowMadeFrom';
import { buildSetActiveCameraOps } from '../setActiveCamera';
import { shotsOf } from '../shots';
import { useRenderJobsStore } from '../stores/renderJobsStore';
import { buildNewCompositionOps } from './newComposition';
import { generateShotWorkflows, generateStaleShots, useShotClipRunStore } from './shotClipActions';
import { makeShotClipsPlan, shotClipsOf, shotClipState, shotsToGenerate } from './shotClips';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useRenderJobsStore.setState({ inFlight: new Set() });
  useShotClipRunStore.setState({ current: null, phase: null, done: 0, total: 0, queued: [] });
  useDagStore.getState().reset();
});
afterEach(() => useDagStore.getState().reset());

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

/** The default scene, 3 s long, three cameras cut at 0, 1 and 2 s, and a composition. */
function film(): DagState {
  let s = buildDefaultDagState();
  s = apply(s, [{ type: 'setParam', nodeId: 'n_scene', paramPath: 'frameEnd', value: 180 }]);
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  for (const id of ['cam3', 'cam2', 'n_camera']) s = apply(s, buildSetActiveCameraOps(s, id) ?? []);
  const select = shotsOf(s, 3).selectId!;
  return apply(s, [
    {
      type: 'addNode',
      nodeId: 'cuts',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: select,
        paramPath: 'active',
        keyframes: [
          { time: 0, value: 'n_camera', easing: 'constant' },
          { time: 1, value: 'cam2', easing: 'constant' },
          { time: 2, value: 'cam3', easing: 'constant' },
        ],
      },
    },
    ...buildNewCompositionOps('comp', 'Film'),
  ]);
}

const state = () => useDagStore.getState().state;

/** The stub, with every compiled frame logged by the workflow it belongs to (its output path), and
 *  a `prepare` that writes placeholder pass files where the run reads them (no viewport here). */
function countingDeps() {
  const capability = new StubComfyUICapability();
  const storage = new MemoryStorage();
  const compile = compileWorkflowFrame({ storage });
  const compiled: string[] = [];
  const prepared: string[] = [];
  const deps: RegenerateDeps = {
    capability,
    storage,
    compileWorkflow: async (args) => {
      compiled.push(args.workflowOutputPath);
      return compile(args);
    },
    prepare: async (id) => {
      prepared.push(id);
      const p = state().nodes[id].params as {
        frameStart: number;
        frameEnd: number;
        outputPath: string;
      };
      for (let f = p.frameStart; f <= p.frameEnd; f++) {
        for (const kind of ['beauty', 'depth', 'normal']) {
          await storage.write(passFramePath(p.outputPath, kind, f), Uint8Array.of(f & 0xff));
        }
      }
    },
  };
  return { deps, capability, compiled, prepared };
}

describe('#1717 — make shot clips', () => {
  it('gives each shot a workflow over its frames, fed by the passes, and a layer where the shot is', () => {
    const s = film();
    const plan = makeShotClipsPlan(s, 'comp');
    expect(plan.reason).toBeUndefined();
    expect(plan.made).toEqual([0, 1, 2]);
    const after = apply(s, plan.ops);
    const clips = shotClipsOf(after, 'comp');
    expect(clips.map((c) => c.shot.cameraId)).toEqual(['n_camera', 'cam2', 'cam3']);
    for (const [i, clip] of clips.entries()) {
      const wf = after.nodes[clip.workflowId!];
      expect(wf.type).toBe('ComfyUIWorkflow');
      const p = wf.params as { frameStart: number; frameEnd: number; outputPath: string };
      expect([p.frameStart, p.frameEnd]).toEqual([i * 30, i * 30 + 29]);
      expect(p.outputPath.startsWith('renders/shots/')).toBe(true);
      // Each pass the file reads, wired, filming through the scene's camera switch.
      for (const pass of ['beauty', 'depth', 'normal']) {
        const ref = wf.inputs[pass] as { node: string };
        const passNode = after.nodes[ref.node];
        expect((passNode.inputs.camera as { node: string }).node).toBe(shotsOf(after, 3).selectId);
      }
      const layer = after.nodes[clip.layerId!].params as {
        name: string;
        startFrame: number;
        outPoint: number;
      };
      expect([layer.name, layer.startFrame, layer.outPoint]).toEqual([`Shot ${i + 1}`, i * 30, 30]);
    }
    // The passes are made once and shared.
    const passIds = new Set(
      clips.map((c) => (after.nodes[c.workflowId!].inputs.beauty as { node: string }).node),
    );
    expect(passIds.size).toBe(1);
    expect(clips.map((c) => shotClipState(after, c))).toEqual(['unmade', 'unmade', 'unmade']);
  });

  it('is idempotent: shots that have their clip get nothing more', () => {
    const s = apply(film(), makeShotClipsPlan(film(), 'comp').ops);
    expect(makeShotClipsPlan(s, 'comp')).toEqual({ ops: [], made: [] });
  });
});

describe('#1717 — Generate stale shots', () => {
  it("generates all, then after shot 2's camera moves runs shot 2 alone, once", async () => {
    const s = film();
    useDagStore.getState().hydrate(apply(s, makeShotClipsPlan(s, 'comp').ops));
    const { deps, capability, compiled, prepared } = countingDeps();
    const ids = shotClipsOf(state(), 'comp').map((c) => c.workflowId!);

    expect(shotsToGenerate(state(), 'comp')).toEqual(ids);
    const first = await generateStaleShots('comp', deps);
    expect(first.failed).toBeUndefined();
    expect(first.ran).toEqual(ids);
    expect(capability.submissions).toHaveLength(90);
    expect(ids.map((id) => madeStateOf(state(), id))).toEqual(['current', 'current', 'current']);

    // Move shot 2's camera. Only shot 2 needs generating.
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: 'cam2', paramPath: 'position', value: [25, 1, 0] },
        'user',
        'move cam2',
      );
    expect(ids.map((id) => madeStateOf(state(), id))).toEqual(['current', 'stale', 'current']);
    expect(shotsToGenerate(state(), 'comp')).toEqual([ids[1]]);

    capability.submissions.length = 0;
    compiled.length = 0;
    prepared.length = 0;
    const second = await generateStaleShots('comp', deps);
    expect(second.ran).toEqual([ids[1]]);
    expect(prepared).toEqual([ids[1]]);
    // One run of shot 2: each of its 30 frames sent once, nothing from shots 1 and 3.
    const shot2Path = (state().nodes[ids[1]].params as { outputPath: string }).outputPath;
    expect(capability.submissions).toHaveLength(30);
    expect(new Set(compiled)).toEqual(new Set([shot2Path]));
    expect(ids.map((id) => madeStateOf(state(), id))).toEqual(['current', 'current', 'current']);
  });

  it('runs a still two shots share once, before either shot', async () => {
    let s = film();
    s = apply(s, [
      {
        type: 'addNode',
        nodeId: 'sw',
        nodeType: 'ComfyUIWorkflow',
        params: {
          graph: { apiJson: STILL_FILE, meta: FIXTURE_META },
          frameStart: 0,
          frameEnd: 0,
          outputPath: 'renders/generated/still',
        },
      },
      ...[0, 1].map(
        (i): Op => ({
          type: 'addNode',
          nodeId: `v${i + 1}`,
          nodeType: 'ComfyUIWorkflow',
          params: {
            graph: { apiJson: VIDEO_FILE, meta: FIXTURE_META },
            frameStart: i * 30,
            frameEnd: i * 30 + 2,
            outputPath: `renders/v${i + 1}/video`,
          },
        }),
      ),
      ...['v1', 'v2'].map(
        (id): Op => ({
          type: 'connect',
          from: { node: 'sw', socket: 'still' },
          to: { node: id, socket: 'first_frame' },
        }),
      ),
    ]);
    useDagStore.getState().hydrate(s);
    const { deps, capability } = countingDeps();
    const result = await generateShotWorkflows(['v1', 'v2'], { ...deps, prepare: undefined });
    expect(result.ran).toEqual(['sw', 'v1', 'v2']);
    expect(capability.submissions.map((x) => x[0])).toEqual([
      'still',
      'video',
      'video',
      'video',
      'video',
      'video',
      'video',
    ]);

    // The still's prompt changes: both shots read stale, and the still runs once more, first.
    useDagStore.getState().dispatch(
      {
        type: 'setParam',
        nodeId: 'sw',
        paramPath: 'graph',
        value: {
          apiJson: writeBasherControllerValues(STILL_FILE as ComfyApiJson, { '2': ['rain'] }),
          meta: FIXTURE_META,
        },
      },
      'user',
      'prompt',
    );
    expect(['v1', 'v2'].map((id) => madeStateOf(state(), id))).toEqual(['stale', 'stale']);
    capability.submissions.length = 0;
    const again = await generateShotWorkflows(['v1', 'v2'], { ...deps, prepare: undefined });
    expect(again.ran).toEqual(['sw', 'v1', 'v2']);
    expect(capability.submissions.filter((x) => x[0] === 'still')).toHaveLength(1);
  });

  it('a current shot sends ComfyUI nothing', async () => {
    const s = film();
    useDagStore.getState().hydrate(apply(s, makeShotClipsPlan(s, 'comp').ops));
    const { deps, capability } = countingDeps();
    await generateStaleShots('comp', deps);
    capability.submissions.length = 0;
    const result = await generateStaleShots('comp', deps);
    expect(result.ran).toEqual([]);
    expect(capability.submissions).toHaveLength(0);
  });
});
