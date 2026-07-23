// agent.identify — resolve a user/LLM phrase to concrete node ids.
//
// Pure: reads dagState, never mutates. The handler does NOT call an LLM.
// It runs local matchers against the DAG and returns an IdentifyResult
// the orchestrator consumes.
//
// Strategy dispatch order (first to produce candidates wins):
//   1. exact-id     — query is a literal nodeId
//   2. selection    — query mentions "selected"/"this"/"it"/"that"
//   3. type-filter  — query word maps to a node type (cube→BoxMesh, etc.)
//   4. color-match  — query mentions a color word (red, green, …) AND a
//                     node carries a matching material.color
//   5. param-match  — fallback for type+color combos
//
// Confidence is derived from candidate count (P-6 mitigation, see
// confidence.ts). The model never reports its own confidence.
//
// REF: P2.5.2 PLAN §5 Wave B; vyapti V13; H21 (the bug class this
// closes — agent guessing wrong target with no explicit disambiguation).

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types';
import type { DagState } from '../../core/dag/state';
import type { Node, NodeId, NodeTypeId } from '../../core/dag/types';
import type { Candidate, IdentifyArgs, IdentifyResult, IdentifyStrategy } from './types';
import { COMMIT_THRESHOLD, deriveConfidence } from './confidence';
import { SCENE_OBJECT_KINDS, nodeTypeFor } from '../../app/addPrimitives';

// ---------------------------------------------------------------------------
// Schema (zod) — boundary validation per V7 / H5.
// ---------------------------------------------------------------------------

export const identifySchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'The user\'s reference phrase, e.g. "the green cube", "selected", "the testimonial text".',
    ),
  hint: z
    .enum(['unique', 'multiple-allowed'])
    .optional()
    .describe('Whether the caller expects exactly one selector or is fine with N.'),
  filter: z
    .object({
      types: z.array(z.string().min(1)).optional(),
    })
    .optional()
    .describe('Optional type filter — restrict candidates to specific node types.'),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const identifyTool: ToolDefinition<IdentifyArgs> = {
  name: 'agent.identify',
  description:
    'Resolve a user reference phrase to concrete node ids. Read-only. ' +
    'Returns either a single committed match (confidence ≥ 0.7), an ambiguous ' +
    'list of candidates (the orchestrator surfaces these to the user), or ' +
    'no-match. Call this BEFORE proposing mutations whenever the request ' +
    'references existing nodes ("the cube", "this", "selected").',
  paramSchema: identifySchema,
  handler(args: IdentifyArgs, ctx: ToolContext): ToolResult {
    const result = identify(args, ctx.dagState, ctx.selectedNodeIds);
    return { ops: [], text: JSON.stringify(result) };
  },
};

// ---------------------------------------------------------------------------
// Pure resolver — exposed for unit tests
// ---------------------------------------------------------------------------

/**
 * Resolve `args.query` against `state` + selection. Pure function: no
 * I/O, no DAG mutation, deterministic given inputs.
 */
