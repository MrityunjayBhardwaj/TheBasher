// comfyGraph — pure import + preview-compile tests. No server, no GPU: the
// compiled per-frame JSON IS the testable IP (design §15). A small SD1.5
// text2img graph stands in for the staged workflow.

import { describe, expect, it } from 'vitest';
import {
  type BatchedTrack,
  type ComfyApiJson,
  type ComfyGraphMeta,
  BASHER_SCHEDULE_NODE_TYPES,
  comfyParamPath,
  compileBatchedWorkflow,
  compilePreviewFrame,
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

  it('classifies SCHEDULABLE vs STRUCTURAL params (design §7.4)', () => {
    const hint = (n: string, i: string) =>
      graph.params.find((p) => p.nodeId === n && p.inputName === i)!.scheduleHint;
    expect(hint('3', 'cfg')).toBe('schedulable'); // a scalar into KSampler
    expect(hint('3', 'denoise')).toBe('schedulable');
    expect(hint('6', 'text')).toBe('schedulable'); // prompt travel
    expect(hint('4', 'ckpt_name')).toBe('structural'); // model swap = topology
    expect(hint('3', 'sampler_name')).toBe('structural');
    expect(hint('5', 'width')).toBe('structural'); // latent shape
    expect(hint('5', 'batch_size')).toBe('structural'); // batch size = schedule length
  });

  it('classifies a LoadVideo.file input as a bindable video media param', () => {
    // The Mode-B video-in path (docs/COMFYUI-BASHER-NODES.md): a vanilla LoadVideo node
    // gets a project-video picker, mirroring LoadImage.image. The manifest must mark it
    // valueKind 'video' (so the Controls dispatch renders the video row) + 'schedulable'
    // (so it's a bindable row, not a read-only structural one).
    const withVideo: ComfyApiJson = {
      '10': { class_type: 'LoadVideo', inputs: { file: 'clip.mp4' } },
      '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    };
    const p = importComfyGraph(withVideo, META).params.find(
      (x) => x.nodeId === '10' && x.inputName === 'file',
    )!;
    expect(p.valueKind).toBe('video');
    expect(p.scheduleHint).toBe('schedulable');
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

describe('compilePreviewFrame — per-frame substitution (design §7.2)', () => {
  const graph = importComfyGraph(SD15, META);
  const tracks = [
    { nodeId: '3', inputName: 'cfg', values: [6.5, 7.0, 9.0] },
    { nodeId: '6', inputName: 'text', values: ['frame a', 'frame b', 'frame c'] },
  ];

  it('substitutes each track value-at-frame and never mutates the source', () => {
    const f1 = compilePreviewFrame(graph, tracks, 1);
    expect((f1['3'].inputs as Record<string, unknown>).cfg).toBe(7.0);
    expect((f1['6'].inputs as Record<string, unknown>).text).toBe('frame b');
    // source untouched → N frames compile independently
    expect((graph.apiJson['3'].inputs as Record<string, unknown>).cfg).toBe(6.5);
    expect((graph.apiJson['6'].inputs as Record<string, unknown>).text).toBe(
      'a green cube on a table',
    );
  });

  it('leaves wired links and unbound params alone', () => {
    const f0 = compilePreviewFrame(graph, tracks, 0);
    // a wired link is preserved
    expect((f0['3'].inputs as Record<string, unknown>).model).toEqual(['4', 0]);
    // an unbound literal keeps its authored value
    expect((f0['3'].inputs as Record<string, unknown>).seed).toBe(42);
  });

  it('skips out-of-range frames (keeps the authored literal)', () => {
    const f9 = compilePreviewFrame(graph, tracks, 9);
    expect((f9['3'].inputs as Record<string, unknown>).cfg).toBe(6.5);
  });

  it('is the testable IP: the full compiled frame is a stable snapshot', () => {
    expect(compilePreviewFrame(graph, tracks, 2)).toMatchInlineSnapshot(`
      {
        "3": {
          "class_type": "KSampler",
          "inputs": {
            "cfg": 9,
            "denoise": 1,
            "latent_image": [
              "5",
              0,
            ],
            "model": [
              "4",
              0,
            ],
            "negative": [
              "7",
              0,
            ],
            "positive": [
              "6",
              0,
            ],
            "sampler_name": "euler",
            "scheduler": "normal",
            "seed": 42,
            "steps": 20,
          },
        },
        "4": {
          "class_type": "CheckpointLoaderSimple",
          "inputs": {
            "ckpt_name": "v1-5-pruned-emaonly.safetensors",
          },
        },
        "5": {
          "class_type": "EmptyLatentImage",
          "inputs": {
            "batch_size": 1,
            "height": 512,
            "width": 512,
          },
        },
        "6": {
          "class_type": "CLIPTextEncode",
          "inputs": {
            "clip": [
              "4",
              1,
            ],
            "text": "frame c",
          },
        },
        "7": {
          "class_type": "CLIPTextEncode",
          "inputs": {
            "clip": [
              "4",
              1,
            ],
            "text": "blurry",
          },
        },
        "8": {
          "class_type": "VAEDecode",
          "inputs": {
            "samples": [
              "3",
              0,
            ],
            "vae": [
              "4",
              2,
            ],
          },
        },
        "9": {
          "class_type": "SaveImage",
          "inputs": {
            "filename_prefix": "basher",
            "images": [
              "8",
              0,
            ],
          },
        },
      }
    `);
  });
});

describe('compileBatchedWorkflow — coherent batched path (design §7.3)', () => {
  const graph = importComfyGraph(SD15, META);
  const cfgTrack: BatchedTrack = {
    nodeId: '3',
    inputName: 'cfg',
    classType: 'KSampler',
    valueKind: 'float',
    values: [6.5, 7.0, 9.0, 8.0],
  };

  it('inserts a BasherValueSchedule for a float param and rewires its input to read it', () => {
    const { apiJson, scheduleNodeIds } = compileBatchedWorkflow(graph, [cfgTrack], {
      frameCount: 4,
    });
    expect(scheduleNodeIds).toEqual(['bsched_3_cfg']);
    const sched = apiJson['bsched_3_cfg'];
    expect(sched.class_type).toBe(BASHER_SCHEDULE_NODE_TYPES.float);
    expect(sched.inputs.values_json).toBe('[6.5,7,9,8]');
    expect(sched.inputs.frame_count).toBe(4);
    // the KSampler.cfg literal is now a link to the schedule node's output 0
    expect((apiJson['3'].inputs as Record<string, unknown>).cfg).toEqual(['bsched_3_cfg', 0]);
    // source graph untouched
    expect((graph.apiJson['3'].inputs as Record<string, unknown>).cfg).toBe(6.5);
  });

  it('sets EmptyLatentImage.batch_size to N (the batch length matches the schedule)', () => {
    const { apiJson } = compileBatchedWorkflow(graph, [cfgTrack], { frameCount: 4 });
    expect((apiJson['5'].inputs as Record<string, unknown>).batch_size).toBe(4);
  });

  it('demotes STRUCTURAL params (kept as literal, reported — never silent §7.4)', () => {
    const widthTrack: BatchedTrack = {
      nodeId: '5',
      inputName: 'width',
      classType: 'EmptyLatentImage',
      valueKind: 'int',
      values: [512, 768],
    };
    const { apiJson, demotions, scheduleNodeIds } = compileBatchedWorkflow(graph, [widthTrack], {
      frameCount: 2,
    });
    expect(scheduleNodeIds).toEqual([]);
    expect(demotions).toEqual([{ nodeId: '5', inputName: 'width', reason: 'structural' }]);
    // the literal is preserved (the rest pose), not rewired
    expect((apiJson['5'].inputs as Record<string, unknown>).width).toBe(512);
  });

  it('does NOT schedule a CONSTANT float track (substitutes the literal, no node)', () => {
    // An unbound / flat param needs no BasherSchedule — the render stays a plain
    // workflow that runs without the bridge extension installed (§16 Q-E).
    const flat: BatchedTrack = {
      nodeId: '3',
      inputName: 'cfg',
      classType: 'KSampler',
      valueKind: 'float',
      values: [8, 8, 8, 8],
    };
    const { apiJson, scheduleNodeIds, demotions } = compileBatchedWorkflow(graph, [flat], {
      frameCount: 4,
    });
    expect(scheduleNodeIds).toEqual([]);
    expect(demotions).toEqual([]); // constant ≠ demotion; it just stays a literal
    expect((apiJson['3'].inputs as Record<string, unknown>).cfg).toBe(8);
    expect(apiJson['bsched_3_cfg']).toBeUndefined();
  });

  it('demotes string (prompt-travel) + image as unsupported-kind in this increment', () => {
    const promptTrack: BatchedTrack = {
      nodeId: '6',
      inputName: 'text',
      classType: 'CLIPTextEncode',
      valueKind: 'string',
      values: ['a', 'b'],
    };
    const { demotions, scheduleNodeIds } = compileBatchedWorkflow(graph, [promptTrack], {
      frameCount: 2,
    });
    expect(scheduleNodeIds).toEqual([]);
    expect(demotions).toEqual([{ nodeId: '6', inputName: 'text', reason: 'unsupported-kind' }]);
  });

  it('demotes a track whose input is now wired (graph edited), keeping the link', () => {
    const wired: BatchedTrack = {
      nodeId: '3',
      inputName: 'model', // a [4,0] link in SD15, not a literal
      classType: 'KSampler',
      valueKind: 'float',
      values: [1, 2],
    };
    const { apiJson, demotions } = compileBatchedWorkflow(graph, [wired], { frameCount: 2 });
    expect(demotions).toEqual([{ nodeId: '3', inputName: 'model', reason: 'wired-input' }]);
    expect((apiJson['3'].inputs as Record<string, unknown>).model).toEqual(['4', 0]);
  });

  it('is the testable IP: the full compiled batched workflow is a stable snapshot', () => {
    const { apiJson } = compileBatchedWorkflow(graph, [cfgTrack], { frameCount: 4 });
    expect(apiJson).toMatchInlineSnapshot(`
      {
        "3": {
          "class_type": "KSampler",
          "inputs": {
            "cfg": [
              "bsched_3_cfg",
              0,
            ],
            "denoise": 1,
            "latent_image": [
              "5",
              0,
            ],
            "model": [
              "4",
              0,
            ],
            "negative": [
              "7",
              0,
            ],
            "positive": [
              "6",
              0,
            ],
            "sampler_name": "euler",
            "scheduler": "normal",
            "seed": 42,
            "steps": 20,
          },
        },
        "4": {
          "class_type": "CheckpointLoaderSimple",
          "inputs": {
            "ckpt_name": "v1-5-pruned-emaonly.safetensors",
          },
        },
        "5": {
          "class_type": "EmptyLatentImage",
          "inputs": {
            "batch_size": 4,
            "height": 512,
            "width": 512,
          },
        },
        "6": {
          "class_type": "CLIPTextEncode",
          "inputs": {
            "clip": [
              "4",
              1,
            ],
            "text": "a green cube on a table",
          },
        },
        "7": {
          "class_type": "CLIPTextEncode",
          "inputs": {
            "clip": [
              "4",
              1,
            ],
            "text": "blurry",
          },
        },
        "8": {
          "class_type": "VAEDecode",
          "inputs": {
            "samples": [
              "3",
              0,
            ],
            "vae": [
              "4",
              2,
            ],
          },
        },
        "9": {
          "class_type": "SaveImage",
          "inputs": {
            "filename_prefix": "basher",
            "images": [
              "8",
              0,
            ],
          },
        },
        "bsched_3_cfg": {
          "_meta": {
            "title": "Basher Schedule: 3.cfg",
          },
          "class_type": "BasherValueSchedule",
          "inputs": {
            "frame_count": 4,
            "values_json": "[6.5,7,9,8]",
          },
        },
      }
    `);
  });
});
