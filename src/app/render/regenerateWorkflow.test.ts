// #1718 — Regenerate on a shot runs the stale still it starts from first, then the shot, each
// once, and records what each was made from. Counted on the stub: no real ComfyUI.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability } from '../../core/comfy';
import { scanBasherExports } from '../../core/comfy/basherExports';
import { writeBasherControllerValues } from '../../core/comfy/basherControllers';
import type { ComfyApiJson } from '../../core/comfy/comfyGraph';
import { __resetRegistryForTests } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import { MemoryStorage } from '../../core/storage';
import { workflowMadeState } from '../../nodes/comfyWorkflowMade';
import { registerAllNodes } from '../../nodes/registerAll';
import { compileWorkflowFrame } from '../../render/compileWorkflowFrame';
import { FIXTURE_META, STILL_FILE, stillAndShots } from '../../test-utils/stillAndShots';
import { useRenderJobsStore } from '../stores/renderJobsStore';
import { regenerateWorkflow } from './regenerateWorkflow';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useRenderJobsStore.setState({ inFlight: new Set() });
  useDagStore.getState().reset();
});

afterEach(() => {
  useDagStore.getState().reset();
});

/** A stub that logs, per submission, the name of the output the submitted workflow makes. */
function countingDeps() {
  const capability = new StubComfyUICapability();
  const submitted: string[] = [];
  const submitBatch = capability.submitBatch.bind(capability);
  capability.submitBatch = async (wf, inputs, onEvent) => {
    submitted.push(scanBasherExports(wf as ComfyApiJson)[0]?.name ?? '?');
    return submitBatch(wf, inputs, onEvent);
  };
  const storage = new MemoryStorage();
  return {
    deps: { capability, storage, compileWorkflow: compileWorkflowFrame({ storage }) },
    submitted,
  };
}

function setStillPrompt(text: string) {
  useDagStore.getState().dispatch(
    {
      type: 'setParam',
      nodeId: 'sw',
      paramPath: 'graph',
      value: {
        apiJson: writeBasherControllerValues(STILL_FILE, { '2': [text] }),
        meta: FIXTURE_META,
      },
    },
    'user',
    'prompt',
  );
}

const state = () => useDagStore.getState().state;

describe('#1718 — regenerating a shot', () => {
  it('runs the still first, then the shot, each once, and both read current after', async () => {
    useDagStore.getState().hydrate(stillAndShots());
    const { deps, submitted } = countingDeps();
    const result = await regenerateWorkflow('shot1', deps);
    expect(result.status).toBe('completed');
    // One still, then the shot's three frames. Shot 2 is not touched.
    expect(submitted).toEqual(['still', 'video', 'video', 'video']);
    expect(result.ran).toEqual(['sw', 'shot1']);
    expect(workflowMadeState(state(), 'sw')).toBe('current');
    expect(workflowMadeState(state(), 'shot1')).toBe('current');
    expect(workflowMadeState(state(), 'shot2')).toBe('unmade');
  });

  it("after the still's prompt changes the shot reads stale, and regenerating runs still then shot again", async () => {
    useDagStore.getState().hydrate(stillAndShots());
    const { deps, submitted } = countingDeps();
    await regenerateWorkflow('shot1', deps);
    setStillPrompt('a castle at dawn');
    expect(workflowMadeState(state(), 'shot1')).toBe('stale');
    submitted.length = 0;
    await regenerateWorkflow('shot1', deps);
    expect(submitted).toEqual(['still', 'video', 'video', 'video']);
    expect(workflowMadeState(state(), 'shot1')).toBe('current');
  });

  it('with the still current, regenerating the shot runs the shot alone', async () => {
    useDagStore.getState().hydrate(stillAndShots());
    const { deps, submitted } = countingDeps();
    await regenerateWorkflow('shot1', deps);
    submitted.length = 0;
    await regenerateWorkflow('shot1', deps);
    expect(submitted).toEqual(['video', 'video', 'video']);
  });

  it('stops at a failed run and records nothing for what did not land', async () => {
    useDagStore.getState().hydrate(stillAndShots());
    const { deps } = countingDeps();
    const failing = {
      ...deps,
      capability: new StubComfyUICapability({ errorQueue: [new Error('server gone')] }),
    };
    const result = await regenerateWorkflow('shot1', failing);
    expect(result.status).toBe('failed');
    expect(result.ran).toEqual([]);
    expect(workflowMadeState(state(), 'sw')).toBe('unmade');
    expect(workflowMadeState(state(), 'shot1')).toBe('unmade');
  });
});
