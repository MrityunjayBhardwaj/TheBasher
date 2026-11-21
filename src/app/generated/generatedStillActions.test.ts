// #1718 — the Generated tab's road end to end, without a viewport or a server: Generate (four
// variants), Keep, Use as first frame of Shot 1, Regenerate the shot; then the prompt changes, the
// shot reads stale, and Regenerate runs the still first, then the shot. Counted on the stub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability } from '../../core/comfy';
import { __resetRegistryForTests } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import { MemoryStorage } from '../../core/storage';
import { workflowMadeState } from '../../nodes/comfyWorkflowMade';
import { registerAllNodes } from '../../nodes/registerAll';
import { compileWorkflowFrame } from '../../render/compileWorkflowFrame';
import { stillAndShots } from '../../test-utils/stillAndShots';
import { useGeneratedStillStore } from '../stores/generatedStillStore';
import { useRenderJobsStore } from '../stores/renderJobsStore';
import {
  generateStillVariants,
  keepStillVariant,
  regenerateShot,
  setStillPrompt,
  wireStillAsFirstFrame,
} from './generatedStillActions';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useRenderJobsStore.setState({ inFlight: new Set() });
  useDagStore.getState().reset();
  useGeneratedStillStore.getState().reset();
});

afterEach(() => useDagStore.getState().reset());

const state = () => useDagStore.getState().state;

describe('#1718 — Generated: a still made for a shot, used as its first frame', () => {
  it('changing the still prompt marks the shot stale; regenerating runs the still, then the shot', async () => {
    useDagStore.getState().hydrate(stillAndShots({ wired: false }));
    const capability = new StubComfyUICapability();
    const storage = new MemoryStorage();
    const deps = { capability, storage, compileWorkflow: compileWorkflowFrame({ storage }) };
    const render = async () => ({
      bytes: Uint8Array.of(137, 80, 78, 71, 9),
      width: 64,
      height: 36,
    });

    const variants = await generateStillVariants('sw', { start: 0 }, { render, deps });
    expect(variants.map((v) => v.seed)).toEqual([7, 8, 9, 10]);
    expect(useGeneratedStillStore.getState().variants).toHaveLength(4);
    expect(capability.submissions).toEqual([['still'], ['still'], ['still'], ['still']]);

    expect(await keepStillVariant('sw', variants[2], { storage })).toBe(true);
    expect(workflowMadeState(state(), 'sw')).toBe('current');

    wireStillAsFirstFrame('sw', { node: 'shot1', socket: 'first_frame' });
    expect(state().nodes.shot1.inputs.first_frame).toEqual({ node: 'sw', socket: 'still' });

    capability.submissions.length = 0;
    await regenerateShot('shot1', deps);
    // The kept still is current, so only the shot runs (its three frames).
    expect(capability.submissions).toEqual([['video'], ['video'], ['video']]);
    expect(workflowMadeState(state(), 'shot1')).toBe('current');

    setStillPrompt('sw', 'a castle at dawn');
    expect(workflowMadeState(state(), 'sw')).toBe('stale');
    expect(workflowMadeState(state(), 'shot1')).toBe('stale');
    expect(workflowMadeState(state(), 'shot2')).toBe('unmade');

    capability.submissions.length = 0;
    const result = await regenerateShot('shot1', deps);
    expect(result?.status).toBe('completed');
    expect(capability.submissions).toEqual([['still'], ['video'], ['video'], ['video']]);
    expect(workflowMadeState(state(), 'sw')).toBe('current');
    expect(workflowMadeState(state(), 'shot1')).toBe('current');
  });

  it('a Generate with no render says so instead of running', async () => {
    useDagStore.getState().hydrate(stillAndShots({ wired: false }));
    const capability = new StubComfyUICapability();
    const storage = new MemoryStorage();
    const variants = await generateStillVariants(
      'sw',
      { start: 0 },
      {
        render: async () => null,
        deps: { capability, storage, compileWorkflow: compileWorkflowFrame({ storage }) },
      },
    );
    expect(variants).toEqual([]);
    expect(capability.submissions).toEqual([]);
    expect(useGeneratedStillStore.getState().status).toBe('error');
    expect(useGeneratedStillStore.getState().message).toMatch(/could not be rendered/);
  });
});
