// #582 — the census of who evaluates the graph, and which params each one needs.
//
// ── WHY A TABLE AND NOT JUST THE TYPES ────────────────────────────────────────────────
//
// `DagState` and `CookState` cannot be handed to each other's consumers, so once a
// consumer DECLARES which it takes, the compiler enforces it. What the compiler cannot do
// is make anyone declare. A new module that evaluates the graph takes `DagState` by
// default, reads authored params part-way through an animation, and computes exactly the
// value a correct one would compute in every static scene — the failure this epic exists
// for, arriving through the door marked "wrote no annotation".
//
// So the set of evaluator consumers is pinned here, EXACTLY, each with a stated reason.
// Adding one is a red that asks a question; the answer is one line in this table, which is
// where the argument belongs.
//
// ── ⚠️ WHAT THIS IS AND IS NOT — THE HONEST LIMIT ─────────────────────────────────────
//
// This is a DECISION RECORD plus a census. It is not proof that any consumer's signature
// matches its row.
//
// #583 moved ONE row from record to fact: the render root now evaluates a `CookState`,
// folded on the refold-safe tier. Every other consumer still takes `DagState`, and every
// remaining 'cooked' row still records what that consumer SHOULD be handed rather than
// what it takes today. Those rows are the work list for the slices after this one.
//
// The strengthening is real and it stops exactly there: the set is closed, each member has
// an argued reason, and a new evaluator consumer cannot join silently. Claiming more —
// that the rows are enforced today — would be the kind of sentence this epic has already
// been burned by twice.
//
// REF: src/core/dag/state.ts (the two types), src/app/cookState.ts (`foldOverlays`, the
//      only minter of `CookState`), tools/gates/sourceFiles.ts (the shared enumeration),
//      src/app/registryDoors.gate.test.ts (the census idiom this follows); issues #582,
//      #575.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

/** Why a consumer needs params AT THE PLAYHEAD. */
type CookedReason =
  /** Builds geometry or a mesh face that something draws. */
  | 'renders-geometry-at-t'
  /** Samples a surface or a path and hands the result to something that moves. */
  | 'samples-geometry-at-t'
  /** Writes a frame to disk — the value at that frame is the deliverable. */
  | 'exports-a-frame'
  /** Describes a frame to the agent, which is a claim about that frame. */
  | 'describes-a-frame';

/** Why a consumer must keep the params the director authored. */
type AuthoredReason =
  /**
   * Applies overlays at its own seam. Folding twice is WRONG, not redundant: `combine`
   * blends onto the base and `replace` lerps from it whenever influence < 1.
   */
  | 'folds-its-own-overlays'
  /** Part of the overlay machinery. Feeding it folded params would be circular. */
  | 'produces-an-overlay'
  /** Hands state straight to a resolver that folds, so it must pass authored through. */
  | 'delegates-to-a-folding-resolver'
  /** Reads or writes what the director typed — ops, undo, an authoring panel. */
  | 'edits-authored-values'
  /** Evaluates at a ctx that is deliberately NOT the playhead (a bind pose). */
  | 'fixed-ctx-by-design'
  /** The fold itself. It CONSUMES authored params — that is what it exists to convert. */
  | 'mints-the-cooked-state';

/** Why a consumer cannot care, and must not be made to choose. */
type IndifferentReason =
  /** Reads ids, types and edges. Never reads a param VALUE. */
  | 'reads-no-param-value'
  /** Imports the evaluator's instrumentation surface and never evaluates anything. */
  | 'never-reads-the-graph';

/** Why a consumer needs BOTH, at two different seams inside itself. */
type SplitReason =
  /**
   * Evaluates a state folded on the refold-safe tier, then applies the remaining overlays
   * at its own seams. The two are not in tension: the tier admits exactly the paths whose
   * second fold cannot change the answer, so the seams below still see the base they
   * expect. Everything outside that tier reaches them authored, as before.
   */
  'evaluates-the-safe-tier-then-folds-the-rest';

type Decision =
  | { needs: 'cooked'; why: CookedReason }
  | { needs: 'authored'; why: AuthoredReason }
  | { needs: 'both'; why: SplitReason }
  | { needs: 'indifferent'; why: IndifferentReason };

const cooked = (why: CookedReason): Decision => ({ needs: 'cooked', why });
const authored = (why: AuthoredReason): Decision => ({ needs: 'authored', why });
const both = (why: SplitReason): Decision => ({ needs: 'both', why });
const indifferent = (why: IndifferentReason): Decision => ({ needs: 'indifferent', why });

/**
 * Every non-test module that imports the evaluator, and the params each one needs.
 *
 * A new importer is not forbidden — it is a red that forces whoever adds it to answer here.
 */