export function identify(
  args: IdentifyArgs,
  state: DagState,
  selectedNodeIds?: ReadonlySet<NodeId>,
): IdentifyResult {
  const raw = args.query.trim();
  const q = raw.toLowerCase();
  // #24: Quantifiers (each/all/every/both) and generic-plural nouns
  // ("the cubes") signal multi-target intent. Promote hint to
  // 'multiple-allowed' so the candidate-count threshold doesn't bounce
  // a legitimately-multiple resolution to ambiguous.
  const explicitMulti = hasMultiTargetIntent(q);
  const hint = explicitMulti ? 'multiple-allowed' : (args.hint ?? 'unique');
  const typeFilter = args.filter?.types?.map((t) => t) ?? null;

  // 1. Exact-id strategy.
  if (state.nodes[raw]) {
    return commitMatch(
      [toCandidate(state, state.nodes[raw])],
      'exact-id',
      `Exact node id "${raw}" matched.`,
      hint,
    );
  }

  // 2. Selection strategy. The user explicitly selected these nodes —
  //    that IS the identification. Confidence threshold doesn't apply;
  //    commit all of them regardless of count.
  if (isSelectionPhrase(q)) {
    if (!selectedNodeIds || selectedNodeIds.size === 0) {
      return {
        type: 'no-match',
        rationale: `Query "${raw}" referenced selection, but no nodes are selected.`,
      };
    }
    const candidates = [...selectedNodeIds]
      .map((id) => state.nodes[id])
      .filter((n): n is Node => Boolean(n))
      .map((n) => toCandidate(state, n));
    if (candidates.length === 0) {
      return {
        type: 'no-match',
        rationale: `Selection contains ids not present in the DAG.`,
      };
    }
    return {
      type: 'match',
      confidence: 1.0,
      selectors: candidates.map((c) => c.id),
      rationale: `Resolved "${raw}" to ${candidates.length} selected node(s).`,
      strategy: 'selection',
    };
  }

  // 3. Type-filter strategy. Resolve a node-type alias from the query
  //    (e.g. "cube" → BoxMesh) or honor an explicit args.filter.types.
  const inferredTypes = typeFilter ?? inferNodeTypes(q);
  const hadType = inferredTypes !== null && inferredTypes.length > 0;
  let typeMatched: Candidate[] = [];
  if (hadType && inferredTypes) {
    typeMatched = Object.values(state.nodes)
      .filter((n) => inferredTypes.includes(n.type))
      .map((n) => toCandidate(state, n));
  }

  // Post object↔data split, a cube-Object and a sphere-Object share nodeType 'Object', so a
  // geometry noun ("cube"/"sphere") can't disambiguate by node type alone. Narrow the Object
  // matches by the geometry each POSES, reached through `data` to the BoxData/SphereData —
  // exactly as the color match reaches through `data` (V107). Skipped when the caller passed an
  // explicit filter.types (an explicit type request wins over a parsed noun).
  const geomTypes = typeFilter ? null : geometryDataTypesFor(q);
  if (geomTypes && typeMatched.length > 0) {
    typeMatched = typeMatched.filter((c) => {
      const gt = nodeGeometryType(state, state.nodes[c.id]);
      return gt !== null && geomTypes.includes(gt);
    });
  }

  // #386 C3 (fork-1) — a light noun ("point light", "light") infers 'Object', but every
  // posable light poses a 'LightData', so the data TYPE can't tell a point from a spot.
  // Narrow the Object matches by the posed lightKind (reached through `data`, mirroring the
  // geometry + colour reaches). An AmbientLight is a light too but poses no LightData, so it
  // passes through unfiltered (it matched by its own type in inferNodeTypes).
  const lightKinds = typeFilter ? null : lightKindsFor(q);
  if (lightKinds && typeMatched.length > 0) {
    typeMatched = typeMatched.filter((c) => {
      const node = state.nodes[c.id];
      if (node?.type === 'AmbientLight') return true;
      const lk = nodeLightKind(state, node);
      return lk !== null && lightKinds.has(lk);
    });
  }

  // 4. Color-match — narrow type-matched (or all nodes if no type) by
  //    a color word in the query.
  const colorHex = inferColor(q);
  const hadColor = colorHex !== null;
  const colorMatched = colorHex
    ? (typeMatched.length > 0
        ? typeMatched
        : // No type word: scan the scene-object universe, NOT every node. A split cube's
          // color lives on its BoxData, which identify reaches through `data` (V107) — so
          // scanning data leaves too would surface the BoxData as a phantom selectable AND
          // double-count the cube (Object via reach + BoxData via own material).
          Object.values(state.nodes)
            .filter((n) => ALL_PRIMITIVE_TYPES.includes(n.type))
            .map((n) => toCandidate(state, n))
      ).filter((c) => colorsInSameFamily(nodeColorHex(state, state.nodes[c.id]), colorHex))
    : null;

  // Conjunction logic: when the query supplies BOTH a color and a type,
  // both must narrow non-empty. Falling back to type-only when the user
  // asked for "orange cube" but no cube is orange is wrong — it surfaces
  // candidates that don't satisfy the explicit color predicate.
  if (hadColor && hadType && (!colorMatched || colorMatched.length === 0)) {
    return {
      type: 'no-match',
      rationale:
        `No nodes of type ${inferredTypes!.join('/')} match color ${colorHex} ` +
        `(parsed from "${raw}").`,
    };
  }

  // Pick the strongest narrowing: color+type → color → type → none.
  let candidates: Candidate[];
  let strategy: IdentifyStrategy;
  if (colorMatched && colorMatched.length > 0) {
    candidates = colorMatched;
    strategy = typeMatched.length > 0 ? 'param-match' : 'color-match';
  } else if (typeMatched.length > 0) {
    candidates = typeMatched;
    strategy = 'type-filter';
  } else if (hadColor) {
    // A color was named but nothing carried it.
    return {
      type: 'no-match',
      rationale: `No nodes match color ${colorHex} (parsed from "${raw}").`,
    };
  } else if (hadType) {
    // Type was named but no node of that type exists.
    return {
      type: 'no-match',
      rationale: `No nodes of type ${inferredTypes!.join('/')} found.`,
    };
  } else {
    return {
      type: 'no-match',
      rationale: `Could not resolve "${raw}" — no exact id, no selection match, no type alias, no color match.`,
    };
  }

  return commitMatch(
    candidates,
    strategy,
    `Resolved "${raw}" via ${strategy} → ${candidates.length} candidate(s).`,
    hint,
  );
}

