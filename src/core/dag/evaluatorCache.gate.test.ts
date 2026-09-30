// #1386 — every production walk of the graph that starts with no cache held, each with a reason.
//
// ── WHY A CENSUS AND NOT A REQUIRED PARAMETER ─────────────────────────────────────────
//
// Whether a pure node costs once per graph change or once per frame is decided by the CALLER.
// The resolvers take `cache?` optionally, so a call that omits it typechecks and reads as
// correct: one such call made the Camera Path + AI Walk example run at 6 fps (#1314), and the
// export ran the walk's whole-clip retarget three times per frame (#1318). Making `cache`
// required would force a decision at ~700 test calls and turn every forwarding resolver's
// optional parameter into a required one — churn in code that needs no cache. So the decision
// is recorded where it is made: a new production call that starts a walk with no cache reds
// here until it is listed with a reason.
//
// ── WHAT THE CENSUS SEES ──────────────────────────────────────────────────────────────
//
// `tools/gates/cacheCensus.ts` resolves every call through the TypeScript checker and
// classifies what reaches the cache parameter by its type (pass / forward / orphan / none /
// fresh). Only origins are listed below — `none`, `fresh` (a cache made inline, which dies with
// the call) and `orphan` (a maybe-undefined cache in a function that was never handed one).
// A `forward` is not a gap: the chain it belongs to starts at an origin, which is its own row.
//
// ── THE HONEST LIMIT ──────────────────────────────────────────────────────────────────
//
// A row's reason is a recorded judgement, not a measurement the test re-runs. What the test
// enforces is that the set is closed: no origin joins, leaves or multiplies silently. The
// per-frame rows are the work list, and each names the issue that decides it.
//
// REF: tools/gates/cacheCensus.ts; src/core/dag/evaluator.ts (`EvaluatorCache`, cache key);
//      issues #1314 #1315 #1318 #1385 #1386 #1389 #1394.

import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { originSites, runCacheCensus, type CacheCensus } from '../../../tools/gates/cacheCensus';

/** How often a site runs, which is what decides whether starting with nothing held costs. */
type Frequency =
  /** Once per discrete user action (click, key, menu command, drag commit) or agent tool call. */
  | 'per-action'
  /** At boot, once per load, or only through a dev/test hook. */
  | 'once'
  /** On a graph or selection change, not per frame. Each names the issue that decides it. */
  | 'per-edit'
  /** Once per render job (not per frame of it). */
  | 'per-job'
  /** Per frame or per playhead change. Each names the issue that decides it. */
  | 'per-frame'
  /** The missing cache is deliberate; `why` says what a shared one would break. */
  | 'deliberate';

interface Origin {
  /** Calls at this site (same file, enclosing function and callee). */
  count: number;
  frequency: Frequency;
  why: string;
  issue?: number;
}

