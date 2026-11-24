// GeneratePanel — the director's generate surface, tested where it has decisions.
//
// This project has no React Testing Library (W2 acceptance gate #15 forbids new
// external deps), so the shell's JSX is e2e's business and everything the shell
// DECIDES lives in exported functions that are tested here directly. That split
// is the reason `canSubmit`, `acceptsImage` and `runGeneration` exist as
// functions at all.
//
// 🔑 THE TEST THAT CARRIES THE POINT IS `every kind the panel offers has a road
// of its own`. It is not a routing smoke test: it walks GENERATION_KINDS — the
// list the director actually reads — and asserts the map from kinds to surfaces
// is total AND injective. A kind added to the menu without a branch in
// `runGeneration` falls through to the model road, two menu items then share a
// surface, and the button silently does the wrong thing while looking correct.
// That is the exact shape of lying label this track keeps finding, so it is the
// shape the guard is built to catch. It earned its keep when `character` was
// added: the branch was written because this test went red without it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` because `vi.mock`'s factory is lifted above every import, so a
// spy declared as a plain top-level const is still in its temporal dead zone
// when the factory runs.
const { generateMotionAsNode, startModelGeneration, storeReferenceImage } = vi.hoisted(() => ({
  generateMotionAsNode: vi.fn(async (_prompt: string) => ({
    ok: true as const,
    clipId: 'n_clip',
    skeletonId: 'n_skel',
  })),
  // #1720 — both mesh kinds take the Model generate road; they differ in `rig`.
  startModelGeneration: vi.fn(async (_ask: unknown) => ({
    ok: true as const,
    nodeId: 'n_modelgen',
    added: 4,
  })),
  storeReferenceImage: vi.fn(async (_image: unknown) => 'abc123.png'),
}));

// #935 — the panel's motion road is the NODE road now: it mints a producer and
// cooks it, so the clip it leaves behind can be re-cooked when the curve moves.
vi.mock('./asset/generateMotionAsNode', () => ({ generateMotionAsNode }));
vi.mock('./asset/generateModel', () => ({ startModelGeneration, storeReferenceImage }));

// Imported AFTER the mocks so the module under test picks them up.
import {
  GENERATION_KINDS,
  acceptsImage,
  canSubmit,
  modelCostLine,
  modelRunProgress,
  runGeneration,
  type GenerationKind,
  motionSaveOffer,
} from './GeneratePanel';
import { savedMotionName } from './asset/saveGeneratedMotion';

/**
 * Which road a kind took, named here rather than derived from the module under test — an
 * expectation derived from its producer cannot fail. The two mesh kinds share one surface and
 * are told apart by the one argument that separates them.
 */
function roadTaken(): string[] {
  const hit: string[] = [];
  if (generateMotionAsNode.mock.calls.length > 0) hit.push('motion');
  for (const [ask] of startModelGeneration.mock.calls as unknown as [{ rig: boolean }][])
    hit.push(ask.rig ? 'model+rig' : 'model');
  return hit;
}

const IMAGE = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };

beforeEach(() => {
  generateMotionAsNode.mockClear();
  startModelGeneration.mockClear();
  storeReferenceImage.mockClear();
});

describe('canSubmit', () => {
  it('refuses a blank prompt, so the enforcing schema is never asked a question it must reject', () => {
    expect(canSubmit('', false)).toBe(false);
    expect(canSubmit('   \t\n ', false)).toBe(false);
  });

  it('refuses while a generation is in flight, so one press cannot become two', () => {
    expect(canSubmit('a figure walks', true)).toBe(false);
  });

  it('allows a non-blank prompt when idle', () => {
    expect(canSubmit('a figure walks', false)).toBe(true);
  });

  it('an IMAGE alone is enough, because the request carries no prompt beside it', () => {
    // `ImageModelRequest` has no `prompt` field at all — the image replaces the
    // text. Requiring both would demand a sentence the request cannot send.
    expect(canSubmit('', false, 'model', true)).toBe(true);
    expect(canSubmit('', false, 'character', true)).toBe(true);
  });

  it('an image does NOT unlock a kind that cannot carry one', () => {
    // Motion has no image road. If the slot were ever rendered for it, the
    // button must still refuse rather than send a request that gets dropped.
    expect(canSubmit('', false, 'motion', true)).toBe(false);
  });

  it('busy still wins over an attached image', () => {
    expect(canSubmit('', true, 'model', true)).toBe(false);
  });
});

describe('acceptsImage', () => {
  it('offers the slot exactly where a road exists for it', () => {
    expect(acceptsImage('model')).toBe(true);
    expect(acceptsImage('character')).toBe(true);
    expect(acceptsImage('motion')).toBe(false);
  });

  it('every kind gets an answer, so a new kind cannot be undecided', () => {
    for (const { kind } of GENERATION_KINDS) expect(typeof acceptsImage(kind)).toBe('boolean');
  });
});

