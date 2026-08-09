// splitKinds — the one description of every object↔data kind, and the single source
// the conformance matrix draws its rows from (#471, Deliverable B-I).
//
// WHY THIS EXISTS
// Each kind we split so far — BoxData, SphereData, CurveData, LightData — was verified
// by a set of specs written by hand for that kind. Coverage is therefore whatever
// somebody remembered to write, and a new kind can register and ship with a road
// silently broken while the whole suite stays green. That has already happened twice:
// a split curve rendered an EMPTY Object Data tab with typecheck and ~2940 unit tests
// green, and 16 specs quietly failed for weeks because a fixture still built a node
// kind that had retired. Neither had anything watching the SET of kinds against the
// SET of roads. This module is that set.
//
// THE RULE THAT SHAPES IT: no field here may make a road SKIP.
// A kind's band may choose HOW a road asks its question; it may never choose WHETHER
// the road runs. A per-kind opt-out is exactly how a matrix comes to report coverage
// it does not have — the same disease as an empty workflow list reading as "covered".
// So there is no `skipRoads`, and every field below is either a fact about the kind or
// a way of PHRASING a road for it, never a way out of one.
//
// IT IS PURE, DELIBERATELY.
// No `applyOp`, no `DagState`, no registry — op arrays only. End-to-end specs import
// this module on the Node side (five specs already import from `src/`), and pulling the
// DAG module graph into every Playwright spec to get a fixture would be a bad trade.
// Everything it imports is either a type or a pure value transform. Keep it that way:
// the moment this file needs the graph, the e2e tier needs its own second descriptor,
// and the duplication this module exists to remove comes straight back.
//
// REF: src/app/objectDataBand.ts (the band rule); src/nodes/lightRecompose.ts;
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issues #471, #387.

import type { SplitBand } from '../app/objectDataBand';
import { recomposeCameraObject } from '../nodes/cameraRecompose';
import { recomposeLightObject } from '../nodes/lightRecompose';

/** The kinds that have actually been split. One name per `ObjectData` producer. */
export type SplitKindName = 'box' | 'sphere' | 'curve' | 'light' | 'camera' | 'baked';

/** As much of a node definition as the data-lane predicates below read. Declared
 *  structurally so this module still never imports the registry (see the header).
 *
 *  #609 — the input side widened to `string | readonly string[]`, because a socket now
 *  declares the SET of types it accepts. The membership test is re-spelled in
 *  `isDataOperatorDef` rather than imported; see the note there for why that import is
 *  not available to this module. */
export interface DataLaneDef {
  readonly inputs?: Record<string, { type?: string | readonly string[] } | undefined>;
  readonly outputs?: Record<string, { type?: string } | undefined>;
  /** #396 — the socket carrying the chain. Structural, like the rest of this shape, so
   *  the predicate below can read a real `NodeDefinition` without importing the registry. */
  readonly chainInput?: string;
}

/**
 * Is this node type an OPERATOR on the data lane — `ObjectData` in, `ObjectData` out?
 * The geometry modifiers (Array, Mirror) are the first, from #415.
 *
 * ⚠️ THIS PREDICATE EXISTS BECAUSE "EMITS ObjectData" STOPPED MEANING "IS A DATA KIND".
 * Until #415 the two were the same set, so two separate gates (this module's registry
 * gate and the outliner-icon sweep) each derived "data kind" as `outputs.out.type ===
 * 'ObjectData'` — independently, in two files, with no shared definition. Moving the
 * modifier stack onto the data lane added a producer that is a FUNCTION from data to
 * data rather than a kind OF data, and both gates fired at once. They were right to:
 * the assumption really had changed. What they could not do is agree, which is why the
 * discriminator now lives here once instead of being re-spelled per gate.
 *
 * The structural shape is the honest one: an operator DECLARES the same socket type on
 * both sides, because that is what makes it stackable. A leaf data node has no inputs
 * at all. Nothing here is matched against a type name.
 */
