// Every registered node type has a road IN — gated (#996).
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────
//
// Three times now a node type has shipped complete — registered, evaluated, consumed,
// rendered, and covered by green rows — while nothing in the product could bring one
// into existence (#993 `PoseOverride`, #935 `MotionGenerate`, and the census below).
// Our suites test the road THROUGH a node exhaustively and never once ask whether there
// is a road IN, because every unit row constructs its subject by hand. A fixture that
// builds the node it is testing can never notice that no shipping code can build it.
//
// ── WHY A TEXTUAL SCAN CANNOT ANSWER THIS, MEASURED ───────────────────────────────────
//
// The first three attempts at this census disagreed with each other, and the reason is
// worth keeping because the temptation to grep comes back:
//
//   "type name appears in a file that also emits addNode"  → 10 unreachable
//   "`nodeType: '<T>'` literal only"                       → 29 unreachable
//   "literal ∪ every road resolved at RUNTIME"             →  9 unreachable
//
// The first over-counts roads: it accepted `ArrayModifier` and `SetMaterialOp` on the
// strength of a mention in a COMMENT. The second over-counts unreachables: it cannot see
// `AmbientLight`, `Character` or `BeautyPass`, because those roads pass the type through
// as a variable — the same blind spot filed as #739, reappearing in the checker instead
// of in the scanner. Only the third is exact, and it is exact because every variable road
// in the tree keeps its vocabulary in a value that can simply be READ at run time.
//
// So this gate does not grep for roads it can ask. It greps for exactly one thing — the
// `nodeType:` literal, the one spelling that unambiguously means "mint this type" — and
// asks every other road directly.
//
// ── WHAT IS DELIBERATELY NOT A ROAD ───────────────────────────────────────────────────
//
// `dag.exec` — the agent's raw-op escape hatch — can mint ANY registered type. Counting
// it would make this gate vacuous: every type passes, forever. It is therefore excluded
// from the road set and named in a ledger reason where a type genuinely has no other way
// in (`RenderJob`, whose opt-in status the strategy catalogue documents at catalog.ts).
// That is the escape hatch censused exactly rather than left implicit.
//
// A node literal inside a `DagState` fixture (`type: '<T>'`) is not a road either. It is
// the construction position its sibling gate `retiredKinds.gate.test.ts` calls position 2,
// and it belongs to tests, never to a director.
//
// REF: src/test-utils/retiredKinds.gate.test.ts (the sibling gate over the same relation,
//      and the origin of `stripComments` + the tracked-file enumeration); issues #996,
//      #998 (the dormant locomotion species), #993, #935, #739.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listNodeTypes } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { stripComments } from '../test-utils/sourceScan';
import {
  COMPUTE_KINDS,
  RESOURCE_KINDS,
  SCENE_OBJECT_KINDS,
  nodeTypeFor,
  type PrimitiveKind,
} from './addPrimitives';
import { ADDABLE_CONSTRAINTS } from './constraintStack';
import { operatorTypesInSection } from './operatorChain';
import { PASS_NODE_TYPE_BY_KIND } from '../agent/mutators/builders/addPass';
import type { OperatorSection } from '../core/dag/types';

const REPO_ROOT = process.cwd();

/**
 * The types with no creation road, each with the reason it has none.
 *
 * A ledger, not an allowlist. The difference is the second test below: an entry whose
 * type LATER gains a road is a failure here, not a silent pass. Without that half, this
 * file would rot into the thing it guards against — a list of excuses that outlives the
 * conditions that earned them (#918's shape, one layer up).
 */
const NO_CREATION_ROAD: Readonly<Record<string, string>> = {
  Character:
    'The P3 locomotion species — see #998. The generate panel\'s "character" kind imports ' +
    'a glTF; it does not mint this. Dormant, and its only surface (GroundClick) correctly ' +
    'self-disables when no Character exists.',
  LocomotionState: 'The P3 locomotion species — see #998. Character.inputs.locomotion wants one.',
  Navmesh:
    'The P3 locomotion species — see #998. buildWalkToOps returns null without one, which ' +
    'is why WalkPath has a road it can never actually be taken.',

  PosedSkeleton:
    'Deliberate and known: the target shape of the pose lane, defined early and left ' +
    'unwired. PoseOverride (#993) is the reachable half; this is the socket type both ' +
    'ends speak, and no director authors one directly.',

  RenderJob:
    'Opt-in by design, and the ONE type whose dag.exec road is documented rather than ' +
    'implicit: the strategy catalogue tells the agent to mint it with a raw addNode op ' +
    '("no Mutator yet — RenderJob is opt-in and most projects don\'t seed one"). ' +
    'addPass / addStitch / addAIPass all require one to pre-exist, so the pass lane is ' +
    'agent-reachable and UI-unreachable. That asymmetry is the open question, not this entry.',

  ColorCorrect:
    'Declares chain.section "effect", and NO surface mounts an "+ Add" menu for that ' +
    "section — the two mounted stacks are modifier and material. The compositor's " +
    'ColorCorrect is a DIFFERENT representation: a param-encoded composite entry ' +
    '(app/video/composite.ts), reached by addLayerEffect, which never touches this node.',

  MaterialOverride:
    "Superseded by MaterialOverrideOp, which IS reachable through the material stack's " +
    '"+ Add". This is the pre-operator-lane spelling, still rendered and still walked by ' +
    'the scene hierarchy, but no longer authored.',

  Cut:
    'The Shot/Cut editorial species (THESIS §42), shipped as data in Wave A with its ' +
    'authoring surface never built. The compositor is where editorial lives now.',

  Scatter:
    "THESIS §29's proof that procedural generation is substrate. It evaluates, renders " +
    '(ScatterR) and carries a scene-tree icon, and nothing has ever been able to create ' +
    'one — the oldest instance of exactly the gap this gate exists to catch.',
};