const CONSUMERS: Record<string, Decision> = {
  // ── COOKED — the value at t IS the answer these produce ────────────────────────────
  'src/app/modifierGeometry.ts': cooked('renders-geometry-at-t'),
  'src/app/resolveEvaluatedMesh.ts': cooked('renders-geometry-at-t'),
  'src/viewport/DiffOverlay.tsx': cooked('renders-geometry-at-t'),
  'src/app/curveSampleSource.ts': cooked('samples-geometry-at-t'),
  'src/app/geometrySampleSource.ts': cooked('samples-geometry-at-t'),
  'src/app/character/framing.ts': cooked('samples-geometry-at-t'),
  'src/app/renderImageAction.ts': cooked('exports-a-frame'),
  'src/app/renderAnimationAction.ts': cooked('exports-a-frame'),
  'src/render/runRenderJob.ts': cooked('exports-a-frame'),
  'src/render/dryRun.ts': cooked('exports-a-frame'),
  'src/render/runComfyUIWorkflow.ts': cooked('exports-a-frame'),
  'src/render/runVideoStitch.ts': cooked('exports-a-frame'),
  'src/agent/tools/renderSummarizePass.ts': cooked('describes-a-frame'),
  'src/agent/tools/renderSummarizeStylized.ts': cooked('describes-a-frame'),
  // #645 P6 — the Object slot list the inspector draws. COOKED, and it has to be: the
  // slot table is whatever the modifier and material chain produced at t, so the panel
  // reading authored params would report a table the viewport is not drawing. Same
  // frame, same answer (H40). It describes what is on screen rather than producing it,
  // which is what puts it beside the two summarizers above rather than the renderers.
  'src/app/objectSlotAuthoring.ts': cooked('describes-a-frame'),

  // ── BOTH — the one file with two seams and a different answer at each ─────────────
  'src/viewport/SceneFromDAG.tsx': both('evaluates-the-safe-tier-then-folds-the-rest'),

  // ── AUTHORED — handing these folded params would double-apply or go circular ───────
  'src/app/Gizmo.tsx': authored('folds-its-own-overlays'),
  'src/app/boot.ts': authored('folds-its-own-overlays'),
  'src/app/activeCamera.ts': authored('folds-its-own-overlays'),
  'src/app/nodeConstraints.ts': authored('folds-its-own-overlays'),
  'src/app/resolveTransformParam.ts': authored('folds-its-own-overlays'),
  'src/app/resolveWorldTransform.ts': authored('folds-its-own-overlays'),
  'src/app/animate/dispatchApplyTransform.ts': authored('folds-its-own-overlays'),
  'src/app/resolveEvaluatedParam.ts': authored('produces-an-overlay'),
  'src/app/resolveEvaluatedTransform.ts': authored('produces-an-overlay'),
  'src/app/transformChannelSource.ts': authored('produces-an-overlay'),
  'src/app/paramDrivers.ts': authored('produces-an-overlay'),
  'src/app/statefulOps.ts': authored('produces-an-overlay'),
  'src/viewport/EditorViewCamera.tsx': authored('delegates-to-a-folding-resolver'),
  'src/app/studioLightRig.ts': authored('delegates-to-a-folding-resolver'),
  'src/timeline/LightStudioPanel.tsx': authored('edits-authored-values'),
  // #807 — the third member of the same family, and it evaluates for the same
  // reason the other two do: it reads a `GltfSkeleton`'s bone NAMES to decide
  // which bone-name map bridges a dropped clip onto a character. Names are
  // import-time static and the ctx is the same fixed bind pose (frame 0), so the
  // playhead cannot change the answer. It never reads a value that moves.
  'src/app/asset/bindMotionToCharacter.ts': authored('fixed-ctx-by-design'),
  // ns-2 step 5 — a TEST helper, and production to this census by the same rule every
  // fixture under `src/test-utils/` is: it is a non-test source file, so it counts. It
  // evaluates ONE node at the default ctx (frame 0), never the playhead, with whatever
  // params its caller hands it verbatim — so authored, for the same reason `retarget`
  // above is. It exists because the operator bypass moved into the evaluator and a
  // direct `evaluate` call can no longer observe it.
  'src/test-utils/evaluateNodeAlone.ts': authored('fixed-ctx-by-design'),
  'src/app/cookState.ts': authored('mints-the-cooked-state'),

  // ── INDIFFERENT — the escape hatch, and the reason it is not the easy road ─────────
  'src/app/nodeRefCandidates.ts': indifferent('reads-no-param-value'),
  'src/app/resolveMaterialFieldOwner.ts': indifferent('reads-no-param-value'),
  'src/perf/frameProfiler.ts': indifferent('never-reads-the-graph'),
};

/** Files importing `core/dag/evaluator`, comments stripped so prose about it never counts. */
function evaluatorConsumers(): string[] {
  return sourceFiles()
    .filter(([path]) => !/\.test\.tsx?$/.test(path))
    .filter(([, src]) => /from\s+['"][^'"]*core\/dag\/evaluator['"]/.test(stripComments(src)))
    .map(([path]) => path)
    .sort();
}

