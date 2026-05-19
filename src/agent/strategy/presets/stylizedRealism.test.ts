import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../../../core/dag';
import { MemoryStorage } from '../../../core/storage';
import { __reseedAllNodesForTests } from '../../../nodes/registerAll';
import type { ImageValue, PromptValue } from '../../../nodes/types';
import {
  STYLIZED_REALISM_PLACEHOLDERS,
  getPreset,
  listPresetIds,
  stylizedRealismPreset,
} from './stylizedRealism';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const samplePrompt: PromptValue = {
  kind: 'Prompt',
  text: 'cinematic cube, golden hour',
  negative: 'lowres, blurry',
  tags: ['stylized', 'sdxl'],
};

function imageMeta(passKind: ImageValue['passKind']): ImageValue {
  return {
    kind: 'Image',
    passKind,
    descriptor: { width: 1280, height: 720, format: 'rgba8' },
    sourceHash: `${passKind}_hash`,
  };
}

async function seedRawPasses(storage: MemoryStorage, frame: number) {
  const padded = frame.toString().padStart(4, '0');
  await storage.write(
    `renders/job1/beauty_${padded}.png`,
    new TextEncoder().encode(`beauty${frame}`),
  );
  await storage.write(
    `renders/job1/depth_${padded}.png`,
    new TextEncoder().encode(`depth${frame}`),
  );
  await storage.write(
    `renders/job1/normal_${padded}.png`,
    new TextEncoder().encode(`normal${frame}`),
  );
}

