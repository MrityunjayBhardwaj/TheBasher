// stylizedRealism — the v0.5 starter ComfyUI preset (D-02 locked).
//
// SDXL with ControlNet-Depth + ControlNet-Normal conditioning, plus
// img2img on the prev-frame stylized output for temporal coherence.
// THESIS §28 lists this as the demo case for the AI render bridge.
//
// The workflow JSON below is a credible (but simplified) ComfyUI graph:
//   1  KSamplerSeedSet         → reproducible sampler
//   2  CheckpointLoaderSimple  → SDXL base
//   3  CLIPTextEncode          → positive prompt (text from PromptValue.text)
//   4  CLIPTextEncode          → negative prompt (PromptValue.negative)
//   5  LoadImage               → beauty (raw beauty pass bytes)
//   6  LoadImage               → depth  (raw depth pass bytes)
//   7  LoadImage               → normal (raw normal pass bytes)
//   8  LoadImage               → prev_frame_image (frame N-1 stylized OR zero)
//   9  ControlNetApply         → depth conditioning
//  10  ControlNetApply         → normal conditioning
//  11  VAEEncode               → encode prev_frame_image → latent
//  12  KSampler                → denoise (img2img low-strength)
//  13  VAEDecode               → latent → pixels
//  14  SaveImage               → write output (key the run reads back)
//
// A real ComfyUI server has ~30 nodes for this kind of workflow; this
// shape captures the structural commitments (which inputs flow where)
// without committing to specific model IDs / sampler configs that
// drift across ComfyUI releases. The workflow is a TEMPLATE — the
// compile() function plugs concrete prompt text + image filenames in
// before submission.
//
// REF: project_p5_context D-02 / D-03; THESIS §28, §44; vyapti V15
// (strategy resource lazy-fetched, not in system prompt).

import type { ComfyInputs, ComfyWorkflowJson } from '../../../core/comfy';
import type { ImageValue } from '../../../nodes/types';
import { framePath as stylizedFramePath } from '../../../render/dryRun';
import type { Preset, PresetCompileDeps } from './types';

const STYLIZED_REALISM_VERSION = '1';

/** Pre-built workflow template. Frozen — compile() deep-clones before
 *  mutating. Node ids are strings (ComfyUI convention). */
const STYLIZED_REALISM_TEMPLATE: ComfyWorkflowJson = {
  '1': {
    class_type: 'KSamplerSeedSet',
    inputs: { seed: 0 },
  },
  '2': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
  },
  '3': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '__POSITIVE__', clip: ['2', 1] },
  },
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '__NEGATIVE__', clip: ['2', 1] },
  },
  '5': {
    class_type: 'LoadImage',
    inputs: { image: 'beauty.png' },
  },
  '6': {
    class_type: 'LoadImage',
    inputs: { image: 'depth.png' },
  },
  '7': {
    class_type: 'LoadImage',
    inputs: { image: 'normal.png' },
  },
  '8': {
    class_type: 'LoadImage',
    inputs: { image: 'prev_frame_image.png' },
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
  '11': {
    class_type: 'VAEEncode',
    inputs: { pixels: ['8', 0], vae: ['2', 2] },
  },
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
  '13': {
    class_type: 'VAEDecode',
    inputs: { samples: ['12', 0], vae: ['2', 2] },
  },
  '14': {
    class_type: 'SaveImage',
    inputs: { images: ['13', 0], filename_prefix: 'stylized' },
  },
};

/**
 * Compile-time placeholders the template uses internally. Exposed so
 * tests + diagnostics can verify the substitution surface.
 */
export const STYLIZED_REALISM_PLACEHOLDERS = [
  '__POSITIVE__',
  '__NEGATIVE__',
  'beauty.png',
  'depth.png',
  'normal.png',
  'prev_frame_image.png',
] as const;

/**
 * Default zero-image bytes for the first frame (no antecedent stylized
 * output). 1×1 black PNG — same encoder as stubEncoder. Cheap, dep-free.
 */
const ZERO_FRAME_PNG = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  // IHDR chunk: 13 bytes — 1×1, 8-bit, color type 2 (RGB)
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53,
  0xde,
  // IDAT: zlib-wrapped raw deflate of (filter 0, R=0, G=0, B=0)
  0x00,
  0x00,
  0x00,
  0x10,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x01,
  0x01,
  0x04,
  0x00,
  0xfb,
  0xff,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x95,
  0x73,
  0x95,
  0xff,
  // IEND
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
);

/**
 * Derive the raw-pass directory from the workflow's outputPath. The
 * Mutator authors `outputPath = renders/${jobId}/stylized_${presetId}`;
 * raw passes from runRenderJob live at the parent directory:
 *
 *   workflowOutputPath = 'renders/job1/stylized_stylizedRealism'
 *   parentDir          = 'renders/job1'
 *   beauty path        = 'renders/job1/beauty_NNNN.png'
 */
function rawPassDir(workflowOutputPath: string): string {
  const trimmed = workflowOutputPath.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash < 0) return '';
  return trimmed.slice(0, lastSlash);
}

