// Generate a character and give it a skeleton, in one action.
//
// The third road in the Generate panel, and the first caller `pickRigging` has
// ever had in the app. Before this, the rig capability was complete, tested, and
// reachable only from a throwaway node harness.
//
// 🔑 IT IS ONE ACTION BECAUSE `RigSubject` IS `{ sourceTaskId }`. Tripo rigs a
// TASK, not a mesh — only something that service just made can be rigged, and
// nothing in our model can rig an arbitrary `.glb` sitting in the scene. Split
// across two director-facing steps, that constraint would have to be explained,
// enforced, and then still misunderstood the first time someone tries to rig an
// imported asset. Fused into one action the task id never escapes, so the
// constraint is structural instead of a rule someone has to know.
//
// 🔑 THE GENERATED MESH IS DELIBERATELY DISCARDED. `generate` returns a GLB and
// so does `rig`; importing both would put two meshes in the scene, one of them
// boneless and indistinguishable at a glance. Only the rigged GLB is ingested —
// it carries the same mesh plus its skin.
//
//     generate → taskId → checkRiggable → rig → ingestSingleFile → importGltfFromOpfs
//                                                └── the same two calls a dropped
//                                                    file takes, unmodified
//
// The pre-check is not skippable politeness. A rig is billable and slow, and
// "this is not riggable" is a fact a director should get in seconds with a
// reason rather than in minutes with a task failure — so it runs before the
// second charge, and refuses without spending it.
//
// Invariants honored:
//   - V8: app-layer, no `src/viewport/` imports.
//   - K6: one atomic dispatch per action — inherited from `importGltfFromOpfs`,
//     which is the only thing here that dispatches.
//   - V22: no Date.now / Math.random.
//   - silent-failure: every refusal reaches the banner, never console-only.
//
// REF: src/app/asset/generateModel.ts (the sibling it composes);
//      src/core/rigging/RiggingCapability.ts (RigSubject, the constraint);
//      ref/architecture/ai-track.md phase A4; issues #795, #804.

import { getModelCapability, getRiggingCapability } from '../boot';
import { describeRequest } from '../../core/modelgen';
import type { ModelGenerationRequest } from '../../core/modelgen';
import { DEFAULT_RIG_SPEC, classifyRigSpec } from '../../core/rigging';
import type { RigSpec, RigType } from '../../core/rigging';
import { useSettingsStore } from '../stores/settingsStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { ingestSingleFile } from './importCommon';
import { importGltfFromOpfs } from './importGltf';

/**
 * Which half of the action is running.
 *
 * 🔑 A SINGLE 0–100 BAR WOULD LIE HERE. Two billable tasks run in sequence, each
 * reporting its own 0–100, so one bar would fill, snap back to zero, and fill
 * again — which reads as a restart. The phase is carried so the surface can say
 * WHICH thing is at 40%.
 */
export type RiggedPhase = 'generating' | 'checking' | 'rigging' | 'importing';

export interface RiggedCharacterProgress {
  readonly phase: RiggedPhase;
  /** 0–100 WITHIN the phase, exactly as the underlying capability reports it. */
  readonly percent: number;
}

export interface GenerateRiggedCharacterOptions {
  readonly name?: string;
  readonly onProgress?: (p: RiggedCharacterProgress) => void;
  /** Defaults to `mixamo`, which is what the retarget road expects. */
  readonly spec?: RigSpec;
  readonly rigType?: RigType;
}

/**
 * Three outcomes, and `ok` is deliberately NOT one of the fields (#835).
 *
 * A refused rig is neither success nor failure: a real mesh was generated and
 * BILLED, and only the skeleton is missing. Expressed as `ok: true` the panel's
 * `result.ok ? ...` would report a plain success and the director would be told
 * they got a character — a label that lies while every test reading it passes.
 * Expressed as `ok: false` it would report a failure and discard a mesh that
 * exists, which is the defect being fixed.
 *
 * So the field every caller already branches on is GONE, and the compiler names
 * each site instead of letting one quietly pick a side. There is exactly one
 * production caller, so the cost of that is a line; the cost of the alternative
 * is a director paying for a model and being told they got nothing.
 */
export type GenerateRiggedCharacterResult =
  | {
      readonly outcome: 'rigged';
      readonly opfsPath: string;
      /** The GENERATION task. The rig's own id is not surfaced: nothing
       *  downstream can act on it, and two ids invite using the wrong one. */
      readonly taskId: string;
      /** What the returned GLB's bone names actually classify as — READ from the
       *  result, never the spec that was requested. */
      readonly arrivedSpec: ReturnType<typeof classifyRigSpec>;
    }
  | {
      /** The mesh landed; the service would not rig it. The director has the
       *  thing they paid for, minus its skeleton. */
      readonly outcome: 'unrigged';
      readonly opfsPath: string;
      readonly taskId: string;
      /** What the service said about the body plan, so the sentence a director
       *  reads is the service's answer rather than a guess about it. */
      readonly reason: string;
    }
  | { readonly outcome: 'failed'; readonly reason: string };

/**
 * Generate a mesh, rig it, and put the rigged result in the scene.
 *
 * The request is the same union text-to-3D takes, so an image reference works
 * here exactly as it does there — a character can be generated from a reference
 * picture and come back skinned.
 */
