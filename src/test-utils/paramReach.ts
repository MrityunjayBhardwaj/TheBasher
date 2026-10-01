// paramReach — for every param on every split data kind, who reads it (#492).
//
// WHY THIS EXISTS
// Six open issues are one shape: #489, #478, #474, #484, #356, #372. Each is a param or a
// section the user can edit that nothing on the other end reads. The edit lands, the project
// saves, and nothing renders differently. It is the data-side twin of the offer-equals-accept
// rule already enforced on management surfaces — but there was no shared predicate, so each
// instance had to be found by somebody noticing.
//
// The conformance matrix cannot find them, and the reason is structural rather than an
// oversight: it is ONE PARAM DEEP. Each kind's descriptor names a single
// `observableDataParam`, chosen precisely because it survives to the evaluated value
// unchanged — that property is what makes it a usable probe. R3, R4, R5, R8 and R10 all bind
// that one param and no other. So for a camera with twelve schema params, the matrix proves
// one of them makes it end to end and says nothing about the other eleven. `zoom` sits in
// that blind spot, which is why #478 was found by reading rather than by a red test.
//
// WHAT IS DECLARED HERE, AND WHAT IS MEASURED
// Exactly one thing is declared: WHO READS THE PARAM. Everything about where the param
// travels is measured by the gate at run time, because a declaration of that would be a
// second copy of something already observable, and the copy is what goes stale. The gate
// evaluates a real pair of each kind and reports, per param, which seam it reaches:
//
//   'render'   — present in the value `renderedValueForBand` hands the renderer
//   'value'    — present in the data node's evaluated value but dropped before the renderer
//   'consumed' — absent under its own name; folded into some other key at evaluate time
//
// That distinction is not cosmetic. `zoom` is 'value': `CameraData.evaluate` emits it and
// `recomposeCameraObject` drops it, so it is authored, saved, and never seen. Whereas
// `size` is 'consumed' — it becomes an opaque `GeometryRef` and is very much read. A gate
// that only asked "does the name survive?" would call both broken.
//
// HOW STRONG THE READER CHECK ACTUALLY IS — stated plainly, because overselling it would
// reproduce the exact disease this module treats. The gate verifies that a named reader file
// EXISTS and MENTIONS the param IN CODE — a comment, a file name or the text of a message does
// not count (#1407: eleven rows were passing on prose alone, two of them naming code that had
// been deleted). That is a necessary condition, not a sufficient one, and
// there is a live counter-example in this very table: `zoom` appears in
// `src/nodes/cameraRecompose.ts` and is nonetheless dropped by it. So a wrong `readBy` can
// pass. What the gate does buy is totality — every param must have an answer, a new param
// cannot appear without one, and a `none` answer must carry an issue number. The remaining
// judgement is human, and `unverified` exists so that unfinished judgement is COUNTED rather
// than guessed at.
//
// WHAT IT DOES NOT COVER. This table is over DATA params only. #489 — a baked mesh's `scale`
// row being editable and ignored — lives on the Object's transform, not on `BakedData`, so
// it is the same shape at a different address and this gate would not have caught it. The
// Object-side twin is worth building; it is not this.
//
// REF: src/test-utils/splitKinds.ts (the kind axis); src/test-utils/paramReach.gate.test.ts
//      (the gate); issues #492, #478, #489.

import type { SplitKindName } from './splitKinds';

/** A named file reads this param. Verified to exist and to mention it — see the header. */
export interface ReadBy {
  readonly by: string;
  /**
   * The reader takes the node's params as a WHOLE and never spells this one's name — a
   * field-by-field diff, say. The gate cannot ask such a file to mention the param, so it asks
   * for this expression instead: the code that takes the params. Without it the only way to
   * name such a reader was to point at a file that happened to carry the word (#1407).
   */
  readonly whole?: string;
}

/** Nothing reads it. The defect this module exists to surface; must name an issue. */
export interface NoReader {
  readonly none: true;
  readonly why: string;
  readonly issue: string;
}

