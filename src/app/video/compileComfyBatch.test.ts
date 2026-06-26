// compileComfyBatch — the range-baker is the testable, GPU-free half (the submit +
// MP4 stitch are e2e-only: they need a capability + WebCodecs). With no bound
// channels every param bakes to its literal; the keyframe-driven ramp is proven by
// the e2e that animates cfg and renders. design §7.1.

import { describe, expect, it } from 'vitest';
import { applyComfyImageBindings, bakeComfyBatchedTracks } from './compileComfyBatch';
import {
  importComfyGraph,
  type ComfyApiJson,
  type ComfyGraphMeta,
} from '../../core/comfy/comfyGraph';
import type { DagState } from '../../core/dag/state';

const SD15: ComfyApiJson = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 6.5,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1.0,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cube', clip: ['4', 1] } },
};
const META: ComfyGraphMeta = { name: 'sd15', importedAt: 'fixed', fps: 30, frames: 24 };

// A DagState with no KeyframeChannel nodes → resolveEvaluatedParam returns null →
// every param bakes to its authored literal.
const EMPTY_STATE = { nodes: {} } as unknown as DagState;

describe('bakeComfyBatchedTracks — range bake (design §7.1)', () => {
  const graph = importComfyGraph(SD15, META);

  it('bakes one array per SCHEDULABLE param, length = range, structural excluded', () => {
    const tracks = bakeComfyBatchedTracks(EMPTY_STATE, 'comfy1', graph, 0, 3, 30, 4);
    // every array has the range length (4)
    for (const t of tracks) expect(t.values).toHaveLength(4);
    // structural params (width/height/batch_size, sampler_name, scheduler, ckpt_name)
    // are NOT baked — only schedulable ones (cfg/denoise/seed/steps/text).
    const keys = tracks.map((t) => `${t.nodeId}.${t.inputName}`).sort();
    expect(keys).toContain('3.cfg');
    expect(keys).toContain('3.denoise');
    expect(keys).toContain('6.text');
    expect(keys).not.toContain('5.width');
    expect(keys).not.toContain('3.sampler_name');
  });

  it('with no bound channel every value is the authored literal (constant array)', () => {
    const tracks = bakeComfyBatchedTracks(EMPTY_STATE, 'comfy1', graph, 0, 2, 30, 3);
    const cfg = tracks.find((t) => t.nodeId === '3' && t.inputName === 'cfg')!;
    expect(cfg.values).toEqual([6.5, 6.5, 6.5]);
    expect(cfg.valueKind).toBe('float');
    expect(cfg.classType).toBe('KSampler');
  });

  it('carries classType + valueKind so the compiler can pick the schedule variant', () => {
    const tracks = bakeComfyBatchedTracks(EMPTY_STATE, 'comfy1', graph, 5, 7, 30, 10);
    const text = tracks.find((t) => t.inputName === 'text')!;
    expect(text.valueKind).toBe('string');
    expect(text.values).toEqual(['a cube', 'a cube', 'a cube']);
  });

  it('does NOT bake a CONSTANT image param (it is handled by the binding rewrite, not a track)', () => {
    // A LoadImage.image with no bound channel bakes to a constant filename → no
    // schedule track here (so it is not a spurious unsupported-kind demotion); the
    // static binding rewrite (applyComfyImageBindings) sets it instead.
    const withLoad = importComfyGraph(
      { ...SD15, '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } } },
      META,
    );
    const tracks = bakeComfyBatchedTracks(EMPTY_STATE, 'comfy1', withLoad, 0, 3, 30, 4);
    expect(tracks.some((t) => t.nodeId === '10' && t.inputName === 'image')).toBe(false);
  });
});

describe('applyComfyImageBindings — rewrite bound image inputs in the batch (design §7.1)', () => {
  const baseJson = (): ComfyApiJson => ({
    '3': {
      class_type: 'KSampler',
      inputs: { seed: 1, cfg: 7, model: ['4', 0], latent_image: ['11', 0] },
    },
    '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
    '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
  });

  it('rewrites a bound LoadImage.image to a stable upload name + returns the bytes to upload', () => {
    const apiJson = baseJson();
    const uploads = applyComfyImageBindings(apiJson, { '10.image': 'media/depth-abc.png' });
    expect(apiJson['10'].inputs.image).toBe('basher_img_10_image.png');
    expect(uploads).toEqual([{ path: 'media/depth-abc.png', name: 'basher_img_10_image' }]);
  });

  it('leaves the authored literal + no uploads when nothing is bound', () => {
    const apiJson = baseJson();
    const uploads = applyComfyImageBindings(apiJson, {});
    expect(apiJson['10'].inputs.image).toBe('placeholder.png');
    expect(uploads).toEqual([]);
  });

  it('skips a binding whose node is missing or whose input is now wired (keeps the link)', () => {
    const apiJson = baseJson();
    // node 99 does not exist; node 3's latent_image is a [11,0] link, not a literal
    const uploads = applyComfyImageBindings(apiJson, {
      '99.image': 'media/x.png',
      '3.latent_image': 'media/y.png',
    });
    expect(apiJson['3'].inputs.latent_image).toEqual(['11', 0]);
    expect(uploads).toEqual([]);
  });
});