describe('stylizedRealism preset', () => {
  it('preset registry exposes stylizedRealism only (D-02 — single preset in v0.5)', () => {
    expect(listPresetIds()).toEqual(['stylizedRealism']);
    expect(getPreset('stylizedRealism')).toBe(stylizedRealismPreset);
    expect(getPreset('anime')).toBeUndefined();
    expect(getPreset('conceptPaint')).toBeUndefined();
  });

  it('declares Beauty + Depth + Normal as required passes', () => {
    expect(stylizedRealismPreset.requiredPasses.slice().sort()).toEqual([
      'beauty',
      'depth',
      'normal',
    ]);
  });

  it('placeholder list matches the substitution surface', () => {
    expect(STYLIZED_REALISM_PLACEHOLDERS).toContain('__POSITIVE__');
    expect(STYLIZED_REALISM_PLACEHOLDERS).toContain('__NEGATIVE__');
    expect(STYLIZED_REALISM_PLACEHOLDERS).toContain('beauty.png');
    expect(STYLIZED_REALISM_PLACEHOLDERS).toContain('depth.png');
    expect(STYLIZED_REALISM_PLACEHOLDERS).toContain('normal.png');
    expect(STYLIZED_REALISM_PLACEHOLDERS).toContain('prev_frame_image.png');
  });

  describe('compile', () => {
    it('substitutes positive + negative prompt text into the cloned workflow JSON', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 0);
      const compile = stylizedRealismPreset.compile({ storage });
      const { workflowJson } = await compile({
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 0,
        prevFrameStylizedPath: null,
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      });
      const wf = workflowJson as Record<string, { inputs: { text?: string } }>;
      expect(wf['3'].inputs.text).toBe('cinematic cube, golden hour');
      expect(wf['4'].inputs.text).toBe('lowres, blurry');
    });

    it('reads raw pass bytes from storage at runRenderJob-shape paths', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 5);
      const compile = stylizedRealismPreset.compile({ storage });
      const { inputs } = await compile({
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 5,
        prevFrameStylizedPath: null,
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      });
      expect(new TextDecoder().decode(inputs.images.beauty)).toBe('beauty5');
      expect(new TextDecoder().decode(inputs.images.depth)).toBe('depth5');
      expect(new TextDecoder().decode(inputs.images.normal)).toBe('normal5');
    });

    it('first frame: prev_frame_image is the zero PNG (no antecedent stylized)', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 0);
      const compile = stylizedRealismPreset.compile({ storage });
      const { inputs } = await compile({
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 0,
        prevFrameStylizedPath: null,
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      });
      const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
      expect(inputs.images.prev_frame_image.subarray(0, sig.length)).toEqual(sig);
    });

    it('frame N>0: prev_frame_image bytes loaded from prevFrameStylizedPath when present', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 1);
      const prevPath = 'renders/job1/stylized_stylizedRealism_0000.png';
      await storage.write(prevPath, new TextEncoder().encode('PREV_BYTES'));
      const compile = stylizedRealismPreset.compile({ storage });
      const { inputs } = await compile({
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 1,
        prevFrameStylizedPath: prevPath,
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      });
      expect(new TextDecoder().decode(inputs.images.prev_frame_image)).toBe('PREV_BYTES');
    });

    it('frame N>0 with declared but missing prev path falls back to zero PNG (soft-fail, no crash)', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 1);
      const compile = stylizedRealismPreset.compile({ storage });
      const { inputs } = await compile({
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 1,
        prevFrameStylizedPath: 'renders/never/exists_0000.png',
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      });
      const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
      expect(inputs.images.prev_frame_image.subarray(0, sig.length)).toEqual(sig);
    });

    it('throws clear error when a required pass is not wired into the workflow', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 0);
      const compile = stylizedRealismPreset.compile({ storage });
      await expect(
        compile({
          presetId: 'stylizedRealism',
          prompt: samplePrompt,
          passes: [imageMeta('beauty'), imageMeta('depth')], // missing normal
          frame: 0,
          prevFrameStylizedPath: null,
          workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
        }),
      ).rejects.toThrow(/required pass "normal" not wired/);
    });

    it('throws clear error when a raw pass is missing on disk', async () => {
      const storage = new MemoryStorage();
      // beauty + depth seeded; normal NOT seeded
      const padded = '0000';
      await storage.write(`renders/job1/beauty_${padded}.png`, new TextEncoder().encode('b'));
      await storage.write(`renders/job1/depth_${padded}.png`, new TextEncoder().encode('d'));
      const compile = stylizedRealismPreset.compile({ storage });
      await expect(
        compile({
          presetId: 'stylizedRealism',
          prompt: samplePrompt,
          passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
          frame: 0,
          prevFrameStylizedPath: null,
          workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
        }),
      ).rejects.toThrow(/raw pass normal not found/);
    });

    it('twice-call deterministic — same inputs produce structurally identical workflowJson + inputs', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 7);
      const compile = stylizedRealismPreset.compile({ storage });
      const baseArgs = {
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 7,
        prevFrameStylizedPath: null,
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      };
      const a = await compile(baseArgs);
      const b = await compile(baseArgs);
      expect(JSON.stringify(a.workflowJson)).toBe(JSON.stringify(b.workflowJson));
      // Image bytes are equal (same source file, same load).
      expect(a.inputs.images.beauty).toEqual(b.inputs.images.beauty);
    });

    it('passes prompt + frame + computed stylizedFramePath as scalars', async () => {
      const storage = new MemoryStorage();
      await seedRawPasses(storage, 12);
      const compile = stylizedRealismPreset.compile({ storage });
      const { inputs } = await compile({
        presetId: 'stylizedRealism',
        prompt: samplePrompt,
        passes: [imageMeta('beauty'), imageMeta('depth'), imageMeta('normal')],
        frame: 12,
        prevFrameStylizedPath: null,
        workflowOutputPath: 'renders/job1/stylized_stylizedRealism',
      });
      expect(inputs.scalars.frame).toBe(12);
      expect(inputs.scalars.prompt).toBe('cinematic cube, golden hour');
      expect(inputs.scalars.negative).toBe('lowres, blurry');
      expect(inputs.scalars.stylizedFramePath).toBe(
        'renders/job1/stylized_stylizedRealism_0012.png',
      );
    });
  });
});
