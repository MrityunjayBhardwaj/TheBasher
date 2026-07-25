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
import { recomposeLightObject } from '../nodes/lightRecompose';

/** The kinds that have actually been split. One name per `ObjectData` producer. */
export type SplitKindName = 'box' | 'sphere' | 'curve' | 'light';

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
  /** This kind's primary workflows that route through a param the split MOVED. Asserted
   *  non-empty: an empty list would read as coverage while checking nothing. */
  readonly primaryWorkflows: readonly string[];
}

/** The data-node id every split builder derives for a given Object id. */
export function dataIdFor(objectId: string): string {
  return `${objectId}_data`;
}

/**
 * The op triple that creates one split pair: the data node, the Object, and the `data`
 * edge between them, in dependency order.
 *
 * This is the ONE place the shape lives — the node types, the socket names, the edge
 * DIRECTION and the ordering. Callers keep their own param defaulting (the unit helpers
 * omit what the caller did not pass and let zod fill in; the e2e builders always write
 * all three pose params). Those defaults are NOT unified here on purpose: ~75 call sites
 * depend on the current behaviour, and "does this node have that key" is an observable
 * difference, not a cosmetic one.
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
    // BoxData's default is '#5af07a' and the missing-material fallback is a grey —
    // neither of these collides with either.
    distinctValues: ['#c81e5a', '#1e9ac8'],
    readRendered: (r) => at(r, 'data', 'material', 'base', 'color'),
    customSections: [],
    primaryWorkflows: ['resize the box', 'recolour the box', 'stack a modifier on the Object'],
  },
  sphere: {
    dataType: 'SphereData',
    band: 'children',
    fusedTypes: ['SphereMesh'],
    migratesFromVersion: 3,
    baseDataParams: {},
    observableDataParam: 'material.base.color',
    // SphereData's default is '#88aaff'.
    distinctValues: ['#c81e5a', '#1e9ac8'],
    readRendered: (r) => at(r, 'data', 'material', 'base', 'color'),
    customSections: [],
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
    readRendered: (r) => at(r, 'data', 'closed'),
    customSections: ['curve'],
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
    // NO `.data` — the recomposed LightValue is FLAT. This asymmetry against the three
    // mesh-band extractors above is the band difference made visible.
    readRendered: (r) => at(r, 'intensity'),
    customSections: [],
    primaryWorkflows: ['dim or brighten the light', 'arrange the three-point studio rig'],
  },
};

/** Every split kind, as rows. */
export const SPLIT_KIND_NAMES = Object.keys(SPLIT_KINDS) as SplitKindName[];