const ORIGINS: Record<string, Origin> = {
  'src/agent/mutators/builders/addModifier.ts · preconditions → canModifyGeometry': {
    count: 1,
    frequency: 'per-action',
    why: 'Mutator validation, once per add-modifier dispatch.',
  },
  'src/app/asset/bakeGeneratedClip.ts · bakeGeneratedClipOps → clipBakeStates': {
    count: 1,
    frequency: 'per-action',
    why: 'Cook or Generate click, or the motion-generate agent tool.',
  },
  'src/app/asset/cookMotionGenerations.ts · cookMotionGenerations → clipBakeStates': {
    count: 1,
    frequency: 'per-action',
    why: 'The Cook click.',
  },
  'src/app/asset/cookMotionGenerations.ts · hasStaleGenerations → clipBakeStates': {
    count: 1,
    frequency: 'per-action',
    why: 'No production caller today; its own header asks the surface that wires it to hand a cache.',
  },
  'src/app/asset/placeGeneratedMotion.ts · placeCookedMotionOps → clipBakeStates': {
    count: 1,
    frequency: 'per-action',
    why: 'Once per cook, after the clips land.',
  },
  'src/app/asset/resolveMotionGenerate.ts · pendingGenerations → clipBakeStates': {
    count: 1,
    frequency: 'per-action',
    why: 'Motion cook or the motion-generate agent tool.',
  },
  'src/app/boot.ts · boot → resolveMeshUVSpace': {
    count: 2,
    frequency: 'once',
    why: 'Two dev hooks reading the UV layout and backdrop for e2e.',
  },
  'src/app/exposeParams.ts · exposeParams → canApplyTransform': {
    count: 1,
    frequency: 'per-action',
    why: 'Only when the caller hands no answer: promoteParam, once per promote. The N panel passes the answer its selector computed through the shared UI cache (#1315).',
  },
  'src/app/operatorStack.ts · buildAddMaterialOpOps → canWearMaterial': {
    count: 1,
    frequency: 'per-action',
    why: 'The add-material click or agent tool: the accept side of the offer.',
  },
  'src/app/operatorStack.ts · buildAddModifierOps → canModifyGeometry': {
    count: 1,
    frequency: 'per-action',
    why: 'The add-modifier click or agent tool: the accept side of the offer.',
  },
  'src/app/viewLock.ts · hasSomethingToFollow → scanForFollow': {
    count: 1,
    frequency: 'per-action',
    why: "The view-lock click: one scan to decide whether there is anything to follow. The frame loop's rescans hold a cache (#1388).",
  },
  'src/agent/critic/maskedWrites.ts · renderedValue → resolveEvaluatedParam': {
    count: 1,
    frequency: 'per-action',
    why: 'The critic checks each masked write once per agent tool result.',
  },
  'src/agent/mutators/builders/setObjectSlotMaterial.ts · slotCountOf → resolveEvaluatedMesh': {
    count: 1,
    frequency: 'per-action',
    why: 'Mutator validation, once per dispatch.',
  },
  'src/agent/tools/renderSummarizePass.ts · handler → evaluate': {
    count: 2,
    frequency: 'per-action',
    why: 'Agent render-summary tool: one evaluation per tool call.',
  },
  'src/agent/tools/renderSummarizeStylized.ts · handler → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Agent render-summary tool: one evaluation per tool call.',
  },
  'src/app/CameraLookAtTarget.tsx · bindLookAtTargetOps → resolveTrackToTarget': {
    count: 1,
    frequency: 'per-action',
    why: "The look-at target dropdown's change handler.",
  },
  'src/app/KeyboardShortcuts.tsx · onKey → resolveEvaluatedTransform': {
    count: 1,
    frequency: 'per-action',
    why: 'The insert-keyframe key.',
  },
  'src/app/NPanel.tsx · takeOver → buildOverrideSlotOp': {
    count: 1,
    frequency: 'per-action',
    why: 'The slot take-over click.',
  },
  'src/app/animate/bakePose.ts · bakePose → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Bake Pose click or agent mutator: one evaluation per dispatch.',
  },
  'src/app/animate/dispatchApplyTransform.ts · dispatchApplyGltfChild → resolveEvaluatedMesh': {
    count: 1,
    frequency: 'per-action',
    why: 'Apply Transform on an imported child.',
  },
  'src/app/animate/dispatchApplyTransform.ts · dispatchApplyTransform → resolveEvaluatedMesh': {
    count: 1,
    frequency: 'per-action',
    why: 'Apply Transform menu or key.',
  },
  'src/app/animate/dispatchApplyTransform.ts · importedChildPlacement → resolveParentWorldMatrix': {
    count: 1,
    frequency: 'per-action',
    why: 'Apply Transform on an imported child.',
  },
  'src/app/animate/dispatchApplyTransform.ts · importedChildPlacement → resolveWorldTransform': {
    count: 1,
    frequency: 'per-action',
    why: 'Apply Transform on an imported child.',
  },
  'src/app/animate/dispatchApplyTransform.ts · isGltfChildClipDriven → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Apply Transform on an imported child; the inline fresh cache dies with the action.',
  },
  'src/app/asset/bakeGeneratedClip.ts · bakeGeneratedClipOps → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Cook or Generate click, or the motion-generate agent tool.',
  },
  'src/app/asset/motionPathFromCurve.ts · waypointsFromCurve → curveSamplerFor': {
    count: 1,
    frequency: 'per-action',
    why: 'Generate click or motion cook: samples the selected curve once.',
  },
  'src/app/asset/placeGeneratedMotion.ts · placeCookedMotionOps → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Placing a cooked motion after Cook or Generate.',
  },
  'src/app/asset/regenerationShift.ts · layerPose → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Motion cook: regeneration shift, once per cook.',
  },
  'src/app/asset/resolveMotionGenerate.ts · pendingGenerations → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Motion cook or the motion-generate agent tool.',
  },
  'src/app/boot.ts · boot → evaluate': {
    count: 1,
    frequency: 'once',
    why: 'DEV-only window hook for e2e.',
  },
  'src/app/boot.ts · boot → readCurveSampleAt': {
    count: 1,
    frequency: 'once',
    why: 'DEV-only window hook for e2e.',
  },
  'src/app/boot.ts · boot → resolveEvaluatedMesh': {
    count: 4,
    frequency: 'once',
    why: 'DEV-only window hooks for e2e.',
  },
  'src/app/boot.ts · boot → resolveEvaluatedParam': {
    count: 1,
    frequency: 'once',
    why: 'DEV-only window hook for e2e.',
  },
  'src/app/boot.ts · boot → resolveEvaluatedTransform': {
    count: 1,
    frequency: 'once',
    why: 'DEV-only window hook for e2e.',
  },
  'src/app/boot.ts · boot → resolveWorldTransform': {
    count: 1,
    frequency: 'once',
    why: 'DEV-only window hook for e2e.',
  },
  'src/app/boot.ts · compositeFrame → captureCompositeFrame': {
    count: 1,
    frequency: 'once',
    why: 'Dev hook for the census harness: composites one frame per call. The viewer and the export hold a cache (#1389).',
  },
  'src/app/character/framing.ts · anchorForNode → evaluate': {
    count: 1,
    frequency: 'per-action',
    why: 'Frame Selected / Frame All (key, menu or toolbar).',
  },
  'src/app/character/framing.ts · skeletonObjectBounds → collectSkeletonObjects': {
    count: 1,
    frequency: 'per-action',
    why: 'Frame Selected on a character.',
  },
  'src/app/exposeParams.ts · exposedTargetResolver → exposeParams': {
    count: 1,
    frequency: 'per-action',
    why: 'A write road asking who owns a param (resolveExposedTarget), and a channel picker built once per graph state; each evaluates only for a chain holding a material operator. The N panel and the viewport pass the shared UI cache (#1394).',
  },
  'src/app/lightBrush.ts · buildLightBrushOp → resolveRigTarget': {
    count: 1,
    frequency: 'per-action',
    why: 'A click on a mesh while the Light Brush is active.',
  },
  'src/app/promoteParam.ts · resolveControlHost → exposeParams': {
    count: 1,
    frequency: 'per-action',
    why: 'One promote click; evaluates only for a chain holding a material operator.',
  },
  'src/app/statefulOps.ts · cookSolverStep → evaluate': {
    count: 1,
    frequency: 'deliberate',
    why: 'The injected previous-frame value makes the sub-graph frame-dependent; a shared cache would poison across frames (see its doc comment).',
  },
  'src/app/statefulOps.ts · cookSolverVecStep → evaluate': {
    count: 1,
    frequency: 'deliberate',
    why: 'Same as cookSolverStep: the injection is frame-dependent, so each step walks fresh.',
  },
  'src/app/video/compileComfyBatch.ts · bakeBasherControllerValues → resolveEvaluatedParam': {
    count: 1,
    frequency: 'per-job',
    why: 'Render coherent clip: one walk per frame x controller of the batch, each uncached; unmeasured (#1318).',
    issue: 1318,
  },
  'src/app/video/compileComfyBatch.ts · bakeComfyBatchedTracks → resolveEvaluatedParam': {
    count: 1,
    frequency: 'per-job',
    why: 'Render coherent clip: one walk per frame x param of the batch, each uncached; unmeasured (#1318).',
    issue: 1318,
  },
  'src/render/dryRun.ts · dryRun → evaluate': {
    count: 2,
    frequency: 'per-action',
    why: 'Cost preview Estimate click or the dry-run agent tool; evaluates one probe frame, not a loop (#1318).',
  },
  'src/test-utils/evaluateNodeAlone.ts · evaluateNodeAlone → evaluate': {
    count: 1,
    frequency: 'once',
    why: 'Test helper under src/test-utils; no production caller.',
  },
  'src/viewport/BoxSelectController.tsx · commit → resolveFollowedWorldPosition': {
    count: 1,
    frequency: 'per-action',
    why: 'Box-select commit, once per selectable node.',
  },
  'src/viewport/BoxSelectController.tsx · commit → resolveWorldTransform': {
    count: 1,
    frequency: 'per-action',
    why: 'Box-select commit, once per selectable node.',
  },
};

