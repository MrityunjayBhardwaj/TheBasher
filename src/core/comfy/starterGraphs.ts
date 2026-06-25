// starterGraphs — built-in ComfyUI workflows (API format) Basher ships so a
// ComfyUIWorkflow layer carries real, keyframeable params the moment it's added,
// before any file import. These are plain data (the `/prompt` body shape); Basher
// talks to ComfyUI at arm's length (no GPL code vendored — design §3).
//
// SD15_TEXT2IMG mirrors the validated local SD1.5 text2img workflow
// (../projects/comfyui/scratchpad/sd15-text2img.json). Its literal inputs become
// the animatable manifest via importComfyGraph; its wired [id,idx] links are the
// graph topology.
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.1; vyapti V81.

import type { ComfyApiJson, ComfyGraphMeta } from './comfyGraph';

/** A minimal SD1.5 text2img workflow in ComfyUI API format. */
export const SD15_TEXT2IMG: ComfyApiJson = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
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
    inputs: { text: 'a green cube on a table, studio lighting', clip: ['4', 1] },
  },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'basher', images: ['8', 0] } },
};

/** Meta for the built-in starter (importedAt is a fixed sentinel — the graph is
 *  ships-with-Basher, not freshly imported, so it stays deterministic for tests). */
export const SD15_TEXT2IMG_META: ComfyGraphMeta = {
  name: 'SD1.5 text2img',
  importedAt: 'builtin',
  fps: 30,
  frames: 24,
};