function rawPassPath(workflowOutputPath: string, passKind: string, frame: number): string {
  const dir = rawPassDir(workflowOutputPath);
  const padded = frame.toString().padStart(4, '0');
  return dir ? `${dir}/${passKind}_${padded}.png` : `${passKind}_${padded}.png`;
}

/**
 * Deep-clone the template + substitute prompt text fields. Returns a
 * new ComfyWorkflowJson; the original template stays frozen.
 */
function buildWorkflowJson(positive: string, negative: string): ComfyWorkflowJson {
  // Structured-clone via JSON round-trip is sufficient — the template
  // only contains JSON-safe primitives.
  const cloned = JSON.parse(JSON.stringify(STYLIZED_REALISM_TEMPLATE)) as Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
  cloned['3'].inputs.text = positive;
  cloned['4'].inputs.text = negative;
  return cloned as ComfyWorkflowJson;
}

/**
 * Read raw pass bytes from storage at the canonical runRenderJob path.
 * Throws if a required pass is missing — preconditions in addAIPass
 * Mutator + storage check in runRenderJob should prevent this from
 * firing in production.
 */
async function readPassBytes(
  storage: PresetCompileDeps['storage'],
  workflowOutputPath: string,
  passKind: string,
  frame: number,
): Promise<Uint8Array> {
  const path = rawPassPath(workflowOutputPath, passKind, frame);
  const exists = await storage.exists(path);
  if (!exists) {
    throw new Error(
      `stylizedRealism.compile: raw pass ${passKind} not found at ${path}. ` +
        'Run RenderJob to produce raw passes before submitting the AI workflow.',
    );
  }
  return await storage.read(path);
}

async function readPrevFrameBytes(
  storage: PresetCompileDeps['storage'],
  prevFrameStylizedPath: string | null | undefined,
): Promise<Uint8Array> {
  if (!prevFrameStylizedPath) return ZERO_FRAME_PNG;
  if (await storage.exists(prevFrameStylizedPath)) {
    return await storage.read(prevFrameStylizedPath);
  }
  // Path declared but missing — soft-fall to zero so frame 1 doesn't
  // crash if the file system was raced. The agent surfaces a warning.
  return ZERO_FRAME_PNG;
}

export const stylizedRealismPreset: Preset = {
  id: 'stylizedRealism',
  description:
    'SDXL with ControlNet-Depth + ControlNet-Normal conditioning + img2img on ' +
    'the prev-frame stylized output for temporal coherence. The demo case ' +
    'from THESIS §28. Requires Beauty + Depth + Normal raw passes on the ' +
    'upstream RenderJob.',
  requiredPasses: ['beauty', 'depth', 'normal'] as const,
  placeholders: STYLIZED_REALISM_PLACEHOLDERS,
  version: STYLIZED_REALISM_VERSION,
  compile({ storage }: PresetCompileDeps) {
    return async ({ prompt, frame, prevFrameStylizedPath, workflowOutputPath, passes }) => {
      // Validate required passes are wired (defense-in-depth — addAIPass
      // Mutator + V13 closure already checked this at compose time).
      const wiredKinds = new Set(passes.map((p) => p.passKind));
      for (const kind of stylizedRealismPreset.requiredPasses) {
        if (!wiredKinds.has(kind)) {
          throw new Error(
            `stylizedRealism.compile: required pass "${kind}" not wired into workflow. ` +
              'addAIPass Mutator should have ensured this — check the Diff before accept.',
          );
        }
      }

      const workflowJson = buildWorkflowJson(prompt.text, prompt.negative ?? '');
      const [beauty, depth, normal, prevFrame] = await Promise.all([
        readPassBytes(storage, workflowOutputPath, 'beauty', frame),
        readPassBytes(storage, workflowOutputPath, 'depth', frame),
        readPassBytes(storage, workflowOutputPath, 'normal', frame),
        readPrevFrameBytes(storage, prevFrameStylizedPath),
      ]);

      const inputs: ComfyInputs = {
        images: {
          beauty,
          depth,
          normal,
          prev_frame_image: prevFrame,
        },
        scalars: {
          prompt: prompt.text,
          negative: prompt.negative ?? '',
          tags: (prompt.tags ?? []).join(','),
          frame,
          stylizedFramePath: stylizedFramePath(workflowOutputPath, frame),
        },
      };

      return { workflowJson, inputs };
    };
  },
};

/**
 * Frozen registry — v0.5 ships exactly one preset (D-02 locked). v0.6's
 * meta-prompt-authored presets register against the same shape.
 */
export const PRESET_REGISTRY: ReadonlyMap<string, Preset> = new Map([
  [stylizedRealismPreset.id, stylizedRealismPreset],
]);

export function getPreset(id: string): Preset | undefined {
  return PRESET_REGISTRY.get(id);
}

export function listPresetIds(): readonly string[] {
  return Array.from(PRESET_REGISTRY.keys());
}

// Use `_` reference to keep `ImageValue` import live for IDE-jump even
// though the runtime path doesn't use it directly (passes is typed as
// ImageValue[] via CompileWorkflowFn).
const _imageValueRef: ImageValue | null = null;
void _imageValueRef;