export function isDataOperatorDef(def: DataLaneDef | undefined): boolean {
  // #396 — the same "declares the same socket type on both sides" test, asked of the
  // input the operator NOMINATES as its chain rather than of one called `target`. This
  // was the fourth independent spelling of that question; it now agrees with the other
  // three by construction instead of by everyone happening to pick the same name.
  const spine = def?.chainInput;
  if (!spine) return false;
  // #609 — MEMBERSHIP, because a spine may now accept a SET of types, and a bare
  // `=== 'ObjectData'` reads FALSE for such a socket while still compiling.
  //
  // ⚠️ THIS IS THE ONE PLACE THAT RE-SPELLS `inputAccepts` INSTEAD OF CALLING IT, and it
  // is forced rather than chosen: the DAG's copy lives in `core/dag/types`, and the gate
  // in this module's own spec forbids a VALUE import of `core/dag` here — an e2e spec
  // importing this descriptor would otherwise drag the whole module graph into
  // Playwright. Type-only imports are erased and stay allowed; a function is not. Kept
  // to two lines so the duplication is visible rather than buried.
  //
  // The two copies are held together by the AGREEMENT gate in `splitKinds.registry.test.ts`
  // (#615), which runs both answers over synthetic set-valued defs — a sweep over the
  // registry alone cannot catch the drift, because the only set-valued socket that exists
  // is not on the data lane and this predicate never sees it.
  const spineType = def?.inputs?.[spine]?.type;
  const spineAcceptsData = Array.isArray(spineType)
    ? spineType.includes('ObjectData')
    : spineType === 'ObjectData';
  return spineAcceptsData && def?.outputs?.out?.type === 'ObjectData';
}

/**
 * Is this node type a data KIND — a producer of `ObjectData` that is not merely an
 * operator over it? This is the set every conformance road and every outliner icon has
 * to answer for. See {@link isDataOperatorDef} for why the two questions parted ways.
 */
export function isDataKindDef(def: DataLaneDef | undefined): boolean {
  return def?.outputs?.out?.type === 'ObjectData' && !isDataOperatorDef(def);
}

/** The op shape the builders emit. Structurally assignable to the DAG's `Op`, but
 *  declared here so this module never imports the graph (see the header). */
export type SplitOp =
  | {
      type: 'addNode';
      nodeId: string;
      nodeType: string;
      params: Record<string, unknown>;
    }
  | {
      type: 'connect';
      from: { node: string; socket: string };
      to: { node: string; socket: string };
    };

