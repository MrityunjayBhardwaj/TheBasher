// splitRoads — which of the conformance matrix's ten roads runs for which kind, and who
// is responsible for the ones the matrix does not run itself (#491).
//
// WHY THIS EXISTS
// `splitKinds.ts` made the KIND axis machine-derived: a new `ObjectData` producer cannot
// register without a descriptor, and six of the ten roads iterate `SPLIT_KIND_NAMES`, so
// those six sweep every kind the day it lands. That is the guarantee #471 bought.
//
// The other four roads were delegated to specs that already existed, and the delegation was
// recorded in a comment at the top of `tests/e2e/split-kind-conformance.spec.ts`:
//
//     Six of them already have per-kind coverage somewhere in this suite — root and nested
//     render (split-light-observation), constraint reach (p422), declared sections
//     (p6-w4-inspector-sections)
//
// Nothing checked that sentence, and measured at 036886a it is not true. Each of the three
// named specs covers exactly ONE kind: split-light-observation builds a light,
// p422-constrained-data-param builds a cube, p6-w4-inspector-sections drives a box. So five
// of six kinds have no constraint-reach coverage and no declared-sections coverage, and the
// suite says nothing — the precise failure `splitKinds.ts` was written to end, surviving in
// the four roads that module did not absorb.
//
// It gets worse per kind rather than better: #415 and #389 each add one, and each would
// inherit four silently empty cells.
//
// WHAT THIS MODULE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
// A cell is COVERED only when a spec is NAMED as covering it. That is a claim about
// responsibility, not about whether some assertion somewhere happens to touch the kind —
// naming is exactly what makes coverage non-accidental, and an unnamed spec that covers a
// cell today can be rewritten tomorrow by someone who has no idea it was load-bearing.
//
// So `gap()` cells do NOT claim "nothing anywhere exercises this". Several carry
// `candidates`: specs that build the right kind and assert something in the right area, and
// that are worth promoting to a named cell once somebody confirms they ask THIS road's
// question rather than a neighbouring one. Recording them as leads rather than as coverage
// is the whole discipline here — writing them in as covered on the strength of a builder
// import would reproduce the unchecked sentence above, one level down.
//
// THE TYPE IS WHAT FORCES A NEW KIND TO BE DECIDED. Each delegated road holds a
// `Record<SplitKindName, RoadCell>`, so adding a kind to `SplitKindName` fails to compile
// until every delegated road has an answer for it. This mirrors `RENDER_PROBES` in the
// browser tier, which is what made #388's missing baked row a loud failure instead of a
// quiet skip. The runtime gate re-checks the same totality, because being right for two
// reasons is cheap here.
//
// REF: src/test-utils/splitKinds.ts (the kind axis); tests/e2e/split-kind-conformance.spec.ts
//      (the delegating comment); src/test-utils/splitRoads.gate.test.ts (the gate);
//      issues #491, #471.

import type { SplitKindName } from './splitKinds';

/** The ten roads the matrix describes. */
export type RoadId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10';

/**
 * How a road gets asked of every kind.
 *
 * 'derived'   — the road's own file iterates `SPLIT_KIND_NAMES`, so a new kind enrols on the
 *               day it registers and no per-kind bookkeeping exists to go stale.
 * 'delegated' — the road is asked by specs written for particular kinds, so coverage is
 *               per-cell and has to be recorded.
 */
export type RoadDerivation = 'derived' | 'delegated';

/** A named spec is responsible for this (road, kind) cell. */
export interface RoadCovered {
  readonly by: string;
}

/**
 * No spec is NAMED for this cell. `why` says what is unasked, `issue` tracks it, and
 * `candidates` lists specs that build the right kind and look relevant — leads for whoever
 * closes the gap, never a coverage claim.
 */
export interface RoadGap {
  readonly gap: true;
  readonly why: string;
  readonly issue: string;
  readonly candidates?: readonly string[];
}

export type RoadCell = RoadCovered | RoadGap;

export function isCovered(cell: RoadCell): cell is RoadCovered {
  return 'by' in cell;
}

export interface RoadSpec {
  readonly id: RoadId;
  readonly title: string;
  /** Where the road runs. For 'derived' roads the gate checks this file iterates the kinds. */
  readonly runsIn: string;
  readonly derivation: RoadDerivation;
  /** Present exactly when `derivation === 'delegated'`. Total over `SplitKindName`. */
  readonly coverage?: Record<SplitKindName, RoadCell>;
}

/** Compact constructor for an unnamed cell, so 20 of them stay readable. */
function gap(why: string, candidates?: readonly string[]): RoadGap {
  return { gap: true, why, issue: '#491', ...(candidates ? { candidates } : {}) };
}

/**
 * Markers that prove a spec actually touches a kind: its data node type, and the e2e builder
 * that mints a split pair of it. The gate requires a NAMED spec to contain one of these, so
 * a cell pointing at a spec that never builds the kind fails rather than reads as coverage.
 *
 * Baked has no builder module on purpose — its geometry is an OPFS content-hash handle, so
 * a pair cannot be hand-authored and the browser row drives the live Apply-Transform
 * producer instead (#388). `buildBakedRow` is that producer's helper.
 */
export const KIND_MARKERS: Record<SplitKindName, readonly string[]> = {
  box: ['BoxData', '_splitCube', 'splitCubeOps'],
  sphere: ['SphereData', '_splitSphere', 'splitSphereOps'],
  curve: ['CurveData', '_splitCurve', 'splitCurveOps'],
  light: ['LightData', '_splitLight', 'splitLightOps'],
  camera: ['CameraData', '_splitCamera', 'splitCameraOps'],
  baked: ['BakedData', 'buildBakedRow'],
};