/** Nobody has traced this param's reader yet. Counted, so the number can only go down. */
export interface Unverified {
  readonly unverified: true;
  readonly issue: string;
  /** What is known so far, so the next person does not start from nothing. */
  readonly note: string;
}

export type ParamReader = ReadBy | NoReader | Unverified;

export function hasReader(r: ParamReader): r is ReadBy {
  return 'by' in r;
}
export function isUnverified(r: ParamReader): r is Unverified {
  return 'unverified' in r;
}

const SCENE = 'src/viewport/SceneFromDAG.tsx';
const LIGHT_RECOMPOSE = 'src/nodes/lightRecompose.ts';
const BAKED_RECOMPOSE = 'src/nodes/bakedRecompose.ts';
const ACTIVE_CAMERA = 'src/app/activeCamera.ts';
const CURVE_LINE = 'src/viewport/CurveLine.tsx';
/** #1053 — the load converter, which reads a saved clone import to turn it native. */
const CLONE_CONVERTER = 'src/app/asset/convertCloneCharacters.ts';
/**
 * #1407 — the modules a caller named above DELEGATES to. The table used to name the caller, which
 * carries the param only in prose; the read itself is one hop further in.
 */
const GEOMETRY_BUILDER = 'src/app/geometryRegistry.ts';
const CURVE_SAMPLER = 'src/nodes/curveMath.ts';
const CAMERA_NODE = 'src/app/cameraNode.ts';
const CAMERA_DOF = 'src/app/cameraDof.ts';
const MATERIAL_ASSIGNMENT = 'src/app/materialAssignment.ts';

/**
 * A param folded into the geometry handle at evaluate time. Its reader is the geometry
 * builder, not a renderer — the renderer only ever sees the resulting `GeometryRef`. Recorded
 * as unverified rather than as a reader because "the evaluate function that consumes it" is
 * not a rendering claim, and pretending otherwise would put a comfortable-looking entry where
 * a real question is.
 */
const FOLDED_INTO_GEOMETRY = (kindNote: string): Unverified => ({
  unverified: true,
  issue: '#492',
  note: kindNote,
});

/**
 * Every param of every split kind, and who reads it.
 *
 * Keys are checked against each kind's zod schema in BOTH directions, so a param added to a
 * schema fails until it is classified here, and an entry left behind by a removed param fails
 * too.
 */
