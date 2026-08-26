// Text-to-3D / image-to-3D ingestion surface — the HUMAN half of A4's three-way
// parity.
//
// Deliberately shaped as a sibling of `generateMotion.ts`, which is itself shaped
// as a sibling of the import chokepoint, because the phase's claim is that a
// generated mesh is indistinguishable from an imported one and this is the file
// where a director's route to it is decided.
//
// 🔑 IT IS THINNER THAN A1's, AND THE THINNESS IS THE CLAIM. A1 needed a chain
// module because BVH text has to become node params. A GLB does not: the existing
// glTF road already goes disk → OPFS → `importGltfFromOpfs`, so generation only
// has to supply the bytes and then step out of the way. What this file does, in
// full, is:
//
//     generate → ingestSingleFile → importGltfFromOpfs
//                └── the same ingest a dropped file takes
//                                    └── the same import a dropped file takes
//
// There is no op-building here, no assetRef minting, no dispatch. Both of the
// functions it calls are the ones the drop surface calls, unmodified. That is why
// A4's discriminating observation — the generated mesh takes the identical code
// path an imported GLB takes — is checkable rather than asserted: the path is
// two calls long and both callees are shared.
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - K6: ONE dispatchAtomic per generation — inherited, because
//     `importGltfFromOpfs` performs it and this file does not dispatch at all.
//   - V22: no Date.now / Math.random. The OPFS folder name is derived from the
//     request, and collision-suffixing is `resolveFreeImportName`'s job.
//   - silent-failure: a licence refusal, a malformed request, an unreachable
//     service or a rejected key surfaces in the banner, never console-only.
//
// REF: src/app/asset/generateMotion.ts (the sibling);
//      src/app/asset/importGltf.ts (the chokepoint);
//      src/agent/tools/modelGenerate.ts (the agent half);
//      ref/architecture/ai-track.md phase A4.

import { getModelCapability } from '../boot';
import { describeRequest, type ModelGenerationProgress } from '../../core/modelgen';
import type { ModelGenerationRequest, SourceImage } from '../../core/modelgen';
import { useSettingsStore } from '../stores/settingsStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { ingestSingleFile } from './importCommon';
import { importGltfFromOpfs } from './importGltf';

export interface GenerateModelOptions {
  /** Asset name — defaults to the prompt, exactly as an import defaults to the
   *  filename. */
  readonly name?: string;
  /** Surfaced so a caller can drive a progress bar, as the Blender plugin does. */
  readonly onProgress?: (p: ModelGenerationProgress) => void;
}

/** What the caller needs to render a result. `ok: false` never throws — the
 *  banner already carries the reason, and a throw would leave the surface that
 *  invoked it with no way to return to idle. */
export type GenerateModelResult =
  | { readonly ok: true; readonly opfsPath: string; readonly taskId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Generate a mesh and put it in the scene.
 *
 * The model version comes from settings rather than from the caller, matching the
 * agent tool and the motion surface: it is configuration, chosen once. The API
 * key likewise — and with none set, `getModelCapability` hands back the offline
 * stub, so this function works with no account at all.
 */
export async function generateModelIntoScene(
  request: ModelGenerationRequest,
  options: GenerateModelOptions = {},
): Promise<GenerateModelResult> {
  const subject = options.name ?? describeRequest(request);
  try {
    const capability = await getModelCapability();
    const { modelGenVersion } = useSettingsStore.getState();

    const { glb, taskId } = await capability.generate(
      // The caller's explicit version wins; otherwise the configured one. Named
      // rather than defaulted inside the capability so nothing picks silently.
      { ...request, modelVersion: request.modelVersion ?? modelGenVersion },
      options.onProgress,
    );

    // The SAME ingest a single dropped file takes — sanitisation, collision
    // suffixing and the OPFS write all belong to it, not here.
    const opfsPath = await ingestSingleFile(
      { relativePath: 'model.glb', bytes: new Uint8Array(glb) },
      subject,
    );

    // The SAME import a dropped file takes. It dispatches atomically, reports its
    // own failures to the banner, and bumps the My-Imports refresh signal.
    await importGltfFromOpfs(opfsPath);

    return { ok: true, opfsPath, taskId };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `generation failed: ${reason}`);
    return { ok: false, reason };
  }
}

/** Convenience for the common case, so a caller with only a prompt does not have
 *  to know the request union exists. */
export async function generateModelFromText(
  prompt: string,
  options: GenerateModelOptions = {},
): Promise<GenerateModelResult> {
  return generateModelIntoScene({ source: 'text', prompt }, options);
}

/** Convenience for the single-image case. */
export async function generateModelFromImage(
  image: SourceImage,
  options: GenerateModelOptions = {},
): Promise<GenerateModelResult> {
  return generateModelIntoScene({ source: 'image', image }, options);
}