export interface SplitKindSpec {
  /** The `ObjectData`-producing node type. The registry gate matches on this. */
  readonly dataType: string;
  /** Which render band the pair's value is recombined in — see objectDataBand.ts. */
  readonly band: SplitBand;
  /** The fused node type(s) this kind replaced. One per kind except the light, which
   *  collapsed four fused nodes into one data node with a `lightKind` discriminator. */
  readonly fusedTypes: readonly string[];
  /** The project format version whose migration performs THIS kind's split. Each kind
   *  owns its own step: folding a later kind into an earlier version's migration would
   *  silently skip every project already saved past it. */
  readonly migratesFromVersion: number;
  /** Params required to mint a VALID data node — only the schema-required ones with no
   *  zod default. Empty for kinds whose every param defaults. (BoxData's `size` is a
   *  required tuple, which is why `paramSchema.safeParse({})` FAILS for a box: a fixture
   *  that assumes otherwise measures its own fallback rather than the node.) */
  readonly baseDataParams: Record<string, unknown>;
  /**
   * A data param that survives to the evaluated value UNDER THE SAME PATH, so the read
   * side and the render side can be compared without either one re-deriving the other.
   *
   * That constraint is sharper than it looks, and it is why the four choices differ:
   * `size` becomes an opaque GeometryRef, `resolution` disappears into `samples`, and
   * `points` is transformed from `{id,co}[]` to `co[]`. Asserting on any of those would
   * mean re-implementing the transform in the test, which is the drift the whole
   * read-equals-render road exists to catch.
   */
  readonly observableDataParam: string;
  /**
   * `[base, overlaid]`. `base` is written onto the data node at rest; `overlaid` is what
   * a channel or transient pushes on top.
   *
   * Both must differ from each other AND `base` must differ from the param's schema
   * default, or a broken road returns the fallback and the assertion passes for free.
   */
  readonly distinctValues: readonly [unknown, unknown];
  /**
   * The channel value type to author `observableDataParam` with.
   *
   * Only the four registered channel types exist, so a param whose type has no channel
   * (the curve's boolean `closed`) borrows one: the road that uses this asks where a
   * channel's TARGET is routed, and routing keys off the param's root name, never its
   * value type. Anything that actually blends by type is asked elsewhere.
   */
  readonly channelValueType: 'number' | 'vec3' | 'quat' | 'color';
  /**
   * Pull the observable off the value the RENDERER consumes (already put in the band's
   * shape by `renderedValueForBand`). The light's extractor has no `.data` precisely
   * because its band flattens — if the flat path ever got the mesh rebase, this is the
   * assertion that notices.
   */
  readonly readRendered: (rendered: unknown) => unknown;
  /** Sections whose body is a custom control rather than generic param rows. Consumed by
   *  the sections road in the e2e tier; the registry gate keeps it a subset of what the
   *  node actually declares, so it cannot quietly go stale. */
  readonly customSections: readonly string[];
  /**
   * Every section the DATA half declares, in declared order — the full list, not the
   * custom-bodied subset above. This is what the sections road asserts actually RENDERS as
   * a header when the OBJECT is selected, which is the only way the linked-data reach gets
   * observed per kind.
   *
   * Distinct from `customSections`, and the light is why: `LightData` declares `['light']`
   * while its `customSections` is empty, because that section's body is generic param rows.
   * A subset field cannot express "these and no others", so it cannot drive an assertion
   * that a kind renders the sections it declares and nothing extra.
   *
   * The registry gate pins this as an EQUALITY against the live `inspectorSections`, both
   * ways, so it is a mirror of the declaration rather than a second copy of it.
   */
  readonly dataSections: readonly string[];
  /** This kind's primary workflows that route through a param the split MOVED. Asserted
   *  non-empty: an empty list would read as coverage while checking nothing. */
  readonly primaryWorkflows: readonly string[];
  /**
   * A road's answer may be NO — provided it is ASSERTED. `{reaches:false}` is NOT an
   * opt-out: the road still builds the fixture, still applies the stimulus, and then
   * asserts the outcome did NOT move, keyed to the issue, as an EQUALITY. So the cell
   * reads "asked, answered no, here is why" and goes RED the day the gap closes. That
   * is the whole difference from a skip, which is a claim about the suite's
   * willingness to look rather than about the system. There is still no
   * `skipRoads`/`supports`/`applicable` field, and there never will be.
   *
   * ONLY the management road lives here. The transient road's identical union already
   * ships as `HeldExpectation` in the browser tier and is reached per kind through
   * `RENDER_PROBES` — recording it a second time would give one answer two homes, and
   * one of them would eventually be the stale one.
   */
  readonly roadAnswers?: {
    readonly management?: RoadAnswer;
  };
}

/** See `SplitKindSpec.roadAnswers`. A NO must carry its reason and its issue, so the
 *  cell is a claim about the product that someone can go and close. */
export type RoadAnswer =
  | { readonly reaches: true }
  | { readonly reaches: false; readonly why: string; readonly issue: string };

/** The data-node id every split builder derives for a given Object id. */
export function dataIdFor(objectId: string): string {
  return `${objectId}_data`;
}

/** `('material.base.color', v)` → `{ material: { base: { color: v } } }`. */
export function nestParam(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let out: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i]]: out };
  return out as Record<string, unknown>;
}

