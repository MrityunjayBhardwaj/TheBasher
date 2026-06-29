// comfyGraph — pure import tests. No server, no GPU: the lean param enumerator IS the
// testable surface (the inference compiler + preview compile are retired —
// docs/COMFYUI-BASHER-NODES.md). A small SD1.5 text2img graph stands in for the
// staged workflow.

import { describe, expect, it } from 'vitest';
import {
  type ComfyApiJson,
  type ComfyGraphMeta,
  comfyParamPath,
  importComfyGraph,
  isComfyLink,
  parseComfyParamPath,
} from './comfyGraph';

// A representative SD1.5 text2img workflow (API format). Literals are the
// authorable params; `[id, idx]` arrays are wired links (skipped by import).
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
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
  },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a green cube on a table', clip: ['4', 1] },
  },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'basher', images: ['8', 0] } },
};

const META: ComfyGraphMeta = { name: 'sd15', importedAt: 'fixed', fps: 30, frames: 24 };

describe('isComfyLink', () => {
  it('distinguishes a [id, idx] link from a literal', () => {
    expect(isComfyLink(['4', 0])).toBe(true);
    expect(isComfyLink(6.5)).toBe(false);
    expect(isComfyLink('a cat')).toBe(false);
    expect(isComfyLink(['4', '0'] as unknown as [string, number])).toBe(false);
  });
});

describe('importComfyGraph — param manifest', () => {
  const graph = importComfyGraph(SD15, META);

  it('keeps the api json verbatim as the compile substrate', () => {
    expect(graph.apiJson).toBe(SD15);
    expect(graph.meta).toEqual(META);
  });

  it('exposes every literal input as a param and skips wired links', () => {
    // Wired inputs (model/positive/clip/samples/…) must NOT appear.
    expect(graph.params.some((p) => p.inputName === 'model')).toBe(false);
    expect(graph.params.some((p) => p.inputName === 'positive')).toBe(false);
    expect(graph.params.some((p) => p.inputName === 'clip')).toBe(false);
    // Literals do.
    expect(graph.params.find((p) => p.nodeId === '3' && p.inputName === 'cfg')).toBeTruthy();
    expect(graph.params.find((p) => p.nodeId === '6' && p.inputName === 'text')).toBeTruthy();
  });

  it('infers value kinds from the node-schema table', () => {
    const by = (n: string, i: string) =>
      graph.params.find((p) => p.nodeId === n && p.inputName === i)!;
    expect(by('3', 'cfg').valueKind).toBe('float');
    expect(by('3', 'seed').valueKind).toBe('int');
    expect(by('3', 'steps').valueKind).toBe('int');
    expect(by('3', 'sampler_name').valueKind).toBe('enum');
    expect(by('6', 'text').valueKind).toBe('string');
    expect(by('4', 'ckpt_name').valueKind).toBe('enum');
    expect(by('5', 'width').valueKind).toBe('int');
  });

  it('classifies a LoadVideo.file input as a bindable video media param', () => {
    // The Mode-B video-in path (docs/COMFYUI-BASHER-NODES.md): a vanilla LoadVideo node
    // gets a project-video picker, mirroring LoadImage.image. The manifest marks it
    // valueKind 'video' so the Controls dispatch renders the video bind row.
    const withVideo: ComfyApiJson = {
      '10': { class_type: 'LoadVideo', inputs: { file: 'clip.mp4' } },
      '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    };
    const p = importComfyGraph(withVideo, META).params.find(
      (x) => x.nodeId === '10' && x.inputName === 'file',
    )!;
    expect(p.valueKind).toBe('video');
    // The ext-fallback also recognises a video container on a non-tabled node/input.
    const untabled = importComfyGraph(
      { '12': { class_type: 'SomeVideoNode', inputs: { src: 'a.webm' } } },
      META,
    ).params.find((x) => x.nodeId === '12')!;
    expect(untabled.valueKind).toBe('video');
  });

  it('returns params in a stable (nodeId, inputName) order', () => {
    const keys = graph.params.map((p) => `${p.nodeId}.${p.inputName}`);
    const sorted = [...keys].sort();
    // numeric-aware nodeId sort, then inputName — deterministic for snapshots.
    expect(keys[0].startsWith('3.')).toBe(true);
    expect(keys).toEqual([...keys]); // self-consistent
    expect(sorted.length).toBe(keys.length);
  });
});

describe('comfyParamPath / parseComfyParamPath', () => {
  it('round-trips the namespaced V57 paramPath', () => {
    expect(comfyParamPath('3', 'cfg')).toBe('comfy:3.cfg');
    expect(parseComfyParamPath('comfy:3.cfg')).toEqual({ nodeId: '3', inputName: 'cfg' });
  });
  it('rejects non-comfy paths', () => {
    expect(parseComfyParamPath('transform.position')).toBeNull();
    expect(parseComfyParamPath('comfy:3')).toBeNull();
    expect(parseComfyParamPath('comfy:.cfg')).toBeNull();
  });
});
