// GeneratePanel — the director's generate surface, tested where it has decisions.
//
// This project has no React Testing Library (W2 acceptance gate #15 forbids new
// external deps), so the shell's JSX is e2e's business and everything the shell
// DECIDES lives in two exported functions that are tested here directly. That
// split is the reason `canSubmit` and `runGeneration` exist as functions at all.
//
// 🔑 THE TEST THAT CARRIES THE POINT IS `every kind the panel offers has a road
// of its own`. It is not a routing smoke test: it walks GENERATION_KINDS — the
// list the director actually reads — and asserts the map from kinds to surfaces
// is total AND injective. A kind added to the menu without a branch in
// `runGeneration` falls through to the model road, two menu items then share a
// surface, and the button silently does the wrong thing while looking correct.
// That is the exact shape of lying label this track keeps finding, so it is the
// shape the guard is built to catch. Falsified by adding a third kind to the
// list and observing the red (see the commit that introduced this file).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` because `vi.mock`'s factory is lifted above every import, so a
// spy declared as a plain top-level const is still in its temporal dead zone
// when the factory runs.
const { generateMotionIntoScene, generateModelFromText } = vi.hoisted(() => ({
  generateMotionIntoScene: vi.fn(async (_prompt: string) => ({
    ok: true as const,
    clipId: 'n_clip',
    skeletonId: 'n_skel',
  })),
  generateModelFromText: vi.fn(async (_prompt: string) => ({
    ok: true as const,
    opfsPath: 'user-imports/x/model.glb',
    taskId: 't1',
  })),
}));

vi.mock('./asset/generateMotion', () => ({ generateMotionIntoScene }));
vi.mock('./asset/generateModel', () => ({ generateModelFromText }));

// Imported AFTER the mocks so the module under test picks them up.
import { GENERATION_KINDS, canSubmit, runGeneration, type GenerationKind } from './GeneratePanel';

/** The two app-layer surfaces, named here rather than derived from the module
 *  under test — an expectation derived from its producer cannot fail. */
const SURFACES = { motion: generateMotionIntoScene, model: generateModelFromText };

beforeEach(() => {
  generateMotionIntoScene.mockClear();
  generateModelFromText.mockClear();
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
});

describe('runGeneration', () => {
  it('sends the TRIMMED prompt, so the callee sees what a scripted caller would send', async () => {
    await runGeneration('motion', '  a figure walks forward  ');
    expect(generateMotionIntoScene).toHaveBeenCalledWith('a figure walks forward');
  });

  it('every kind the panel offers has a road of its own', async () => {
    const routed = new Map<GenerationKind, string[]>();
    for (const { kind } of GENERATION_KINDS) {
      generateMotionIntoScene.mockClear();
      generateModelFromText.mockClear();
      await runGeneration(kind, 'a prompt');
      routed.set(
        kind,
        Object.entries(SURFACES)
          .filter(([, fn]) => fn.mock.calls.length > 0)
          .map(([name]) => name),
      );
    }
    // Total: no kind reaches zero surfaces. Single: no kind reaches two.
    for (const [kind, hit] of routed) expect([kind, hit]).toEqual([kind, [expect.any(String)]]);
    // Injective: no two menu items land on the same surface.
    const hits = [...routed.values()].flat();
    expect(new Set(hits).size).toBe(hits.length);
    // And between them they use every surface there is.
    expect(new Set(hits)).toEqual(new Set(Object.keys(SURFACES)));
  });

  it('carries a refusal back with its reason rather than swallowing it', async () => {
    generateModelFromText.mockResolvedValueOnce({
      ok: false,
      reason: 'no recorded licence verdict',
    } as never);
    await expect(runGeneration('model', 'a chair')).resolves.toEqual({
      ok: false,
      reason: 'no recorded licence verdict',
    });
  });

  it('reports success without inventing a payload the panel does not use', async () => {
    await expect(runGeneration('motion', 'a figure waves')).resolves.toEqual({ ok: true });
  });
});