/**
 * The data-node params one conformance ROW is built from: the kind's minimum valid params
 * with its BASE observable value written on top.
 *
 * Shared rather than written per tier on purpose. Both tiers assert against the same
 * `distinctValues`, so if they built their fixtures separately the unit row and the e2e row
 * could come to rest at different values while both looked correct in isolation — the
 * instrument drifting from what it measures, one tier at a time. One builder, one resting
 * state, and a row that disagrees across tiers is then a real disagreement.
 */
export function rowDataParams(kind: SplitKindName): Record<string, unknown> {
  const spec = SPLIT_KINDS[kind];
  return deepMerge(
    spec.baseDataParams,
    nestParam(spec.observableDataParam, spec.distinctValues[0]),
  );
}

/**
 * Overlay `over` onto `base`, recursing into plain objects so a nested leaf replaces
 * only itself.
 *
 * This used to be a spread, which is a SHALLOW overlay, and it was correct for as long
 * as no kind's observable shared a root key with a required mint param — box/sphere
 * observe `material.base.color` while minting only `size`, and their material is
 * schema-defaulted, so the two never met. The baked mesh is the first kind where they
 * do: its `material` is a fully required `BakedMaterialSpec` AND the root of its
 * observable, so a shallow spread replaced the whole spec with `{color}` and the node
 * failed to mint. The failure was loud (zod rejected the addNode), but the shape it
 * belongs to is not: a shallow overlay silently DROPS sibling keys, and it would have
 * done so quietly for any param bag that happened to be optional.
 *
 * Arrays are replaced wholesale, never merged — a `points` list or a `size` tuple is a
 * value, not a namespace, and element-wise merging one would be nonsense.
 */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The op triple that creates one split pair: the data node, the Object, and the `data`
 * edge between them, in dependency order.
 *
 * This is the ONE place the shape lives — the node types, the socket names, the edge
 * DIRECTION and the ordering. Callers keep their own param defaulting.
 *
 * Measured, because the obvious reason turned out to be wrong: `addNode` stores PARSED
 * params, so omitting a param whose schema has a default is byte-identical to writing
 * that default. The pose params the two builder families disagree about are ALL in that
 * category — unifying them changes nothing at all. What genuinely diverges is a default a
 * builder chooses DIFFERENTLY from the schema, and today that is exactly one case: the
 * e2e curve builder substitutes a lopsided arc-length path at resolution 32 where
 * CurveData's schema defaults to a gentle S-curve at 16.
 *
 * So the defaults stay with their callers not because ~75 consumers depend on all of
 * them, but because ONE of them is load-bearing and separating it from the rest is its
 * own change with its own blast radius. Sharing the op list needs none of that.
 */