/** Every function that takes a cache, as `name@file`. Pinned so the census cannot narrow. */
const TAKERS: string[] = [
  'canApplyTransform@src/app/animate/dispatchApplyTransform.ts',
  'canModifyGeometry@src/app/modifierGeometry.ts',
  'canWearMaterial@src/app/modifierGeometry.ts',
  'clipBakeStates@src/app/asset/bakeGeneratedClip.ts',
  'motionCookOffer@src/app/asset/cookMotionGenerations.ts',
  'resolveMeshUVSpace@src/app/resolveMeshUVSpace.ts',
  'resolveDataKind@src/app/modifierGeometry.ts',
  'scanForFollow@src/viewport/followScan.ts',
  'collectCompositeInputs@src/app/video/compositeDecode.ts',
  'captureCompositeFrame@src/app/video/compositeDecode.ts',
  'aimTargetWorld@src/app/nodeConstraints.ts',
  'appendComputedSourceRows@src/timeline/layerChannelRows.ts',
  'applyGhostPoseBand@src/viewport/DiffOverlay.tsx',
  'buildOverrideSlotOp@src/app/objectSlotAuthoring.ts',
  'collectSkeletonObjects@src/app/skeletonObjects.ts',
  'computedSourceRows@src/timeline/layerChannelRows.ts',
  'curveSamplerFor@src/app/curveSampleSource.ts',
  'drawnArmature@src/app/gltfNodeWorld.ts',
  'drawnChannels@src/app/resolveWorldTransform.ts',
  'driverChannelValuesForTarget@src/app/paramDrivers.ts',
  'evaluate@src/core/dag/evaluator.ts',
  'foldOverlays@src/app/cookState.ts',
  'gltfNodeWorldPosition@src/app/gltfNodeWorld.ts',
  'gltfTerrainMeshes@src/app/geometrySampleSource.ts',
  'makeStatefulDriverChannelValue@src/app/statefulOps.ts',
  'nativeBoneWorldPosition@src/app/gltfNodeWorld.ts',
  'nodeRefCandidates@src/app/nodeRefCandidates.ts',
  'objectSlotTable@src/app/objectSlotAuthoring.ts',
  'overlaidAt@src/app/resolveWorldTransform.ts',
  'overlaidPaths@src/app/cookState.ts',
  'readCurveSampleAt@src/app/curveSampleSource.ts',
  'readTerrainSampleAt@src/app/geometrySampleSource.ts',
  'readTransformChannelAt@src/app/transformChannelSource.ts',
  'readTransformPositionAt@src/app/transformChannelSource.ts',
  'replayLag@src/app/statefulOps.ts',
  'replaySolver@src/app/statefulOps.ts',
  'replaySolverVec@src/app/statefulOps.ts',
  'resolveActiveCameraPoseAt@src/app/activeCamera.ts',
  'resolveActiveRigCenter@src/app/studioLightRig.ts',
  'resolveCameraDofAt@src/app/activeCamera.ts',
  'resolveCameraFrustumPose@src/app/activeCamera.ts',
  'resolveCameraPoseAt@src/app/activeCamera.ts',
  'resolveConstraintPosition@src/app/nodeConstraints.ts',
  'resolveConstraintRotation@src/app/nodeConstraints.ts',
  'resolveEvaluatedMesh@src/app/resolveEvaluatedMesh.ts',
  'resolveEvaluatedParam@src/app/resolveEvaluatedParam.ts',
  'resolveEvaluatedTransform@src/app/resolveEvaluatedTransform.ts',
  'resolveFollowedWorldPosition@src/app/nodeConstraints.ts',
  'resolveParentWorldMatrix@src/app/resolveWorldTransform.ts',
  'resolvePrimitiveTransform@src/app/resolveEvaluatedMesh.ts',
  'resolveRigTarget@src/app/studioLightRig.ts',
  'resolveTrackToTarget@src/app/nodeConstraints.ts',
  'resolveTransformParam@src/app/resolveTransformParam.ts',
  'resolveWorldTransform@src/app/resolveWorldTransform.ts',
  'slotAbsenceOf@src/app/objectSlotAuthoring.ts',
  'statefulInputAt@src/app/statefulOps.ts',
  'statefulInputVecAt@src/app/statefulOps.ts',
  'underParent@src/app/resolveWorldTransform.ts',
  'walk@src/app/resolveWorldTransform.ts',
  'walkParent@src/app/resolveWorldTransform.ts',
  'dataLaneOverlaySources@src/app/dataLaneOverlay.ts',
  'exposeParams@src/app/exposeParams.ts',
  'mapPresenceBelow@src/app/resolveMaterialFieldOwner.ts',
  'maskedFieldsOf@src/app/resolveMaterialFieldOwner.ts',
  'resolveMaterialFieldOwners@src/app/resolveMaterialFieldOwner.ts',
  'withMaterialMasking@src/app/exposeParams.ts',
];