describe('runGeneration', () => {
  it('sends the TRIMMED prompt, so the callee sees what a scripted caller would send', async () => {
    await runGeneration('motion', '  a figure walks forward  ');
    expect(generateMotionAsNode).toHaveBeenCalledWith('a figure walks forward');
  });

  it('every kind the panel offers has a road of its own', async () => {
    const routed = new Map<GenerationKind, string[]>();
    for (const { kind } of GENERATION_KINDS) {
      generateMotionAsNode.mockClear();
      startModelGeneration.mockClear();
      await runGeneration(kind, 'a prompt');
      routed.set(kind, roadTaken());
    }
    // Total: no kind reaches zero roads. Single: no kind reaches two.
    for (const [kind, hit] of routed) expect([kind, hit]).toEqual([kind, [expect.any(String)]]);
    // Injective: no two menu items land on the same road.
    const hits = [...routed.values()].flat();
    expect(new Set(hits).size).toBe(hits.length);
    expect(new Set(hits)).toEqual(new Set(['motion', 'model', 'model+rig']));
  });

  it('a prompt mints a Model generate with that prompt and no references', async () => {
    await runGeneration('model', 'a chair', undefined, { count: 3 });
    expect(startModelGeneration).toHaveBeenCalledWith({
      prompt: 'a chair',
      references: [],
      rig: false,
      count: 3,
    });
  });

  it('defaults to four variants (design board 13b)', async () => {
    await runGeneration('model', 'a chair');
    expect(startModelGeneration).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }));
  });

  it('an image becomes the reference, and the prompt is not smuggled in beside it', async () => {
    await runGeneration('model', 'ignored text', IMAGE);
    expect(storeReferenceImage).toHaveBeenCalledWith(IMAGE);
    const [ask] = startModelGeneration.mock.calls[0] as [Record<string, unknown>];
    expect(ask).toMatchObject({ prompt: '', references: ['abc123.png'] });
  });

  it('the character road takes an image too — a reference picture can come back rigged', async () => {
    await runGeneration('character', '', IMAGE);
    const [ask] = startModelGeneration.mock.calls[0] as [Record<string, unknown>];
    expect(ask).toMatchObject({ prompt: '', references: ['abc123.png'], rig: true });
  });

  it('carries a refusal back with its reason rather than swallowing it', async () => {
    startModelGeneration.mockResolvedValueOnce({
      ok: false,
      reason: 'no recorded licence verdict',
    } as never);
    await expect(runGeneration('model', 'a chair')).resolves.toEqual({
      ok: false,
      reason: 'no recorded licence verdict',
    });
  });

  it('an image that cannot be stored is a failure with its reason, never a throw', async () => {
    storeReferenceImage.mockRejectedValueOnce(new Error('there is no open project'));
    await expect(runGeneration('model', '', IMAGE)).resolves.toMatchObject({ ok: false });
    expect(startModelGeneration).not.toHaveBeenCalled();
  });

  it('reports success without inventing a payload the panel does not use', async () => {
    await expect(runGeneration('motion', 'a figure waves')).resolves.toEqual({ ok: true });
  });
});

describe('the offer to save a generated clip (#819)', () => {
  it('offers nothing before anything has been generated', () => {
    expect(motionSaveOffer(null, null)).toEqual({ kind: 'none' });
  });

  it('offers the name the save would actually use, not the raw prompt', () => {
    const long = 'a figure walks forward and then turns left and waves at the camera slowly';
    const offer = motionSaveOffer({ clipId: 'c', name: long, bvh: 'x', model: 'm' }, null);
    // Showing the prompt and saving something else would make the row a
    // description of a file that does not exist.
    expect(offer).toEqual({ kind: 'offer', name: savedMotionName(long) });
  });

  it('names the FOLDER a director will look for once it is saved', () => {
    expect(motionSaveOffer(null, 'user-imports/walk/walk.bvh')).toEqual({
      kind: 'saved',
      name: 'walk',
    });
  });

  it('offers the new clip rather than the old confirmation when both could apply', () => {
    // A generation clears `savedPath`, but the pair is checked here too: the
    // pending clip is the live thing, and a stale "saved" beside it would
    // attach the message to the wrong motion.
    expect(
      motionSaveOffer(
        { clipId: 'c', name: 'run', bvh: 'x', model: 'm' },
        'user-imports/walk/walk.bvh',
      ),
    ).toEqual({ kind: 'offer', name: 'run' });
  });
});

describe('the cost, shown before a model run (#1720)', () => {
  const base = { modelVersion: 'v3.1-20260211', withImage: false, count: 4, rig: false };

  it('with no key, says FREE first — the stub answers — then what Tripo would charge', () => {
    const line = modelCostLine({ ...base, hasKey: false });
    expect(line.startsWith('Free')).toBe(true);
    expect(line).toContain('≈ 80 Tripo credits (estimate: 4 × 20)');
  });

  it('with a key, is the estimate, labelled one', () => {
    expect(modelCostLine({ ...base, hasKey: true })).toBe('≈ 80 Tripo credits (estimate: 4 × 20)');
  });

  it('an image costs more per run, by the table', () => {
    expect(modelCostLine({ ...base, hasKey: true, withImage: true, count: 1 })).toContain('1 × 30');
  });

  it('a rigged run says the rig is not priced rather than inventing a number', () => {
    expect(modelCostLine({ ...base, hasKey: true, rig: true })).toContain('+ rigging (not priced)');
  });
});

describe('the progress line for a model run', () => {
  it('says which variant of how many, and what the provider is doing', () => {
    expect(modelRunProgress({ total: 4, done: 1, label: 'running', percent: 40 })).toEqual({
      label: 'Variant 2 of 4 · running',
      percent: 40,
    });
  });

  it('never claims a variant past the last', () => {
    expect(modelRunProgress({ total: 4, done: 4, label: 'x', percent: 0 })?.label).toContain(
      'Variant 4 of 4',
    );
  });

  it('nothing to show without a run', () => {
    expect(modelRunProgress(null)).toBeNull();
  });
});
