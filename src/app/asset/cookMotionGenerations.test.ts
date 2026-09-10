// #935 — the cook affordance's callee, the one thing that runs the resolver.
//
// The rows that carry the phase are the two about NOT firing: a cook with
// nothing pending must dispatch nothing, and a stale clip must keep its keys.
// Together they are the re-cook policy — explicit cook, and staleness that costs
// a director nothing until they ask for it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { __resetGeneratedClipsForTests } from '../../core/motiongen/generatedClipCache';
import {
  synthesiseBvh,
  STUB_UNIT_SCALE,
} from '../../core/motiongen/StubMotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationResult,
} from '../../core/motiongen/MotionGenerationCapability';
import type { Op } from '../../core/dag/types';
import { edgeTarget } from '../animate/graphNodes';

let failWith: string | null = null;
const calls: string[] = [];
const capability: MotionGenerationCapability = {
  id: 'stub',
  kind: 'stub',
  isAvailable: async () => true,
  async generate(request): Promise<MotionGenerationResult> {
    calls.push(request.prompt);
    if (failWith) throw new Error(failWith);
    return {
      jobId: 'job-1',
      bvh: synthesiseBvh(request),
      model: request.model,
      unitScale: STUB_UNIT_SCALE,
      worldOffsetXZ: null,
    };
  },
  cancel: async () => {},
};
vi.mock('../boot', () => ({ getMotionCapability: async () => capability }));

// Imported AFTER vi.mock so the module picks up the mocked boot.
import {
  cookMotionGenerations,
  hasStaleGenerations,
  motionCookOffer,
} from './cookMotionGenerations';
import { mintMotionGenerateOps } from './mintMotionGenerate';

function seed(): void {
  useDagStore.getState().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
}

/** Mint a producer + clip into the live store, as the affordance's sibling does. */
function mint(): { clipId: string } {
  const { state } = useDagStore.getState();
  const { ops, clipId } = mintMotionGenerateOps(state, {
    prompt: 'a slow walk',
    seed: 7,
    model: 'kimodo-base',
  });
  useDagStore.getState().dispatchAtomic(ops as Op[], 'user', 'mint');
  return { clipId };
}

const clipParams = (clipId: string) =>
  useDagStore.getState().state.nodes[clipId].params as {
    keyframes: unknown[];
    sourceHash: string;
  };

describe('cookMotionGenerations (#935)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
    useAssetErrorStore.getState().clearAll();
    calls.length = 0;
    failWith = null;
    seed();
  });

  it('cooks a pending producer and the keys land in the clip, in ONE dispatch', async () => {
    const { clipId } = mint();
    expect(clipParams(clipId).keyframes).toEqual([]);

    const spy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const out = await cookMotionGenerations();

    expect(out).toMatchObject({ generated: 1, failed: 0, baked: 1 });
    expect(clipParams(clipId).keyframes.length).toBeGreaterThan(0);
    expect(clipParams(clipId).sourceHash).not.toBe('');
    // ONE undo entry for the whole cook, however many clips it refreshed.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a cook with nothing pending dispatches NOTHING', async () => {
    mint();
    await cookMotionGenerations();

    const spy = vi.spyOn(useDagStore.getState(), 'dispatchAtomic');
    const out = await cookMotionGenerations();
    expect(out).toMatchObject({ generated: 0, baked: 0 });
    expect(spy).not.toHaveBeenCalled();
    // And the paid call was made once, not twice.
    expect(calls).toHaveLength(1);
    spy.mockRestore();
  });

  it('an edited producer goes stale and KEEPS its keys until the next cook', async () => {
    const { clipId } = mint();
    await cookMotionGenerations();
    const baked = clipParams(clipId).keyframes.length;
    expect(baked).toBeGreaterThan(0);
    expect(hasStaleGenerations()).toBe(false);

    const producerId = edgeTarget(useDagStore.getState().state.nodes[clipId], 'source')!;
    useDagStore
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: producerId, paramPath: 'seed', value: 99 }] as Op[],
        'user',
        'drag',
      );

    // Stale, and the motion is untouched — the whole of lock/freeze.
    expect(hasStaleGenerations()).toBe(true);
    expect(clipParams(clipId).keyframes.length).toBe(baked);

    await cookMotionGenerations();
    expect(hasStaleGenerations()).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('a refusal is reported and recorded, and never thrown', async () => {
    const { clipId } = mint();
    failWith = 'motion server unreachable';

    const out = await cookMotionGenerations();
    expect(out).toMatchObject({ generated: 0, failed: 1, baked: 0 });
    expect(Object.values(useAssetErrorStore.getState().errors)[0]!).toMatch(
      /motion server unreachable/,
    );
    // The clip is untouched, and the failure is terminal: a second cook does not
    // re-issue the request, so one unreachable server is not an unbounded stream.
    expect(clipParams(clipId).keyframes).toEqual([]);
    await cookMotionGenerations();
    expect(calls).toHaveLength(1);
  });

  it('hasStaleGenerations is false in a project with no producers at all', () => {
    expect(hasStaleGenerations()).toBe(false);
  });

  describe('motionCookOffer — the inspector affordance (#935)', () => {
    const offerFor = (clipId: string) => {
      const st = useDagStore.getState().state;
      return motionCookOffer(st, edgeTarget(st.nodes[clipId], 'source')!);
    };

    it('offers Generate on a pending producer', () => {
      const { clipId } = mint();
      // `stale: true` and the label is still the plain "Generate": the params are
      // behind the request, but nothing has been baked, so there is no previous
      // result the director would be trading away.
      expect(offerFor(clipId)).toEqual({
        label: 'Generate',
        disabled: false,
        status: 'pending',
        stale: true,
        // #1001 — nobody has edited a bone, so nothing is stranded. It stays
        // empty for every project until a director's first bone edit.
        strandedBones: [],
      });
    });

    it('says Up to date after a cook, and DISABLES itself', async () => {
      const { clipId } = mint();
      await cookMotionGenerations();
      expect(offerFor(clipId)).toMatchObject({ label: 'Up to date', disabled: true, stale: false });
    });

    it('offers a re-cook once the inputs move, and says the clip still plays', async () => {
      const { clipId } = mint();
      await cookMotionGenerations();
      const producerId = edgeTarget(useDagStore.getState().state.nodes[clipId], 'source')!;
      useDagStore
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: producerId, paramPath: 'seed', value: 99 }] as Op[],
          'user',
          'drag',
        );
      expect(offerFor(clipId)).toMatchObject({
        label: 'Re-cook (inputs changed)',
        disabled: false,
        stale: true,
      });
    });

    it('offers a retry after a refusal rather than going quiet', async () => {
      const { clipId } = mint();
      failWith = 'motion server unreachable';
      await cookMotionGenerations();
      expect(offerFor(clipId)).toMatchObject({
        label: 'Retry generation',
        disabled: false,
        status: 'failed',
      });
    });

    it('refuses a producer with no clip wired, rather than showing a button that does nothing', () => {
      const { clipId } = mint();
      const st = useDagStore.getState().state;
      const producerId = edgeTarget(st.nodes[clipId], 'source')!;
      useDagStore.getState().dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: producerId, socket: 'out' },
            to: { node: clipId, socket: 'source' },
          },
        ] as Op[],
        'user',
        'unwire',
      );
      expect(motionCookOffer(useDagStore.getState().state, producerId)).toEqual({
        label: 'No clip wired',
        disabled: true,
        strandedBones: [],
        status: null,
        stale: false,
      });
    });
  });
});