// ---------------------------------------------------------------------------
// Decision: commit vs ambiguous (P-6 confidence threshold)
// ---------------------------------------------------------------------------

function commitMatch(
  candidates: Candidate[],
  strategy: IdentifyStrategy,
  rationale: string,
  hint: 'unique' | 'multiple-allowed',
): IdentifyResult {
  if (candidates.length === 0) {
    return { type: 'no-match', rationale };
  }

  // 'multiple-allowed' callers are fine with N — commit at any count
  // above zero. Type consistency is irrelevant when the caller asked
  // for a set explicitly.
  if (hint === 'multiple-allowed') {
    return {
      type: 'match',
      confidence: 1.0,
      selectors: candidates.map((c) => c.id),
      rationale,
      strategy,
    };
  }

  // 'unique': use the candidate-count → confidence mapping.
  const typeConsistent = areTypesConsistent(candidates);
  const confidence = deriveConfidence({ candidates, typeConsistent });

  if (confidence >= COMMIT_THRESHOLD) {
    return {
      type: 'match',
      confidence,
      selectors: candidates.map((c) => c.id),
      rationale,
      strategy,
    };
  }

  return {
    type: 'ambiguous',
    candidates,
    rationale: `${rationale} Confidence ${confidence.toFixed(2)} below commit threshold.`,
  };
}

function areTypesConsistent(candidates: Candidate[]): boolean {
  if (candidates.length === 0) return false;
  const first = candidates[0].nodeType;
  return candidates.every((c) => c.nodeType === first);
}

// ---------------------------------------------------------------------------
// Helpers — selection phrases, type aliases, color words
// ---------------------------------------------------------------------------

const SELECTION_PHRASES = [
  /^selected$/,
  /^this$/,
  /^that$/,
  /^it$/,
  /^the\s+selected\b/,
  /^this\s+\w+$/,
  /^selected\s+\w+$/,
];

function isSelectionPhrase(q: string): boolean {
  return SELECTION_PHRASES.some((re) => re.test(q));
}

/**
 * Map a phrase to candidate node-type ids. Returns null when no alias
 * fires. Order: longest match wins (e.g. "directional light" before
 * "light").
 */