// ── Controls: a file the census reads alongside `src/`, one call per classification ──────

const CONTROL_FILE = join(__dirname, '__cacheCensusControl__.ts');
const CONTROL = `
import { createEvaluatorCache, evaluate, type EvaluatorCache } from './evaluator';
import type { DagState } from './state';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';

const held = createEvaluatorCache();
const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

export function ctlNone(s: DagState) { return evaluate(s, 'x'); }
export function ctlNoneBag(s: DagState) { return evaluate(s, 'x', { ctx }); }
export function ctlNonePositional(s: DagState) { return resolveWorldTransform(s, 'x', ctx); }
export function ctlFresh(s: DagState) { return evaluate(s, 'x', { cache: createEvaluatorCache() }); }
export function ctlPass(s: DagState) { return evaluate(s, 'x', { cache: held }); }
export function ctlPassPositional(s: DagState) { return resolveWorldTransform(s, 'x', ctx, held); }
export function ctlForward(s: DagState, cache?: EvaluatorCache) { return evaluate(s, 'x', { cache }); }
export function ctlOrphan(s: DagState, keep: boolean) {
  const cache = keep ? held : undefined;
  return resolveWorldTransform(s, 'x', ctx, cache);
}
export function ctlOrphanInTaker(s: DagState, cache?: EvaluatorCache) {
  const own = cache && Math.random() > 0.5 ? held : undefined;
  return resolveWorldTransform(s, 'x', ctx, own);
}
export function ctlForwardThroughBag(s: DagState, opts: { cache?: EvaluatorCache }) {
  const at = { ...opts, ctx };
  return evaluate(s, 'x', at);
}
`;