describe('#582 — who evaluates the graph, and which params they need', () => {
  it('the consumer set is EXACTLY the table — in both directions', () => {
    const found = evaluatorConsumers();
    const declared = Object.keys(CONSUMERS).sort();

    // Stated separately so the failure says WHICH way it drifted. An undeclared consumer
    // is a new road that never answered the question; a declared file that no longer
    // imports the evaluator is a stale row asserting nothing.
    expect(found.filter((f) => !(f in CONSUMERS))).toEqual([]);
    expect(declared.filter((d) => !found.includes(d))).toEqual([]);
    expect(found).toEqual(declared);
  });

  it('the census has the size it was written against', () => {
    // An EXACT count, not a floor: this set is expected to SHRINK as the fold lands and
    // roads collapse, and a floor would go quietly green on the way down.
    //
    // 35 → 36 at ns-2 step 5, and an increase here is worth a sentence rather than a
    // reflex bump: the operator bypass moved into the evaluator, so a node test can no
    // longer observe it by calling `evaluate` directly, and the one shared helper that
    // repoints those tests onto the real road is the new importer. One helper, not one
    // per test file — the alternative was three near-identical copies, which is the
    // defect this phase is about.
    // 36 → 37 at #645 P6, and the increase is worth its sentence for the same reason the
    // last one was: the Object's slot list is read off the RESOLVED mesh, because an
    // object's slot count is its data's and only the evaluated chain knows what that is.
    // A shape-only read would have added no importer here and answered the wrong question.
    // 37 → 38 at #803, and it earns its sentence too: making a retargeted clip
    // actually drive a rendered rig needs the bone NAMES, and on a `GltfSkeleton`
    // those exist only in the evaluated projection — the node has no `params.bones`
    // by design (D-02). Reading names is what forced the evaluate; a params-only
    // read would have had nothing to map the clip's bone INDEXES onto.
    // 39 → 38 at #889 slice 3, and this is the SHRINK the exact count was written to
    // catch. `bakeClipOntoRig` evaluated a `GltfSkeleton` for its bone names so it
    // could bake the whole rig at bind time; binding no longer bakes, so the mutator
    // is gone and so is its evaluate. The road did not move — it collapsed. A floor
    // would have gone quietly green here, which is the whole reason this is not one.
    // 38 → 37 at #901, and it is the SAME shrink for the same reason. The retarget
    // mutator evaluated a `GltfSkeleton` for its bind pose so it could bake the
    // retargeted clip at build time; it now emits a `RetargetClip` node that NAMES
    // the rig with an edge and lets the reader project it. The road collapsed rather
    // than moved — the evaluate went away with the bake, and the row went with it.
    expect(evaluatorConsumers()).toHaveLength(37);
  });

  it('every reason is load-bearing — no member of any union is decorative', () => {
    // A reason nothing uses is a category invented in advance of a case, and it makes the
    // union read as more argued than it is. Each of these must be earned by a real file.
    const used = new Set(Object.values(CONSUMERS).map((d) => d.why));
    const all: string[] = [
      'renders-geometry-at-t',
      'samples-geometry-at-t',
      'exports-a-frame',
      'describes-a-frame',
      'folds-its-own-overlays',
      'produces-an-overlay',
      'delegates-to-a-folding-resolver',
      'edits-authored-values',
      'fixed-ctx-by-design',
      'mints-the-cooked-state',
      'evaluates-the-safe-tier-then-folds-the-rest',
      'reads-no-param-value',
      'never-reads-the-graph',
    ];
    expect(all.filter((r) => !used.has(r as never))).toEqual([]);
  });

  it('the escape hatch stays small, and is named rather than counted', () => {
    // The failure mode this guards is the hatch becoming the default: a consumer that
    // simply did not want to think declares itself indifferent. Three files, named, so
    // widening it is a visible edit rather than a number ticking up.
    const hatch = Object.entries(CONSUMERS)
      .filter(([, d]) => d.needs === 'indifferent')
      .map(([path]) => path)
      .sort();
    expect(hatch).toEqual([
      'src/app/nodeRefCandidates.ts',
      'src/app/resolveMaterialFieldOwner.ts',
      'src/perf/frameProfiler.ts',
    ]);
  });

  it('the SPLIT answer is one file, named — not a category anyone may drift into', () => {
    // 'both' is the weakest row in the table: it says a file is trusted to keep two
    // different states straight inside itself, which is precisely what the two types exist
    // to stop anyone having to be trusted with. It is earned here — the render root folds
    // the refold-safe tier before `evaluate` and its own overlays after — and it must stay
    // earned, so the membership is pinned by NAME. A second file wanting this answer has to
    // come here and argue for it rather than discovering it as the convenient one.
    const split = Object.entries(CONSUMERS)
      .filter(([, d]) => d.needs === 'both')
      .map(([path]) => path);
    expect(split).toEqual(['src/viewport/SceneFromDAG.tsx']);
  });

  it('the fold is in the census as a CONSUMER of authored params, not as an exemption', () => {
    // Written after this gate caught it on its first run: `cookState.ts` reaches the
    // evaluator (for its cache type) and so belongs in the census like anything else. The
    // tempting move was to exclude type-only imports and keep the count at 34 — which
    // would have silently exempted two OTHER members that also import only types
    // (`studioLightRig.ts`, `EditorViewCamera.tsx`) and shrunk the subject to make the
    // number right. The producer takes authored params BY DEFINITION; that is a row, not
    // a hole.
    expect(CONSUMERS['src/app/cookState.ts']).toEqual({
      needs: 'authored',
      why: 'mints-the-cooked-state',
    });
  });
});