export async function generateRiggedCharacter(
  request: ModelGenerationRequest,
  options: GenerateRiggedCharacterOptions = {},
): Promise<GenerateRiggedCharacterResult> {
  const subject = options.name ?? describeRequest(request);
  const report = (p: RiggedCharacterProgress): void => options.onProgress?.(p);
  try {
    const [generation, rigging] = await Promise.all([getModelCapability(), getRiggingCapability()]);
    const { modelGenVersion } = useSettingsStore.getState();

    report({ phase: 'generating', percent: 0 });
    // 🔑 THE MESH IS NOT FETCHED HERE, AND MUST NOT BE. Rigging runs service-side
    // against the task id — `checkRiggable` and `rig` both take `sourceTaskId` —
    // so this road never had a use for the bytes. Taking the wide result and
    // binding only `taskId` downloaded a mesh (measured: 7,465,804 bytes) and
    // discarded it, and that discarded download is the step that made rigged
    // generation unreachable from a browser at all (#832, #833).
    const task = await generation.generateTaskOnly(
      { ...request, modelVersion: request.modelVersion ?? modelGenVersion },
      (p) => report({ phase: 'generating', percent: p.progress }),
    );

    // Before the second charge, not after it.
    report({ phase: 'checking', percent: 0 });
    const { taskId } = task;
    const check = await rigging.checkRiggable({ sourceTaskId: taskId });
    if (!check.riggable) {
      // 🔑 `detectedRigType: null` means the service did not answer, which is not
      // the same as "no recognisable body" — so the message says which of the two
      // happened rather than inventing a body plan it was never told.
      const detected =
        check.detectedRigType === null
          ? 'it did not say what body plan it saw'
          : `it saw a "${check.detectedRigType}"`;
      const reason =
        `the service will not rig this mesh — ${detected}. ` +
        'Try a prompt that describes a single full-body character.';

      // 🔑 THE MESH IS COLLECTED HERE AND NOWHERE ELSE (#835). By this line a
      // generation task has run and been BILLED, and a real mesh exists on the
      // service — it is simply not riggable. Throwing left the director with a
      // sentence and no way to see what they paid for except by hunting the task
      // down outside Basher, which is the worst moment to discard a result.
      //
      // This is not a reversal of #833. That removed a download whose bytes were
      // NEVER used; these bytes are wanted, on this branch only, which is the
      // download-when-it-has-a-use that #833 asked for. `collectGlb` fetches the
      // output of the task already run — never a second one, which would bill
      // twice and be a worse bug than the one being fixed.
      report({ phase: 'importing', percent: 0 });
      const glb = await task.collectGlb();
      const unriggedPath = await ingestSingleFile(
        { relativePath: 'model.glb', bytes: new Uint8Array(glb) },
        subject,
      );
      await importGltfFromOpfs(unriggedPath);
      report({ phase: 'importing', percent: 100 });

      // Reported, never silent: the director asked for a character and has a
      // model, and the difference is invisible in the viewport until they try to
      // animate it. The banner is the only register this surface has — whether a
      // degraded success deserves its own is an open question on #835, and not
      // one to invent an answer to here. What is NOT open is that it must be
      // said, so it is said in the register that exists.
      useAssetErrorStore
        .getState()
        .report(subject, `generated, but not rigged: ${reason} The model is in your scene.`);
      return { outcome: 'unrigged', opfsPath: unriggedPath, taskId, reason };
    }

    report({ phase: 'rigging', percent: 0 });
    const rigged = await rigging.rig(
      {
        sourceTaskId: taskId,
        spec: options.spec ?? DEFAULT_RIG_SPEC,
        ...(options.rigType ? { rigType: options.rigType } : {}),
      },
      (p) => report({ phase: 'rigging', percent: p.progress }),
    );

    report({ phase: 'importing', percent: 0 });
    const opfsPath = await ingestSingleFile(
      { relativePath: 'character.glb', bytes: new Uint8Array(rigged.glb) },
      subject,
    );
    await importGltfFromOpfs(opfsPath);
    report({ phase: 'importing', percent: 100 });

    return {
      outcome: 'rigged',
      opfsPath,
      taskId,
      // Read off the bytes that arrived. `requestedSpec` is what we ASKED for,
      // and a result reporting the skeleton it asked for is a label that can be
      // wrong while every test reading it passes.
      arrivedSpec: classifyRigSpec(boneNamesOf(rigged.glb)),
    };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `rigged generation failed: ${reason}`);
    return { outcome: 'failed', reason };
  }
}

/**
 * Bone names out of a GLB's JSON chunk.
 *
 * A local read rather than a full import: this only needs the names, and the
 * scene already has the mesh by the time it is asked.
 */
function boneNamesOf(glb: ArrayBuffer): string[] {
  try {
    const view = new DataView(glb);
    // glTF container: 12-byte header, then length-prefixed chunks. The first
    // chunk is JSON by specification.
    const jsonLength = view.getUint32(12, true);
    const json = new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength));
    const parsed = JSON.parse(json) as {
      nodes?: { name?: string }[];
      skins?: { joints?: number[] }[];
    };
    const nodes = parsed.nodes ?? [];
    return (parsed.skins ?? []).flatMap((skin) =>
      (skin.joints ?? []).map((i) => nodes[i]?.name ?? ''),
    );
  } catch {
    // An unreadable container is not a rig verdict. Empty names classify as
    // `unknown` — "I could not tell" — rather than as a negative claim about
    // the skeleton, which is the honest answer when we could not look.
    return [];
  }
}