// Generic-primitive type set — what "object", "thing", "everything" expand to.
//
// DERIVED from the Add menu's scene-object vocabulary (#324), not a second hand-written copy
// of it. The two lists were kept in parallel by hand, and they drifted exactly as you would
// expect: `Null` and `Curve` were addable with the mouse but "everything" silently skipped
// them, so a director could not refer to an object they had just made. The rule the derivation
// states is: **whatever the director can ADD, they can also TALK ABOUT.**
//
// (Aggregators like Scene and authoring nodes like MaterialOverride/Scatter stay out for the
// same reason as before — they are not things the phrase "the objects" points at. They aren't
// scene-object KINDS either, so the derivation excludes them for free.)
// #365 Phase 5a — a Cube maps to nodeType 'Object' (the split's pose half). Slice 1b added
// a fused 'BoxMesh' coexistence tail so "the objects"/"everything" also found not-yet-migrated
// saves; Slice 2 retires the fused value kind (old saves split on load, K23), so the tail is
// gone — every scene object is an Object (or another split-native kind).
const ALL_PRIMITIVE_TYPES: NodeTypeId[] = [
  ...(SCENE_OBJECT_KINDS.map(nodeTypeFor) as NodeTypeId[]),
];

// The data-node type a geometry noun matches, post object↔data split: "cube" is any Object posing
// a BoxData; "sphere" a SphereData (the fused BoxMesh/SphereMesh value kinds are retired, so no
// live node carries them). Returns null when the query names no geometry noun, so lights/cameras/
// empties aren't narrowed. Kept in lockstep with the cube/sphere aliases in inferNodeTypes.
function geometryDataTypesFor(q: string): string[] | null {
  if (/\b(cubes?|box(es)?|boxmesh)\b/.test(q)) return ['BoxData'];
  if (/\b(spheres?|balls?|spheremesh)\b/.test(q)) return ['SphereData'];
  // #385 C2 — a curve Object poses a CurveData. Without this arm "the curve" (which infers
  // 'Object') would match every box/sphere Object too (the over-broad enumeration hazard).
  if (/\b(curve(s)?|path(s)?|spline(s)?)\b/.test(q)) return ['CurveData'];
  return null;
}

// #386 C3 (fork-1) — which posable lightKinds a query names. A single discriminated LightData
// collapses "which posable kind" into a param, so a light noun can't be narrowed by data TYPE
// (all four pose 'LightData'); this returns the lightKind set to match instead. Null when the
// query names no light noun; the specific set for a specific noun; all four for generic "light".
// AmbientLight is intentionally absent — it poses no LightData and is matched by its own type.
function lightKindsFor(q: string): Set<string> | null {
  const kinds = new Set<string>();
  if (/\b(directional\s+light|sun)\b/.test(q)) kinds.add('Directional');
  if (/\b(point\s+light)\b/.test(q)) kinds.add('Point');
  if (/\b(spot\s+light)\b/.test(q)) kinds.add('Spot');
  if (/\b(area\s+light)\b/.test(q)) kinds.add('Area');
  if (kinds.size > 0) return kinds;
  if (/\blight(s)?\b/.test(q)) return new Set(['Directional', 'Point', 'Spot', 'Area']);
  return null;
}

