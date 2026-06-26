// compositeDecode — verify the comfy image-input BINDING resolves into the compiled
// workflow: a project image bound to a LoadImage.image input rewrites that input to a
// stable upload filename AND records the OPFS bytes to upload at /prompt time. This is
// the generic image-source affordance (COMPOSITOR §7.1) — proven GPU-free + server-
// free, the testable core of "the 3D/asset world drives the generation."

import { describe, expect, it } from 'vitest';
import { collectCompositeInputs } from './compositeDecode';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx } from '../../core/dag/types';
import type { ComfyApiJson } from '../../core/comfy/comfyGraph';

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
        inputs: { layers: [{ node: 'layer', socket: 'out' }] },
      },
      layer: {
        id: 'layer',
        type: 'Layer',
        version: 1,
        params: { enabled: true, name: 'gen' },
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
    const inputs = collectCompositeInputs(state, 'comp', CTX);

    expect(inputs).toHaveLength(1);
    const source = inputs[0].source;
    expect(source?.kind).toBe('comfy');

    // The compiled workflow's LoadImage input now references the stable upload name.
    const compiled = source?.comfyWorkflow as ComfyApiJson;
    expect(compiled['10'].inputs.image).toBe('basher_img_10_image.png');

    // …and the OPFS bytes are queued for upload under that same name.
    expect(source?.comfyImageUploads).toEqual([
      { path: 'media/pose-abc123.png', name: 'basher_img_10_image' },
    ]);
  });

  it('leaves the authored literal + no uploads when nothing is bound', () => {
    const state = stateWithBinding({});
    const source = collectCompositeInputs(state, 'comp', CTX)[0].source;

    const compiled = source?.comfyWorkflow as ComfyApiJson;
    expect(compiled['10'].inputs.image).toBe('placeholder.png');
    expect(source?.comfyImageUploads).toEqual([]);
  });

  it('busts the source cache key when the bound image changes (animated/edited redraw)', () => {
    const a = collectCompositeInputs(stateWithBinding({ '10.image': 'media/a.png' }), 'comp', CTX);
    const b = collectCompositeInputs(stateWithBinding({ '10.image': 'media/b.png' }), 'comp', CTX);
    expect(a[0].source?.path).not.toBe(b[0].source?.path);
  });
});
