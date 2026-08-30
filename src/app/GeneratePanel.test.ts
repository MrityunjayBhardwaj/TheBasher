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
const { generateMotionIntoScene, generateModelIntoScene, generateRiggedCharacter } = vi.hoisted(
  () => ({
    generateMotionIntoScene: vi.fn(async (_prompt: string) => ({
      ok: true as const,
      clipId: 'n_clip',
      skeletonId: 'n_skel',
    })),
    generateModelIntoScene: vi.fn(async (_request: unknown, _options?: unknown) => ({
      ok: true as const,
      opfsPath: 'user-imports/x/model.glb',
      taskId: 't1',
    })),
    generateRiggedCharacter: vi.fn(async (_request: unknown, _options?: unknown) => ({
      ok: true as const,
      opfsPath: 'user-imports/x/character.glb',
      taskId: 't2',
      arrivedSpec: 'mixamo' as const,
    })),
  }),
);

vi.mock('./asset/generateMotion', () => ({ generateMotionIntoScene }));
vi.mock('./asset/generateModel', () => ({ generateModelIntoScene }));
vi.mock('./asset/generateRiggedCharacter', () => ({ generateRiggedCharacter }));

// Imported AFTER the mocks so the module under test picks them up.
import {
  GENERATION_KINDS,
  acceptsImage,
  canSubmit,
  runGeneration,
  type GenerationKind,
  type GenerationProgressView,
} from './GeneratePanel';

/** The app-layer surfaces, named here rather than derived from the module under
 *  test — an expectation derived from its producer cannot fail. */
const SURFACES = {
  motion: generateMotionIntoScene,
  model: generateModelIntoScene,
  character: generateRiggedCharacter,
};

const IMAGE = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };

beforeEach(() => {
  for (const fn of Object.values(SURFACES)) fn.mockClear();
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
    expect(generateMotionIntoScene).toHaveBeenCalledWith('a figure walks forward');
  });

  it('every kind the panel offers has a road of its own', async () => {
    const routed = new Map<GenerationKind, string[]>();
    for (const { kind } of GENERATION_KINDS) {
      for (const fn of Object.values(SURFACES)) fn.mockClear();
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

  it('a prompt becomes a TEXT request', async () => {
    await runGeneration('model', 'a chair');
    expect(generateModelIntoScene).toHaveBeenCalledWith(
      { source: 'text', prompt: 'a chair' },
      expect.anything(),
    );
  });

  it('an image becomes an IMAGE request, and the prompt is not smuggled in beside it', async () => {
    await runGeneration('model', 'ignored text', IMAGE);
    const [request] = generateModelIntoScene.mock.calls[0] as [Record<string, unknown>];
    expect(request).toEqual({ source: 'image', image: IMAGE });
    // The load-bearing half: `ImageModelRequest` has no prompt, so sending one
    // would be a field the service never sees while the UI implies it matters.
    expect(request).not.toHaveProperty('prompt');
  });

  it('the character road takes an image too — a reference picture can come back rigged', async () => {
    await runGeneration('character', '', IMAGE);
    const [request] = generateRiggedCharacter.mock.calls[0] as [Record<string, unknown>];
    expect(request).toEqual({ source: 'image', image: IMAGE });
  });

  it('reports progress with a LABEL, not a bare number', async () => {
    const seen: GenerationProgressView[] = [];
    generateRiggedCharacter.mockImplementationOnce(async (_req, options) => {
      const opts = options as { onProgress?: (p: unknown) => void };
      opts.onProgress?.({ phase: 'generating', percent: 40 });
      opts.onProgress?.({ phase: 'rigging', percent: 10 });
      return { ok: true as const, opfsPath: 'p', taskId: 't', arrivedSpec: 'mixamo' as const };
    });
    await runGeneration('character', 'a dwarf', undefined, (p) => seen.push(p));

    // 🔑 Two tasks run in sequence and each reports its own 0–100. Without the
    // label the bar fills, snaps back to 10%, and reads as a restart.
    expect(seen).toEqual([
      { label: 'Generating mesh', percent: 40 },
      { label: 'Building skeleton', percent: 10 },
    ]);
  });

  it('carries a refusal back with its reason rather than swallowing it', async () => {
    generateModelIntoScene.mockResolvedValueOnce({
      ok: false,
      reason: 'no recorded licence verdict',
    } as never);
    await expect(runGeneration('model', 'a chair')).resolves.toEqual({
      ok: false,
      reason: 'no recorded licence verdict',
    });
  });

  it('a refused RIG comes back the same way, not as a success with no skeleton', async () => {
    generateRiggedCharacter.mockResolvedValueOnce({
      ok: false,
      reason: 'the service will not rig this mesh',
    } as never);
    await expect(runGeneration('character', 'a chair')).resolves.toEqual({
      ok: false,
      reason: 'the service will not rig this mesh',
    });
  });

  it('reports success without inventing a payload the panel does not use', async () => {
    await expect(runGeneration('motion', 'a figure waves')).resolves.toEqual({ ok: true });
  });
});