const RENDER_GAP =
  'no spec is named for this kind on this road — the delegate builds a light, so a ' +
  'broken root/nested mount for this kind would not be reported';

export const SPLIT_ROADS: Record<RoadId, RoadSpec> = {
  // PROMOTED from delegated to derived (#500). The five gaps here were honest, and the reason
  // they existed is worth keeping: R5 and R8 both seed a channel BEFORE their first read,
  // because that is what puts the object on the overlay road at all — `OverlayDispatch` mounts
  // a plain `MeshChild` for anything with no channel and no constraint. So between them the
  // browser tier never observed the BARE arm, which is the arm almost every object in a real
  // project takes. Closing this was not a matter of naming an existing spec: the row had to be
  // written, and it asserts a MEASURED value per kind rather than mere non-nullness, because on
  // the three mesh bands a dropped material spec renders the #808080 fallback — non-null, wrong,
  // and accepted by any existence check.
  //
  // `split-light-observation.spec.ts` still exists and still runs; it is simply no longer the
  // only thing standing behind this road.
  R1: {
    id: 'R1',
    title: 'root render — a split pair at the scene root mounts and draws',
    runsIn: 'tests/e2e/split-kind-conformance.spec.ts',
    derivation: 'derived',
  },
  R2: {
    id: 'R2',
    title: 'nested render — a split pair under a parent draws at the composed transform',
    runsIn: 'tests/e2e/split-light-observation.spec.ts',
    derivation: 'delegated',
    coverage: {
      light: { by: 'tests/e2e/split-light-observation.spec.ts' },
      camera: { by: 'tests/e2e/p231-nested-camera.spec.ts' },
      box: gap(RENDER_GAP, ['tests/e2e/p230-nested-gizmo-world.spec.ts']),
      sphere: gap(RENDER_GAP),
      curve: gap(RENDER_GAP),
      baked: gap(RENDER_GAP),
    },
  },
  R3: {
    id: 'R3',
    title: 'read == render — a read of the Object reports what the renderer composes from',
    runsIn: 'src/test-utils/splitKinds.roads.test.ts',
    derivation: 'derived',
  },
  R4: {
    id: 'R4',
    title: 'the overlay lands where the renderer looks',
    runsIn: 'src/test-utils/splitKinds.roads.test.ts',
    derivation: 'derived',
  },
  R5: {
    id: 'R5',
    title: 'the transient road — a held edit on the data half repaints the object',
    runsIn: 'tests/e2e/split-kind-conformance.spec.ts',
    derivation: 'derived',
  },
  R6: {
    id: 'R6',
    title: 'constraint reach — a constraint on the Object reaches a data param',
    runsIn: 'tests/e2e/p422-constrained-data-param.spec.ts',
    derivation: 'delegated',
    coverage: {
      box: { by: 'tests/e2e/p422-constrained-data-param.spec.ts' },
      curve: gap(
        'the delegate builds a cube; the curve specs below drive constraints but have ' +
          'not been confirmed to ask THIS road (does a constraint reach a DATA param)',
        ['tests/e2e/p341-constraint-ref-picker.spec.ts', 'tests/e2e/p339-follow-path.spec.ts'],
      ),
      light: gap('the delegate builds a cube', ['tests/e2e/p265-aimable-light-track-to.spec.ts']),
      sphere: gap('the delegate builds a cube'),
      // No candidate: the only two specs that build a split camera (p231-active-camera,
      // p231-nested-camera) drive neither constraint. p204-camera-track-to sounds right and
      // is not — it builds a CUBE and points a camera at it, so the constrained half is the
      // cube's. This cell has nowhere to start from, which is worth recording.
      camera: gap('the delegate builds a cube, and no spec constrains a split camera at all'),
      baked: gap('the delegate builds a cube'),
    },
  },
  R7: {
    id: 'R7',
    title: 'declared sections — the inspector shows the sections the pair declares',
    runsIn: 'tests/e2e/p6-w4-inspector-sections.spec.ts',
    derivation: 'delegated',
    coverage: {
      box: { by: 'tests/e2e/p6-w4-inspector-sections.spec.ts' },
      // The registry gate already pins `customSections` as a SUBSET of what each node
      // declares, so a kind naming a section it does not have fails today. What no spec
      // asks for these five is the other direction: that the declared sections actually
      // RENDER as headers in the inspector for this kind.
      sphere: gap('the delegate drives a box; nothing renders this kind’s sections', [
        'tests/e2e/inspector-enum-param.spec.ts',
      ]),
      curve: gap('the delegate drives a box, and the curve declares a custom section'),
      light: gap('the delegate drives a box'),
      camera: gap('the delegate drives a box, and the camera declares a custom section'),
      baked: gap('the delegate drives a box'),
    },
  },
  R8: {
    id: 'R8',
    title: 'the management road — what a surface OFFERS equals what it ACCEPTS',
    runsIn: 'tests/e2e/split-kind-conformance.spec.ts',
    derivation: 'derived',
  },
  R9: {
    id: 'R9',
    title: 'the migration ladder — every kind owns its own step',
    runsIn: 'src/test-utils/splitKinds.roads.test.ts',
    derivation: 'derived',
  },
  R10: {
    id: 'R10',
    title: 'a write aimed at the wrong half is surfaced and changes nothing',
    runsIn: 'src/test-utils/splitKinds.roads.test.ts',
    derivation: 'derived',
  },
};

export const ROAD_IDS = Object.keys(SPLIT_ROADS) as RoadId[];
