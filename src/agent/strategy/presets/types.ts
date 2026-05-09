// Preset registry types for the AI render bridge (P5).
//
// A Preset is a named ComfyUI workflow + the metadata needed to wire it
// into the DAG and validate the wiring. Each preset declares:
//   - id: stable string used by mutator.render.addAIPass(presetId)
//   - description: short human-readable label for the strategy resource
//   - requiredPasses: which raw passes (Beauty / Depth / Normal / etc.)
//     the workflow consumes — determines which addPass calls the
//     addAIPass Mutator emits
//   - placeholders: the literal placeholder names that appear in the
//     workflow JSON (compiler substitutes them at run time)
//   - version: pinned ComfyUI workflow format version — when ComfyUI's
//     workflow JSON evolves, the preset bumps and migrates
//   - compile: factory returning a CompileWorkflowFn bound to the
//     storage capability (storage holds the raw pass bytes the
//     compiler reads at run time)
//
// REF: project_p5_plan C1; project_p5_context D-02 / D-03;
// THESIS §28, §44.

import type { StorageCapability } from '../../../core/storage';
import type { CompileWorkflowFn } from '../../../render/dryRun';
import type { ImagePassKind } from '../../../nodes/types';

export interface PresetCompileDeps {
  readonly storage: StorageCapability;
}

export interface Preset {
  readonly id: string;
  readonly description: string;
  /** The raw passes this preset consumes. addAIPass ensures these are
   *  wired into the upstream RenderJob before adding the workflow. */
  readonly requiredPasses: readonly ImagePassKind[];
  /** Placeholder names the workflow JSON expects (used for diagnostics). */
  readonly placeholders: readonly string[];
  /** Pinned format version — bump when ComfyUI workflow JSON changes. */
  readonly version: string;
  /** Factory: bind to the runtime storage capability + return a
   *  CompileWorkflowFn that reads raw pass bytes from storage and
   *  substitutes them into the workflow JSON. */
  compile(deps: PresetCompileDeps): CompileWorkflowFn;
}
