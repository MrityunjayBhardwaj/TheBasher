// compositeDecode — verify the comfy image-input BINDING resolves into the compiled
// workflow: a project image bound to a LoadImage.image input rewrites that input to a
// stable upload filename AND records the OPFS bytes to upload at /prompt time. This is
// the generic image-source affordance (COMPOSITOR §7.1) — proven GPU-free + server-
// free, the testable core of "the 3D/asset world drives the generation."

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { BitmapLRU, collectCompositeInputs, comfyLayerFrame } from './compositeDecode';
import { isLayerDraw, isLayerInput, planComposite } from './composite';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { framePath } from '../../core/comfy/workflowPaths';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx } from '../../core/dag/types';
import type { ComfyApiJson } from '../../core/comfy/comfyGraph';

// #1879 — the layer stack is walked through each node's declared chain socket.
beforeAll(() => registerAllNodes());

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** A minimal API workflow with a LoadImage node (node "10") whose `image` input is a
 *  literal filename — exactly the 'image'-valueKind param the picker binds. */
const API_JSON = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 1, steps: 20, cfg: 7, model: ['4', 0], latent_image: ['5', 0] },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
};

function stateWithBinding(imageBindings: Record<string, string>): DagState {
  return {
    nodes: {
      comp: {
        id: 'comp',
        type: 'Composition',
        version: 1,
        params: { fps: 30, durationFrames: 150, width: 512, height: 512 },
        inputs: { in: { node: 'layer', socket: 'out' } },
      },
      layer: {
        id: 'layer',
        type: 'Layer',
        version: 1,
        params: { muted: false, name: 'gen' },
        inputs: { source: [{ node: 'comfy', socket: 'out' }] },
      },
      comfy: {
        id: 'comfy',
        type: 'ComfyUIWorkflow',
        version: 1,
        params: {
          graph: { apiJson: API_JSON, meta: { name: 'wf', importedAt: '', fps: 30, frames: 1 } },
          imageBindings,
          width: 512,
          height: 512,
        },
        inputs: {},
      },
    },
    outputs: {},
  } as unknown as DagState;
}

describe('collectCompositeInputs — comfy image bindings', () => {
  it('rewrites a bound LoadImage.image to a stable upload name + records the bytes to upload', () => {
    const state = stateWithBinding({ '10.image': 'media/pose-abc123.png' });
    const inputs = collectCompositeInputs(state, 'comp', CTX).filter(isLayerInput);

    expect(inputs).toHaveLength(1);
    const source = inputs[0].source;
    expect(source?.kind).toBe('comfy');

    // The compiled workflow's LoadImage input now references the stable upload name.
    const compiled = source?.comfyWorkflow as ComfyApiJson;
    expect(compiled['10'].inputs.image).toBe('basher_img_10_image.png');

    // …and the OPFS bytes are queued for upload under that same name.
    expect(source?.comfyImageUploads).toEqual([
      { path: 'media/pose-abc123.png', filename: 'basher_img_10_image.png' },
    ]);
  });

  it('leaves the authored literal + no uploads when nothing is bound', () => {
    const state = stateWithBinding({});
    const source = collectCompositeInputs(state, 'comp', CTX).filter(isLayerInput)[0].source;

    const compiled = source?.comfyWorkflow as ComfyApiJson;
    expect(compiled['10'].inputs.image).toBe('placeholder.png');
    expect(source?.comfyImageUploads).toEqual([]);
  });

  it('busts the source cache key when the bound image changes (animated/edited redraw)', () => {
    const a = collectCompositeInputs(
      stateWithBinding({ '10.image': 'media/a.png' }),
      'comp',
      CTX,
    ).filter(isLayerInput);
    const b = collectCompositeInputs(
      stateWithBinding({ '10.image': 'media/b.png' }),
      'comp',
      CTX,
    ).filter(isLayerInput);
    expect(a[0].source?.path).not.toBe(b[0].source?.path);
  });
});

// #253 — the bounded LRU that stops bitmapCache/gradedCache from growing without
// limit (a full video export decoded thousands of frames → OOM). A fake bitmap
// records close() so eviction is observable (real ImageBitmap.close frees GPU mem).
function fakeBitmap(): ImageBitmap & { closed: boolean } {
  const b = { closed: false } as ImageBitmap & { closed: boolean };
  b.close = () => {
    b.closed = true;
  };
  return b;
}

describe('BitmapLRU', () => {
  it('evicts the oldest entry and closes its bitmap when over capacity', () => {
    const lru = new BitmapLRU(2);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const c = fakeBitmap();
    lru.set('a', a);
    lru.set('b', b);
    lru.set('c', c); // over cap → 'a' (oldest) evicted + closed
    expect(a.closed).toBe(true);
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe(b);
    expect(lru.get('c')).toBe(c);
    expect(b.closed).toBe(false);
  });

  it('get marks an entry most-recently-used so it survives the next eviction', () => {
    const lru = new BitmapLRU(2);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const c = fakeBitmap();
    lru.set('a', a);
    lru.set('b', b);
    lru.get('a'); // 'a' is now MRU → 'b' becomes the eviction candidate
    lru.set('c', c);
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(lru.get('a')).toBe(a);
  });

  it('clear closes every cached bitmap', () => {
    const lru = new BitmapLRU(8);
    const a = fakeBitmap();
    const b = fakeBitmap();
    lru.set('a', a);
    lru.set('b', b);
    lru.clear();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(lru.get('a')).toBeUndefined();
  });
});