function inferNodeTypes(q: string): NodeTypeId[] | null {
  const matches: NodeTypeId[] = [];
  // Specific lights first — checked before the generic "light" rule. #386 C3 — the four
  // posable lights are the Object+LightData split, so they resolve to 'Object' (the node
  // the director selects); lightKindsFor narrows those Objects to the posed lightKind
  // (all posable lights pose 'LightData', so the data TYPE alone can't tell a point from a
  // spot). AmbientLight stays fused → its own type.
  if (/\b(directional\s+light|sun)\b/.test(q)) matches.push('Object');
  if (/\b(point\s+light)\b/.test(q)) matches.push('Object');
  if (/\b(spot\s+light)\b/.test(q)) matches.push('Object');
  if (/\b(area\s+light)\b/.test(q)) matches.push('Object');
  if (/\b(ambient\s+light)\b/.test(q)) matches.push('AmbientLight');
  if (matches.length > 0) return matches;

  // Generic "light" — the posable Objects (narrowed by lightKindsFor to the ones posing a
  // LightData, so a cube-Object is NOT swept in) plus the still-fused AmbientLight.
  if (/\blight(s)?\b/.test(q)) {
    return ['Object', 'AmbientLight'];
  }

  // #365 Phase 5a — a cube is the Object+BoxData split (nodeType 'Object'). Slice 2 retired
  // the fused 'BoxMesh' value kind (old saves split on load), so "cube" resolves to 'Object'.
  if (/\b(cubes?|box(es)?|boxmesh)\b/.test(q)) return ['Object'];
  // #384 Stage C — a sphere is the Object+SphereData split (nodeType 'Object'). Slice 4 retires
  // the fused 'SphereMesh' value kind (old saves split on load), so "sphere" resolves to 'Object'.
  if (/\b(spheres?|balls?|spheremesh)\b/.test(q)) return ['Object'];
  // Specific cameras before the generic "camera" rule (parallels lights).
  if (/\bperspective\s+camera\b/.test(q)) return ['PerspectiveCamera'];
  if (/\borthographic\s+camera\b/.test(q)) return ['OrthographicCamera'];
  if (/\b(camera|cameras)\b/.test(q)) return ['PerspectiveCamera', 'OrthographicCamera'];
  if (/\bcharacter(s)?\b/.test(q)) return ['Character'];
  // #324 — the words a DIRECTOR uses for the two objects the agent was blind to. Neither is
  // ever called by its type name in a sentence: nobody says "add a Curve node", they say
  // "make a path for the camera to fly along" or "put a target where she's looking".
  // Checked BEFORE 'group'/'transform' so "empty" can't be captured by a looser rule later.
  // #385 C2 — a curve is the Object+CurveData split (nodeType 'Object'). The fused 'Curve'
  // value kind retires on load (old saves split, so "curve"/"path"/"spline" resolves to
  // 'Object'); geometryDataTypesFor narrows those Objects to the ones posing a CurveData.
  if (/\b(curve(s)?|path(s)?|spline(s)?)\b/.test(q)) return ['Object'];
  if (/\b(null(s)?|empty|empties|controller(s)?|target(s)?)\b/.test(q)) return ['Null'];
  if (/\bgroup(s)?\b/.test(q)) return ['Group'];
  if (/\btransform(s)?\b/.test(q)) return ['Transform'];

  // #25: Generic-noun aliases. "object/thing/everything" → all visible
  // primitives. The Mutator's gate-4 precondition narrows further per
  // verb — e.g. "rotate the objects" rejects nodes lacking a rotation
  // param via the precondition path. So Identify can be permissive
  // here and let the validator do the verb-specific filtering.
  if (/\b(object|objects|thing|things)\b/.test(q)) return [...ALL_PRIMITIVE_TYPES];
  if (/\beverything\b|\ball\s+of\s+them\b/.test(q)) return [...ALL_PRIMITIVE_TYPES];
  // "node" / "nodes" is a pro-mode term — same expansion.
  if (/\b(node|nodes)\b/.test(q)) return [...ALL_PRIMITIVE_TYPES];

  return null;
}

/**
 * Detect quantifier or plural-noun cues that signal multi-target intent.
 * Used to promote `hint` to 'multiple-allowed' so the candidate-count
 * confidence derivation doesn't reject a legitimately-multiple
 * resolution as ambiguous (#24).
 *
 * Examples that match: "each cube", "all spheres", "every light",
 * "both cameras", "the cubes" (bare plural after "the").
 *
 * Examples that don't: "ball" (no \\bplural marker), "called" (no
 * standalone quantifier), "things" alone (it WOULD match — that's
 * intentional; "things" implies plural).
 */
