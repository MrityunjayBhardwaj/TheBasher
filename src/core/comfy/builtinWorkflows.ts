// builtinWorkflows — #1715: workflow FILES Basher ships, as plain data.
//
// There is no preset code any more: a ComfyUI workflow node runs whatever workflow file it holds,
// and its sockets are that file's Basher markers (`socketsOfWorkflow`). What used to be the
// `stylizedRealism` preset is this file now, rewritten with markers so the generic node can run
// it: beauty, depth and normal come in as frames, the prompt and negative as text, the previous
// frame of the output is fed back (`feedback_of`) for the img2img step that keeps one frame close
// to the last, and the result goes out as frames. Same graph, same model files, same settings as
// the preset's template (`stylizedRealism.ts` before #1715).
//
// 🔴 THE v30 → v31 MIGRATION WRITES THIS FILE INTO OLD PROJECTS (`migrations.ts`
// `migratePresetsToWorkflowFiles`). Changing it changes what an old project migrates to; pin a
// copy in the migration first if this file has to change.

import type { ComfyApiJson, ComfyGraphMeta } from './comfyGraph';

/** The stylized-realism workflow: SDXL with ControlNet depth + normal, img2img on the previous
 *  frame. Node ids kept from the preset's template; the LoadImage placeholders became markers. */
export const STYLIZED_REALISM_WORKFLOW: ComfyApiJson = {
  '1': { class_type: 'KSamplerSeedSet', inputs: { seed: 0 } },
  '2': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
  },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: ['20', 0], clip: ['2', 1] } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: ['21', 0], clip: ['2', 1] } },
  '5': {
    class_type: 'basher_controller',
    inputs: { name: 'beauty', kind: 'video', values_json: '[]', frame_count: 0, video: '' },
  },
  '6': {
    class_type: 'basher_controller',
    inputs: { name: 'depth', kind: 'video', values_json: '[]', frame_count: 0, video: '' },
  },
  '7': {
    class_type: 'basher_controller',
    inputs: { name: 'normal', kind: 'video', values_json: '[]', frame_count: 0, video: '' },
  },
  '8': {
    class_type: 'basher_controller',
    inputs: {
      name: 'prev_frame_image',
      kind: 'image',
      values_json: '[]',
      frame_count: 0,
      image: '',
      feedback_of: 'stylized',
    },
  },
  '9': {
    class_type: 'ControlNetApply',
    inputs: {
      conditioning: ['3', 0],
      control_net: 'control_depth_xl.safetensors',
      image: ['6', 0],
      strength: 0.7,
    },
  },
  '10': {
    class_type: 'ControlNetApply',
    inputs: {
      conditioning: ['9', 0],
      control_net: 'control_normal_xl.safetensors',
      image: ['7', 0],
      strength: 0.5,
    },
  },
  '11': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['2', 2] } },
  '12': {
    class_type: 'KSampler',
    inputs: {
      seed: ['1', 0],
      steps: 20,
      cfg: 6.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 0.55,
      model: ['2', 0],
      positive: ['10', 0],
      negative: ['4', 0],
      latent_image: ['11', 0],
    },
  },
  '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['2', 2] } },
  '14': {
    class_type: 'basher_export',
    inputs: { name: 'stylized', kind: 'video', images: ['13', 0] },
  },
  '20': {
    class_type: 'basher_controller',
    inputs: { name: 'prompt', kind: 'string', values_json: '[""]', frame_count: 1 },
  },
  '21': {
    class_type: 'basher_controller',
    inputs: { name: 'negative', kind: 'string', values_json: '[""]', frame_count: 1 },
  },
};

export const STYLIZED_REALISM_META: ComfyGraphMeta = {
  name: 'Stylized realism',
  importedAt: 'builtin',
  fps: 30,
  frames: 1,
};

/** Workflow files Basher ships, by name: what the agent's AI-pass tool offers. */
export const BUILTIN_WORKFLOWS: Readonly<
  Record<string, { readonly apiJson: ComfyApiJson; readonly meta: ComfyGraphMeta }>
> = {
  stylizedRealism: { apiJson: STYLIZED_REALISM_WORKFLOW, meta: STYLIZED_REALISM_META },
};
