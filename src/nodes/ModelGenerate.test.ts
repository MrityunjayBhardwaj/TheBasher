// ModelGenerate (#1720) — the node that keeps a generated model's request and its variants.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_VARIANTS,
  MAX_MODEL_REFERENCES,
  MAX_MODEL_VARIANTS,
  ModelGenerateNode,
  ModelGenerateParams,
  nextVariantSeed,
} from './ModelGenerate';

const BASE = { prompt: 'a chair', seed: 10, provider: 'stub-modelgen' };

describe('ModelGenerate params', () => {
  it('a request needs a seed and a provider — neither is defaulted', () => {
    expect(ModelGenerateParams.safeParse({ prompt: 'a chair', provider: 'p' }).success).toBe(false);
    expect(ModelGenerateParams.safeParse({ prompt: 'a chair', seed: 1 }).success).toBe(false);
    expect(ModelGenerateParams.safeParse({ ...BASE, provider: '  ' }).success).toBe(false);
  });

  it('defaults to four variants, no references, no rig, nothing produced yet', () => {
    expect(ModelGenerateParams.parse(BASE)).toEqual({
      ...BASE,
      references: [],
      rig: false,
      count: DEFAULT_MODEL_VARIANTS,
      variants: [],
    });
    expect(DEFAULT_MODEL_VARIANTS).toBe(4);
  });

  it('bounds the fan-out and the references', () => {
    expect(ModelGenerateParams.safeParse({ ...BASE, count: MAX_MODEL_VARIANTS + 1 }).success).toBe(
      false,
    );
    expect(ModelGenerateParams.safeParse({ ...BASE, count: 0 }).success).toBe(false);
    expect(
      ModelGenerateParams.safeParse({
        ...BASE,
        references: Array.from({ length: MAX_MODEL_REFERENCES + 1 }, (_, i) => `${i}.png`),
      }).success,
    ).toBe(false);
  });

  it('a variant records its own seed, its bytes and its task, and starts unkept', () => {
    const p = ModelGenerateParams.parse({
      ...BASE,
      variants: [{ seed: 10, path: 'model-variants/n/seed-10.glb', taskId: 't' }],
    });
    expect(p.variants[0]).toEqual({
      seed: 10,
      path: 'model-variants/n/seed-10.glb',
      taskId: 't',
      kept: false,
    });
  });
});

describe('nextVariantSeed', () => {
  it('the first variant runs with the node seed', () => {
    expect(nextVariantSeed({ seed: 10, variants: [] })).toBe(10);
  });

  it('a later variant runs one past every seed used, so Regenerate never repeats one', () => {
    const v = (seed: number) => ({ seed, path: 'p', taskId: 't', kept: false });
    expect(nextVariantSeed({ seed: 10, variants: [v(10), v(11)] })).toBe(12);
    expect(nextVariantSeed({ seed: 10, variants: [v(10), v(40), v(11)] })).toBe(41);
  });
});

describe('the node', () => {
  it('is pure and reads as nothing — what it makes is an asset, not a value', () => {
    expect(ModelGenerateNode.pure).toBe(true);
    expect(ModelGenerateNode.inputs).toEqual({});
    expect(ModelGenerateNode.outputs).toEqual({});
  });
});