/** Every tracked `.ts`/`.tsx` under `src/` — exactly what CI sees. */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => /\.tsx?$/.test(p));
}

/** Production only: a fixture, a probe or a spec is not a road a director can take. */
const isProduction = (p: string) =>
  !/\.test\.tsx?$/.test(p) &&
  !/(^|\/)tmp-/.test(p) &&
  !/(^|\/)__fixtures__\//.test(p) &&
  !/(^|\/)test-utils\//.test(p);

interface Road {
  readonly type: string;
  readonly road: string;
}

/** Road 1 — a literal `nodeType: '<T>'`, comments stripped so prose never counts. */
function literalRoads(types: readonly string[]): Road[] {
  const found: Road[] = [];
  const alt = types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\bnodeType\\s*:\\s*['"\`](${alt})['"\`]`, 'g');
  for (const rel of trackedSourceFiles().filter(isProduction)) {
    const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    for (const m of src.matchAll(re)) found.push({ type: m[1], road: `literal:${rel}` });
  }
  return found;
}

/**
 * The operator sections with a MOUNTED "+ Add" surface, derived from the call sites
 * rather than listed. Listing them is how ColorCorrect hides: a type can declare a
 * section forever without anyone ever offering it.
 */
function mountedOperatorSections(): OperatorSection[] {
  const re = /addableOperators\(\s*['"`]([a-z]+)['"`]/g;
  const out = new Set<string>();
  for (const rel of trackedSourceFiles().filter(isProduction)) {
    const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return [...out].sort() as OperatorSection[];
}

/** Roads 2-5 — every road that passes the type through as a VARIABLE, asked directly. */
function variableRoads(): Road[] {
  const found: Road[] = [];
  for (const kind of [...SCENE_OBJECT_KINDS, ...COMPUTE_KINDS, ...RESOURCE_KINDS])
    found.push({
      type: nodeTypeFor(kind as PrimitiveKind),
      road: 'addPrimitives (Add menu, meshAdd)',
    });
  for (const c of ADDABLE_CONSTRAINTS)
    found.push({ type: c.type, road: 'constraintStack ("+ Add")' });
  for (const section of mountedOperatorSections()) {
    // `mutator.geometry.addModifier` gates its own vocabulary on
    // `operatorTypesInSection('modifier')`, so it reaches exactly this section's members
    // and no others — named here rather than resolved separately, because naming it for
    // any OTHER section would be a label that reads true and is not.
    const also = section === 'modifier' ? '; mutator.geometry.addModifier' : '';
    for (const type of operatorTypesInSection(section))
      found.push({ type, road: `operator stack "+ Add" (${section})${also}` });
  }
  for (const type of Object.values(PASS_NODE_TYPE_BY_KIND))
    found.push({ type, road: 'mutator.render.addPass' });
  return found;
}

function roadsByType(): Map<string, string[]> {
  registerAllNodes();
  const types = listNodeTypes();
  const known = new Set(types);
  const byType = new Map<string, string[]>(types.map((t) => [t, []]));
  for (const { type, road } of [...literalRoads(types), ...variableRoads()]) {
    if (!known.has(type)) continue; // a road naming an unregistered type is another gate's business
    const list = byType.get(type)!;
    if (!list.includes(road)) list.push(road);
  }
  return byType;
}

describe('#996 — every registered node type has a road IN, or a written reason it has none', () => {
  it('leaves no type both roadless and unexplained', () => {
    const byType = roadsByType();
    const roadless = [...byType].filter(([, roads]) => roads.length === 0).map(([t]) => t);
    const unexplained = roadless.filter((t) => !(t in NO_CREATION_ROAD)).sort();

    expect(
      unexplained,
      unexplained.length === 0
        ? ''
        : `${unexplained.length} node type(s) are registered, evaluated and consumed, and NOTHING ` +
            `in production can create one:\n\n  ${unexplained.join('\n  ')}\n\n` +
            `This is the #993 / #935 shape: a capability with a road THROUGH and no road IN. ` +
            `Either give it a builder, or add it to NO_CREATION_ROAD in this file with the ` +
            `reason it has none. If its road passes the type through as a variable, teach ` +
            `variableRoads() to ask that road — do not widen the literal scan.`,
    ).toEqual([]);
  });

  it('holds no ledger entry that has since gained a road', () => {
    const byType = roadsByType();
    const stale = Object.keys(NO_CREATION_ROAD)
      .filter((t) => (byType.get(t)?.length ?? 0) > 0)
      .map((t) => `${t} — now reachable via ${byType.get(t)!.join(', ')}`)
      .sort();

    expect(
      stale,
      stale.length === 0
        ? ''
        : `NO_CREATION_ROAD explains why these types cannot be created, and they now can:\n\n  ` +
            `${stale.join('\n  ')}\n\nRemove the entry. A reason kept past its conditions is how ` +
            `a ledger becomes a list of excuses.`,
    ).toEqual([]);
  });

  it('names no type in the ledger that is not registered at all', () => {
    registerAllNodes();
    const known = new Set(listNodeTypes());
    const ghosts = Object.keys(NO_CREATION_ROAD)
      .filter((t) => !known.has(t))
      .sort();
    expect(
      ghosts,
      `NO_CREATION_ROAD names ${ghosts.length} type(s) that are no longer registered: ` +
        `${ghosts.join(', ')}. The type was retired — retire its ledger entry with it.`,
    ).toEqual([]);
  });
});