export function splitOps(
  kind: SplitKindName,
  ids: { objectId: string; dataId?: string },
  params?: { data?: Record<string, unknown>; object?: Record<string, unknown> },
): SplitOp[] {
  const objectId = ids.objectId;
  const dataId = ids.dataId ?? dataIdFor(objectId);
  return [
    {
      type: 'addNode',
      nodeId: dataId,
      nodeType: SPLIT_KINDS[kind].dataType,
      params: params?.data ?? {},
    },
    { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: params?.object ?? {} },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

/**
 * Put an evaluated Object value into the shape the RENDERER for its band consumes.
 *
 * 'children' renders straight off the Object (`ObjectR` reads `value.data.*`); 'lights'
 * is flattened by `recomposeLightObject` into the `LightValue` the light band still
 * consumes. Closed by the same `never` as `channelPathForBand`, and for the same
 * reason: a new band must decide here rather than inherit whichever arm it sits next to.
 */
export function renderedValueForBand(band: SplitBand, objectValue: unknown): unknown {
  switch (band) {
    case 'children':
      return objectValue;
    case 'lights':
      return recomposeLightObject(objectValue);
    case 'camera':
      // Flattened by `recomposeCameraObject` into the `CameraValue` the DAG's camera
      // consumers read. ⚠️ That value is NOT what frames the shot — see
      // `renderReachForBand`, which is what the roads dispatch on so the camera's
      // channel road is asked about the POSE resolver rather than about this.
      return recomposeCameraObject(objectValue);
    default: {
      const exhaustive: never = band;
      void exhaustive;
      return objectValue;
    }
  }
}

/** Narrow an unknown to an indexable bag without spraying casts through the specs. */
function at(value: unknown, ...path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export const SPLIT_KINDS: Record<SplitKindName, SplitKindSpec> = {
  box: {
    dataType: 'BoxData',
    band: 'children',
    fusedTypes: ['BoxMesh'],
    migratesFromVersion: 2,
    baseDataParams: { size: [1, 1, 1] },
    // `size` becomes a GeometryRef handle; the material leaf survives verbatim.
    observableDataParam: 'material.base.color',
    // BoxData's default is the standard '#cccccc' (#394 D7) and the missing-material
    // fallback is '#808080' — neither of these collides with either trap value.
    distinctValues: ['#c81e5a', '#1e9ac8'],
    channelValueType: 'color',
    readRendered: (r) => at(r, 'data', 'material', 'base', 'color'),
    customSections: [],
    dataSections: ['mesh', 'material'],
    primaryWorkflows: ['resize the box', 'recolour the box', 'stack a modifier on the Object'],
  },
  sphere: {
    dataType: 'SphereData',
    band: 'children',
    fusedTypes: ['SphereMesh'],
    migratesFromVersion: 3,
    baseDataParams: {},
    observableDataParam: 'material.base.color',
    // SphereData's default is the standard '#cccccc' — same as every other kind (#394 D7).
    distinctValues: ['#c81e5a', '#1e9ac8'],
    channelValueType: 'color',
    readRendered: (r) => at(r, 'data', 'material', 'base', 'color'),
    customSections: [],
    dataSections: ['mesh', 'material'],
    primaryWorkflows: [
      'change the radius',
      'recolour the sphere',
      'stack a modifier on the Object',
    ],
  },
  curve: {
    dataType: 'CurveData',
    band: 'children',
    fusedTypes: ['Curve'],
    migratesFromVersion: 4,
    baseDataParams: {},
    // The curve's only param that reaches the value unchanged: `points` is rewritten
    // from `{id,co}[]` to `co[]` and `resolution` is consumed into `samples`.
    observableDataParam: 'closed',
    // Base is `true` BECAUSE the schema default is `false` — a broken read returns the
    // default and must not accidentally agree with what we assert.
    distinctValues: [true, false],
    // `closed` is a boolean and no boolean channel type exists — see the field's doc.
    channelValueType: 'number',
    readRendered: (r) => at(r, 'data', 'closed'),
    customSections: ['curve'],
    dataSections: ['curve'],
    primaryWorkflows: ['edit control points', 'follow-path a camera along the curve'],
  },
  light: {
    dataType: 'LightData',
    band: 'lights',
    // Four fused light NODES collapsed into one data node with a `lightKind` enum,
    // Blender-style. AmbientLight is absent: ambient is a World datablock and never
    // splits — the first PARTIAL retirement.
    fusedTypes: ['DirectionalLight', 'PointLight', 'SpotLight', 'AreaLight'],
    migratesFromVersion: 5,
    baseDataParams: {},
    observableDataParam: 'intensity',
    // LightData's default intensity is 1.
    distinctValues: [3.5, 7.25],
    channelValueType: 'number',
    // NO `.data` — the recomposed LightValue is FLAT. This asymmetry against the three
    // mesh-band extractors above is the band difference made visible.
    readRendered: (r) => at(r, 'intensity'),
    customSections: [],
    dataSections: ['light'],
    primaryWorkflows: ['dim or brighten the light', 'arrange the three-point studio rig'],
  },
  camera: {
    dataType: 'CameraData',
    // A THIRD band, and it is not a variation on the two above — see the note under
    // `readRendered`. Adding it to `SplitBand` is what makes `channelPathForBand` and
    // `renderedValueForBand` refuse to compile until the camera's shape is decided.
    band: 'camera',
    // Two fused camera NODES collapse into one data node, the way four light nodes did.
    // Perspective and orthographic are one datablock with a projection discriminator in
    // every reference model, and they already share every param but `fov`/`zoom`.
    fusedTypes: ['PerspectiveCamera', 'OrthographicCamera'],
    migratesFromVersion: 6,
    // `fov` is the ONE camera param with no zod default (`z.number().min(1).max(170)`),
    // so it is the only one a valid CameraData must be minted with.
    //
    // ⚠️ 50, deliberately NOT the base value below, and camera is the first kind where
    // that distinction is even expressible: every earlier kind's observable had a zod
    // default, so "the value a freshly minted node holds" and "the value the fixture
    // writes" were different by construction. Here the observable IS the required mint
    // param, so making them equal would collapse the registry gate's base-vs-default
    // check into `28 !== 28` — a fixture measuring its own input. Keeping them apart
    // also makes the guard-the-guard road load-bearing for this kind: it now proves the
    // fixture's 28 was actually written, rather than that a mint value came back.
    // 50 is a plain valid fov and is none of 28 / 85 / 45.
    baseDataParams: { fov: 50 },
    // Measured, not assumed (#387 census): of the eleven params the fused camera holds,
    // only `fov`/`near`/`far` reach the render road under their own name. The five DoF
    // and sensor params never enter the evaluated value at all, and ortho `zoom` enters
    // it and is read by nothing (#478). `fov` is the only lens param that is both
    // primary and reachable.
    observableDataParam: 'fov',
    // Neither value may be 45: that is what `cameraPoseFromNode` falls back to when the
    // read fails (`DEFAULT_CAMERA_POSE.fov`) and what `addPrimitives` seeds, so a broken
    // road returns 45 and must not agree with either assertion.
    distinctValues: [28, 85],
    channelValueType: 'number',
    // NO `.data`, and for a DIFFERENT reason than the light's flatness. The light band
    // flattens the pair into a `LightValue` the renderer reads. The camera renderer does
    // not read the evaluated value at all: `CameraValue` reaches it only as an ingredient
    // in `buildPassSourceHash` (a cache key), while every actual render road consumes
    // `CameraPose`, which `cameraPoseFromNode` builds from RAW params and overlays with
    // its own private channel scan keyed on the node id. So this extractor is a claim
    // about a struct the band has to produce, not about the node's output.
    readRendered: (r) => at(r, 'fov'),
    // `camera` renders `CameraLensControls`, not generic param rows.
    customSections: ['camera'],
    dataSections: ['camera'],
    // ⚠️ The third entry says "static" on purpose. A focus PULL is by definition
    // animated, and `focusDistance`/`fStop`/`sensorSize` reach neither `CameraValue`
    // nor `CameraPose` — keying one animates nothing (#193, [[V121]]). Claiming the
    // pull as a primary workflow would make this row assert a capability the product
    // does not have, which is worse than not listing it: the row is the thing other
    // rows are checked against. The limit is PINNED as an equality by
    // `activeCamera.test.ts` ("the DoF road reads RAW params"), so it reds the day
    // #193 wires a channel overlay into the DoF road and this text goes stale.
    primaryWorkflows: [
      'frame the shot by focal length / field of view',
      'set the clip planes',
      'set the depth-of-field focus (static — an animated focus pull does not reach the render, #193)',
    ],
    // The camera is the first kind to answer the management road NO, and the answer is
    // #479's, not the split's: an NLA strip cannot drive a camera at all, because the pose
    // is resolved by `activeCamera.ts`'s private per-channel scan, which never consults the
    // strip fold. Push-down is a COMPOSITE whose destructive half — delete the bare
    // channels — is sound only because the strip it mints drives the same target, so on a
    // camera it deleted the animation and replaced it with a strip that folds nothing.
    // Both sides now refuse through one expression (`stripDriveRefusal`).
    //
    // ⚠️ WHAT THIS CELL DOES *NOT* COVER, stated because the road's own question hides
    // behind it: the refusal short-circuits BEFORE the enumeration, so for this kind R8
    // never gets to ask whether offer and accept enumerate the data half alike — the thing
    // #386 broke. Two independently sufficient links, one of them untested, which is
    // exactly the shape that makes a green cell lie. The row compensates by asserting WHICH
    // refusal fired (the camera's, naming #480 — not "no bare keyframe channels to push
    // down", which is what a blind enumeration would say). When #480 lands and this entry
    // is deleted, the refusal goes and the enumeration link comes back under test.
    roadAnswers: {
      management: {
        reaches: false,
        why:
          'an NLA strip cannot drive a camera — the pose is resolved outside the strip ' +
          'fold, so push-down would delete the animation instead of converting it',
        issue: '#480',
      },
    },
  },
  baked: {
    dataType: 'BakedData',
    band: 'children',
    fusedTypes: ['BakedMesh'],
    migratesFromVersion: 7,
    // BOTH params are required with no zod default — a baked mesh without its buffer
    // handle or its captured material is not a baked mesh, and defaulting either would
    // mint a plausible wrong thing. So the whole minimum valid node is spelled here.
    // The handle is synthetic: the conformance roads ask where a value is ROUTED, never
    // whether OPFS holds those bytes.
    baseDataParams: {
      geometry: {
        key: 'baked|conformance',
        kind: 'baked',
        descriptor: { kind: 'baked', hash: 'conformance', vertexCount: 8 },
      },
      material: {
        materialClass: 'standard',
        color: '#5af07a',
        roughness: 1,
        metalness: 0,
        opacity: 1,
        transparent: false,
        emissive: '#000000',
        emissiveIntensity: 1,
        map: null,
        normalMap: null,
        roughnessMap: null,
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      },
    },
    // `material.color` is FLAT on a BakedMaterialSpec and survives to the value
    // verbatim. Note the path differs from box/sphere's `material.base.color` — that
    // asymmetry is the whole recipe-vs-buffer difference showing up in one string, and
    // it is why this kind is its own `ObjectData` member rather than a MeshData
    // producer: an inline OpenPBR IR nests under `base`, a baked spec does not.
    observableDataParam: 'material.color',
    // ⚠️ NEITHER may be '#808080'. That is `MODIFIED_FALLBACK_MATERIAL`'s grey — what
    // the renderer produces when a baked spec is narrowed by `'base' in mat` and
    // discarded, which is the measured failure this whole kind is shaped to avoid. A
    // fixture that assterted grey would pass precisely when the road is broken.
    // Like the camera, the observable IS a required mint param, so `baseDataParams`
    // deliberately holds a THIRD colour: the base written by a row must be provably
    // written rather than a mint value coming back.
    distinctValues: ['#c81e5a', '#1e9ac8'],
    channelValueType: 'color',
    readRendered: (r) => at(r, 'data', 'material', 'color'),
    customSections: [],
    dataSections: ['material'],
    primaryWorkflows: [
      'apply transform to freeze a posed object into baked geometry',
      'recolour the baked mesh',
      're-pose the baked mesh after the bake',
      'stack a modifier on the baked Object',
    ],
  },
};

/** Every split kind, as rows. */
export const SPLIT_KIND_NAMES = Object.keys(SPLIT_KINDS) as SplitKindName[];

/**
 * The sections the OBJECT half declares — the same list for every kind, because every
 * kind pairs the same `Object` node with a different data node. That sameness is the
 * point of the split, and stating it once is what lets the sections road assert the
 * per-kind part (`dataSections`) as the ONLY thing that varies.
 *
 * Pinned as an equality against the live `ObjectNode.inspectorSections` by the registry
 * gate, for the same reason `dataSections` is: a copy that can drift would turn the
 * sections road from an observation into a restatement of itself.
 */
export const OBJECT_SECTIONS: readonly string[] = ['transform', 'constraint', 'driver', 'modifier'];