function hasMultiTargetIntent(q: string): boolean {
  // Explicit quantifiers — singular-target prompt does NOT use these.
  if (/\b(each|all|every|both)\b/.test(q)) return true;
  // Generic-plural cues — "everything", "all of them", and bare
  // generic plurals ("objects", "things", "nodes") all imply plural.
  if (/\b(everything|all\s+of\s+them)\b/.test(q)) return true;
  if (/\b(objects|things|nodes)\b/.test(q)) return true;
  // "the X{plural}" with a known type noun — "the cubes", "the spheres",
  // "the boxes". Plural marker = trailing "s" on a known noun. Match
  // against the type-noun list to avoid misfiring on irrelevant plurals.
  if (
    /\bthe\s+(cubes|boxes|spheres|balls|lights|cameras|characters|groups|objects|things|nodes)\b/.test(
      q,
    )
  ) {
    return true;
  }
  return false;
}

const COLOR_WORDS: Record<string, string> = {
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  white: '#ffffff',
  black: '#000000',
  orange: '#ffa500',
  purple: '#800080',
};

/**
 * Map a color word in the query to a hex string. Recognises explicit
 * `#rrggbb` patterns too.
 *
 * #16 — Deterministic resolution: when multiple color words match the
 * query (e.g. "red and green cube"), pick the FIRST occurrence by
 * position. Object.entries iteration order is engine-dependent for
 * non-integer string keys; relying on it for resolution makes the
 * answer engine-deterministic but not spec-deterministic. Match-index
 * tie-break is intuitive (first-mentioned wins) AND spec-stable.
 */