// #1717 — a ComfyUI workflow layer shows what the runner made: its stored picture for each frame
// of its range, a still held, and a placeholder where nothing is stored yet.
describe('collectCompositeInputs — a workflow layer reads the runner’s stored frames', () => {
  const FRAMES_FILE: ComfyApiJson = {
    '1': { class_type: 'basher_controller', inputs: { name: 'beauty', kind: 'video', video: '' } },
    '2': {
      class_type: 'basher_export',
      inputs: { name: 'stylized', kind: 'video', images: ['1', 0] },
    },
  };
  const STILL_FILE: ComfyApiJson = {
    '1': { class_type: 'basher_controller', inputs: { name: 'render', kind: 'image', image: '' } },
    '2': {
      class_type: 'basher_export',
      inputs: { name: 'still', kind: 'image', images: ['1', 0] },
    },
  };
  const META = { name: 'Shot 2', importedAt: '', fps: 30, frames: 1 };

  function shotLayer(apiJson: ComfyApiJson, socket: string, extra: Record<string, unknown> = {}) {
    return {
      nodes: {
        comp: {
          id: 'comp',
          type: 'Composition',
          version: 1,
          params: { fps: 30, durationFrames: 90, width: 64, height: 36 },
          inputs: { in: { node: 'layer', socket: 'out' } },
        },
        layer: {
          id: 'layer',
          type: 'Layer',
          version: 1,
          params: { name: 'Shot 2', startFrame: 30, inPoint: 0, outPoint: 30 },
          inputs: { source: [{ node: 'wf', socket }] },
        },
        wf: {
          id: 'wf',
          type: 'ComfyUIWorkflow',
          version: 1,
          params: {
            graph: { apiJson, meta: META },
            frameStart: 30,
            frameEnd: 59,
            outputPath: 'renders/shots/shot2',
            width: 64,
            height: 36,
            ...extra,
          },
          inputs: {},
        },
      },
      outputs: {},
    } as unknown as DagState;
  }

  const at = (state: DagState, compFrame: number) => {
    const inputs = collectCompositeInputs(state, 'comp', CTX);
    return planComposite({ fps: 30, durationFrames: 90 }, inputs, compFrame).filter(isLayerDraw);
  };

  it('a frames workflow covers its range, and comp frame N reads the frame the runner stored for N', async () => {
    const state = shotLayer(FRAMES_FILE, 'stylized');
    const source = collectCompositeInputs(state, 'comp', CTX).filter(isLayerInput)[0].source!;
    expect(source.srcFrames).toBe(30);
    const storage = new MemoryStorage();
    await storage.write(framePath('renders/shots/shot2', 45), Uint8Array.of(1));
    const [draw] = at(state, 45);
    expect(await comfyLayerFrame(draw.source, draw.sourceFrameIndex, storage)).toEqual({
      stored: 'renders/shots/shot2_0045.png',
    });
    // Outside the range nothing draws (the layer is the shot's clip).
    expect(at(state, 29)).toEqual([]);
    expect(at(state, 60)).toEqual([]);
  });

  it('a frame the runner has not stored yet is a placeholder', async () => {
    const state = shotLayer(FRAMES_FILE, 'stylized');
    const storage = new MemoryStorage();
    await storage.write(framePath('renders/shots/shot2', 45), Uint8Array.of(1));
    const [draw] = at(state, 46);
    expect(await comfyLayerFrame(draw.source, draw.sourceFrameIndex, storage)).toEqual({
      stored: null,
    });
  });

  it('a still workflow is held: every frame of the layer reads its one stored picture', async () => {
    const state = shotLayer(STILL_FILE, 'still');
    const source = collectCompositeInputs(state, 'comp', CTX).filter(isLayerInput)[0].source!;
    expect(source.srcFrames).toBe(1);
    const storage = new MemoryStorage();
    await storage.write(framePath('renders/shots/shot2', 30), Uint8Array.of(1));
    for (const f of [30, 44, 59]) {
      const [draw] = at(state, f);
      expect(await comfyLayerFrame(draw.source, draw.sourceFrameIndex, storage)).toEqual({
        stored: 'renders/shots/shot2_0030.png',
      });
    }
  });

  it('a workflow with no output path keeps the old placeholder (nothing is ever stored for it)', async () => {
    const state = shotLayer(FRAMES_FILE, 'stylized', { outputPath: '' });
    const [draw] = at(state, 45);
    expect(await comfyLayerFrame(draw.source, draw.sourceFrameIndex, new MemoryStorage())).toEqual({
      stored: null,
    });
  });

  it('a run that lands new pictures changes what the layer decodes (no stale bitmap is kept)', () => {
    const before = collectCompositeInputs(shotLayer(FRAMES_FILE, 'stylized'), 'comp', CTX).filter(
      isLayerInput,
    )[0].source!;
    const after = collectCompositeInputs(
      shotLayer(FRAMES_FILE, 'stylized', { madeFrom: 'h2', lastGoodFrame: 59 }),
      'comp',
      CTX,
    ).filter(isLayerInput)[0].source!;
    expect(after.path).not.toBe(before.path);
  });
});