export const PARAM_READERS: Record<SplitKindName, Record<string, ParamReader>> = {
  box: {
    size: { by: SCENE },
    material: { by: SCENE },
  },
  sphere: {
    // Folded into the GeometryRef like the segment counts, but TRACED: the registry's sphere
    // build reads it off the descriptor by name.
    radius: { by: GEOMETRY_BUILDER },
    widthSegments: FOLDED_INTO_GEOMETRY(
      'no renderer mentions it — measured absent from every candidate. It is folded into ' +
        'the GeometryRef by SphereData.evaluate, so the real question is whether the ' +
        'geometry builder honours it, which nothing currently asserts',
    ),
    heightSegments: FOLDED_INTO_GEOMETRY(
      'same as widthSegments — folded into the GeometryRef, no renderer reads it by name',
    ),
    material: { by: SCENE },
  },
  curve: {
    points: { by: CURVE_LINE },
    // Consumed at evaluate time into `samples`; the sampler is what reads both by name. The
    // scene draws the samples and never sees either.
    closed: { by: CURVE_SAMPLER },
    resolution: { by: CURVE_SAMPLER },
  },
  light: {
    lightKind: {
      unverified: true,
      issue: '#492',
      note:
        'measured absent from every candidate renderer. It is the discriminator ' +
        'LightData.evaluate switches on to pick the emitted light shape, so its reader is ' +
        'the evaluate function rather than a renderer — worth confirming that every arm of ' +
        'that switch is reachable',
    },
    intensity: { by: LIGHT_RECOMPOSE },
    color: { by: LIGHT_RECOMPOSE },
    distance: { by: LIGHT_RECOMPOSE },
    decay: { by: LIGHT_RECOMPOSE },
    angle: { by: LIGHT_RECOMPOSE },
    penumbra: { by: LIGHT_RECOMPOSE },
    width: { by: LIGHT_RECOMPOSE },
    height: { by: LIGHT_RECOMPOSE },
    target: { by: LIGHT_RECOMPOSE },
    lookAt: { by: LIGHT_RECOMPOSE },
    tex: { by: LIGHT_RECOMPOSE },
  },
  camera: {
    // The projection rule lives in `cameraNode.ts`; the pose resolver asks it.
    projection: { by: CAMERA_NODE },
    fov: { by: ACTIVE_CAMERA },
    // The one this table was built to make visible. `CameraData.evaluate` emits it and
    // `recomposeCameraObject` drops it, so it is authored in the inspector, written to the
    // project file, and read by nothing. The gate measures it as 'value' — reaching the
    // evaluated value and stopping there — which is the signature of the whole class.
    zoom: {
      none: true,
      why: 'authored and saved, dropped at recompose, read by no renderer',
      issue: '#478',
    },
    near: { by: ACTIVE_CAMERA },
    far: { by: ACTIVE_CAMERA },
    // The DoF and sensor group reaches the data value and is dropped at recompose exactly as
    // `zoom` is — but unlike `zoom` it IS read, off the RAW params by the pose resolver. That
    // road is pinned as an equality by activeCamera.test.ts, so these are not defects; they
    // are a second road. Distinguishing them from `zoom` is the whole point of naming readers
    // rather than trusting the seam measurement alone. The pose resolver hands the raw params to
    // `resolveCameraDof`, and that is where the four lens fields are read by name.
    sensorSize: { by: CAMERA_DOF },
    dofEnabled: { by: CAMERA_DOF },
    focusDistance: { by: CAMERA_DOF },
    fStop: { by: CAMERA_DOF },
    focusOnTarget: { by: ACTIVE_CAMERA },
    lookAt: { by: ACTIVE_CAMERA },
    roll: { by: ACTIVE_CAMERA },
  },
  baked: {
    geometry: { by: BAKED_RECOMPOSE },
    material: { by: BAKED_RECOMPOSE },
  },
  gltf: {
    // #1053 — the clone renderer is gone (a kept clone import is not drawn), so what reads a saved
    // clone child's params now is the load converter, which reads them to turn the child native:
    // `assetRef` and `childName` to find it in the file, `material` and `materialSlots` to carry
    // what the director set. Nothing draws from them any more.
    assetRef: { by: CLONE_CONVERTER },
    childName: { by: CLONE_CONVERTER },
    material: { by: CLONE_CONVERTER },
    materialSlots: { by: CLONE_CONVERTER },
    // #1023 / #1040 — the captured face and point counts. Their readers were the `gltf` arms of
    // the model's face and point questions, which went with the `gltf` geometry kind (#1053).
    // What reads them now is the same converter, and not by name: it rebuilds the saved import
    // and compares EVERY param field against the rebuild to find what the director edited. So
    // the captures must keep writing exactly what old saves hold — a count that differed would
    // read as an edit (#1407).
    faceCount: { by: CLONE_CONVERTER, whole: 'was.params' },
    pointCount: { by: CLONE_CONVERTER, whole: 'was.params' },
  },
  mesh: {
    // #1049 — the stored mesh itself, read BY NAME: `meshGeometryRef` decodes it and keys the
    // geometry on it, and everything the model answers about the mesh is read off that decode
    // (the parity gate pins all six answers). No renderer reads the packed strings — it draws the
    // buffer the registry builds from them, which is the point.
    mesh: { by: 'src/app/meshGeometryData.ts' },
    // The material, drawn by the same object road every MeshData producer's material takes.
    material: { by: SCENE },
    // #1052 — the slot table, drawn slot by slot against the mesh's `material_index` groups by
    // the same object road, through `objectSlotsOf` — which is where the table is read by name.
    materialSlots: { by: MATERIAL_ASSIGNMENT },
  },
};