function inferColor(q: string): string | null {
  const explicit = q.match(/#([0-9a-f]{6})\b/);
  if (explicit) return `#${explicit[1].toLowerCase()}`;
  let bestIdx = -1;
  let bestHex: string | null = null;
  for (const [word, hex] of Object.entries(COLOR_WORDS)) {
    const m = new RegExp(`\\b${word}\\b`).exec(q);
    if (m && (bestIdx === -1 || m.index < bestIdx)) {
      bestIdx = m.index;
      bestHex = hex;
    }
  }
  return bestHex;
}

/**
 * Convert `#rrggbb` to HSL. Returns null on malformed input. Hue in
 * [0, 360), saturation + lightness in [0, 1].
 */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** Minimum modular hue distance in [0, 180]. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * #18 — Color-family match: do two hex colors belong to the same named
 * family ("red", "blue", etc.)?
 *
 * Replaces strict hex equality so picker-sampled colors that drifted
 * a few digits (#ff0001 vs #ff0000) still match "red". Heuristic:
 *
 * - Grayscale band (low saturation OR extreme lightness): compare on
 *   lightness; coloured-vs-grayscale is always different family.
 * - Both colored: hue distance ≤ 25° AND lightness within 0.4.
 *
 * Tuned for the 10 starter COLOR_WORDS entries; thresholds favor false
 * negatives over false positives (better to ask the user than to mis-
 * select). Refine when the catalogue or eval surface demands.
 */
function colorsInSameFamily(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true; // exact hit shortcut
  const A = hexToHsl(a);
  const B = hexToHsl(b);
  if (!A || !B) return a === b;
  const aGray = A.s < 0.15 || A.l < 0.1 || A.l > 0.9;
  const bGray = B.s < 0.15 || B.l < 0.1 || B.l > 0.9;
  if (aGray !== bGray) return false;
  if (aGray) return Math.abs(A.l - B.l) < 0.2;
  // Saturation bound (#29): hue+lightness alone let desaturated reds in —
  // brown(#a52a2a, s~0.55) vs red(#ff0000, s 1.0) → Δs 0.45 → REJECTED.
  // salmon(#fa8072, s~0.93) → Δs 0.07 → still MATCHES (intentional —
  // salmon is reddish; a user asking for "red" expects salmon included).
  return hueDistance(A.h, B.h) <= 25 && Math.abs(A.l - B.l) < 0.3 && Math.abs(A.s - B.s) < 0.3;
}

// Read a color hex directly off a node's OWN params (no split reach).
function colorFromParams(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  // BoxData / SphereMesh shape: params.material.base.color (v0.6 #2 OpenPBR IR).
  // Dual-accept a legacy top-level color (pre-migration in-memory objects).
  const material = params.material as { base?: { color?: unknown }; color?: unknown } | undefined;
  if (typeof material?.base?.color === 'string') {
    return material.base.color.toLowerCase();
  }
  if (material && typeof material.color === 'string') {
    return material.color.toLowerCase();
  }
  // Light shape: params.color
  if (typeof params.color === 'string') {
    return (params.color as string).toLowerCase();
  }
  return null;
}

// The color hex for a node, reaching through the object↔data split: a split cube's
// material lives on the BoxData its Object points at via `data`, not on the Object itself
// (V107 — every consumer of a data param must reach through `data` to the owner, same as
// resolveDataParamOwner does for the inspector/mutators). Own params win; the data node
// is the fallback so a directly-inspected BoxData/SphereMesh/light still resolves.
function nodeColorHex(state: DagState, node: Node | undefined): string | null {
  if (!node) return null;
  const own = colorFromParams(node.params as Record<string, unknown> | undefined);
  if (own !== null) return own;

  const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
    | { node?: string }
    | undefined;
  if (dataRef?.node) {
    const dataNode = state.nodes[dataRef.node];
    return colorFromParams(dataNode?.params as Record<string, unknown> | undefined);
  }
  return null;
}

// The geometry-defining type of a scene object, reaching through the object↔data split: a split
// cube/sphere's geometry lives on the BoxData/SphereData its Object points at via `data`; a fused
// mesh (or a directly-named data node) carries it on its own type. Mirrors nodeColorHex's reach —
// this is what lets a geometry noun separate "cube" (BoxData) from "sphere" (SphereData) once both
// pose through a shared `Object` node type.
function nodeGeometryType(state: DagState, node: Node | undefined): string | null {
  if (!node) return null;
  const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
    | { node?: string }
    | undefined;
  if (dataRef?.node) {
    const dataNode = state.nodes[dataRef.node];
    if (dataNode) return dataNode.type;
  }
  return node.type;
}

// #386 C3 (fork-1) — the posed light's kind, reaching through `data` to the LightData's
// `lightKind` param. This is what lets a light noun separate "point light" from "spot light"
// once both pose through a shared 'Object' node type. Null when the node poses no LightData.
function nodeLightKind(state: DagState, node: Node | undefined): string | null {
  if (!node) return null;
  const dataRef = (node.inputs as Record<string, unknown> | undefined)?.data as
    | { node?: string }
    | undefined;
  if (dataRef?.node) {
    const dataNode = state.nodes[dataRef.node];
    if (dataNode?.type === 'LightData') {
      const lk = (dataNode.params as Record<string, unknown> | undefined)?.lightKind;
      return typeof lk === 'string' ? lk : null;
    }
  }
  return null;
}

function toCandidate(state: DagState, node: Node): Candidate {
  return {
    id: node.id,
    nodeType: node.type,
    summary: summarizeNode(state, node),
  };
}

function summarizeNode(state: DagState, node: Node): string | undefined {
  const params = node.params as Record<string, unknown> | undefined;
  const bits: string[] = [];
  const pos = params?.position;
  if (Array.isArray(pos) && pos.length === 3) bits.push(`pos [${pos.join(',')}]`);
  const color = nodeColorHex(state, node);
  if (color) bits.push(`color ${color}`);
  return bits.length > 0 ? bits.join(', ') : undefined;
}