const CONTROL_REL = 'src/core/dag/__cacheCensusControl__.ts';

describe('#1386 — production walks that start with no cache held', () => {
  let census: CacheCensus;
  let product: CacheCensus;
  beforeAll(() => {
    census = runCacheCensus({ [CONTROL_FILE]: CONTROL });
    product = {
      takers: census.takers.filter((t) => t.file !== CONTROL_REL),
      calls: census.calls.filter((c) => c.file !== CONTROL_REL),
    };
  }, 120_000);

  it('classifies each control call by what reaches the cache', () => {
    const got = Object.fromEntries(
      census.calls.filter((c) => c.file === CONTROL_REL).map((c) => [c.enclosing, c.arg]),
    );
    expect(got).toEqual({
      ctlNone: 'none',
      ctlNoneBag: 'none',
      ctlNonePositional: 'none',
      ctlFresh: 'fresh',
      ctlPass: 'pass',
      ctlPassPositional: 'pass',
      ctlForward: 'forward',
      ctlOrphan: 'orphan',
      // #1390 — inside a function that takes a cache, a maybe-undefined local it made itself
      // is still an origin; its own options object handed on is not.
      ctlOrphanInTaker: 'orphan',
      ctlForwardThroughBag: 'forward',
    });
    // A function that forwards its own optional cache becomes a taker itself.
    expect(census.takers.map((t) => `${t.name}@${t.file}`)).toContain(`ctlForward@${CONTROL_REL}`);
  });

  it('reads real calls the way they were fixed or left', () => {
    const at = (file: string, enclosing: string) =>
      product.calls.filter((c) => c.file === file && c.enclosing === enclosing).map((c) => c.arg);
    // #1385 — a still shares one cache across its three walks.
    expect(at('src/app/renderImageAction.ts', 'renderActiveProjectBlob')).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
    // The Comfy batch bakes were left for the census (#1318): they start with none.
    expect(at('src/app/video/compileComfyBatch.ts', 'bakeComfyBatchedTracks')).toEqual(['none']);
  });

  it('sees every function that takes a cache', () => {
    expect(product.takers.map((t) => `${t.name}@${t.file}`).sort()).toEqual([...TAKERS].sort());
  });

  it('lists every origin site, each with its count and a reason', () => {
    const got = Object.fromEntries(originSites(product));
    const want = Object.fromEntries(Object.entries(ORIGINS).map(([k, o]) => [k, o.count]));
    expect(got).toEqual(want);
  });

  it('gives every per-frame or per-edit row an issue', () => {
    const open = Object.entries(ORIGINS)
      .filter(([, o]) => (o.frequency === 'per-frame' || o.frequency === 'per-edit') && !o.issue)
      .map(([k]) => k);
    expect(open).toEqual([]);
  });
});
