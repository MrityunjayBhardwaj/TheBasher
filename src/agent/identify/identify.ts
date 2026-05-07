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
  const hint = args.hint ?? 'unique';
  const typeFilter = args.filter?.types?.map((t) => t) ?? null;

  // 1. Exact-id strategy.
  if (state.nodes[raw]) {
    return commitMatch(
      [toCandidate(state.nodes[raw])],
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
      .map(toCandidate);
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
      .map(toCandidate);
  }

  // 4. Color-match — narrow type-matched (or all nodes if no type) by
  //    a color word in the query.
  const colorHex = inferColor(q);
  const hadColor = colorHex !== null;
  const colorMatched = colorHex
    ? (typeMatched.length > 0 ? typeMatched : Object.values(state.nodes).map(toCandidate))
        .filter((c) => nodeColorHex(state.nodes[c.id]) === colorHex)
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
function inferNodeTypes(q: string): NodeTypeId[] | null {
  const matches: NodeTypeId[] = [];
  // Specific lights first — checked before the generic "light" rule.
  if (/\b(directional\s+light|sun)\b/.test(q)) matches.push('DirectionalLight');
  if (/\b(point\s+light)\b/.test(q)) matches.push('PointLight');
  if (/\b(spot\s+light)\b/.test(q)) matches.push('SpotLight');
  if (/\b(area\s+light)\b/.test(q)) matches.push('AreaLight');
  if (/\b(ambient\s+light)\b/.test(q)) matches.push('AmbientLight');
  if (matches.length > 0) return matches;

  // Generic "light" — all light types.
  if (/\blight(s)?\b/.test(q)) {
    return ['DirectionalLight', 'PointLight', 'SpotLight', 'AreaLight', 'AmbientLight'];
  }

  if (/\b(cube|box|boxmesh)\b/.test(q)) return ['BoxMesh'];
  if (/\b(sphere|ball|spheremesh)\b/.test(q)) return ['SphereMesh'];
  if (/\b(camera|cameras)\b/.test(q)) return ['PerspectiveCamera', 'OrthographicCamera'];
  if (/\bperspective\s+camera\b/.test(q)) return ['PerspectiveCamera'];
  if (/\borthographic\s+camera\b/.test(q)) return ['OrthographicCamera'];
  if (/\bcharacter(s)?\b/.test(q)) return ['Character'];
  if (/\bgroup(s)?\b/.test(q)) return ['Group'];
  if (/\btransform(s)?\b/.test(q)) return ['Transform'];

  return null;
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
 */
function inferColor(q: string): string | null {
  const explicit = q.match(/#([0-9a-f]{6})\b/);
  if (explicit) return `#${explicit[1].toLowerCase()}`;
  for (const [word, hex] of Object.entries(COLOR_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) {
      // Match at the family level: "red sphere" matches both "#ff0000"
      // and any node whose color falls in the red family. We keep it
      // strict for v0.5 — exact hex match. Family-level fuzzy match can
      // land in Wave C if Mutator preconditions need it.
      return hex;
    }
  }
  return null;
}

function nodeColorHex(node: Node | undefined): string | null {
  if (!node) return null;
  const params = node.params as Record<string, unknown> | undefined;
  if (!params) return null;
  // BoxMesh / SphereMesh shape: params.material.color
  const material = params.material as Record<string, unknown> | undefined;
  if (material && typeof material.color === 'string') {
    return material.color.toLowerCase();
  }
  // Light shape: params.color
  if (typeof params.color === 'string') {
    return (params.color as string).toLowerCase();
  }
  return null;
}

function toCandidate(node: Node): Candidate {
  return {
    id: node.id,
    nodeType: node.type,
    summary: summarizeNode(node),
  };
}

function summarizeNode(node: Node): string | undefined {
  const params = node.params as Record<string, unknown> | undefined;
  if (!params) return undefined;
  const bits: string[] = [];
  const pos = params.position;
  if (Array.isArray(pos) && pos.length === 3) bits.push(`pos [${pos.join(',')}]`);
  const color = nodeColorHex(node);
  if (color) bits.push(`color ${color}`);
  return bits.length > 0 ? bits.join(', ') : undefined;
}
