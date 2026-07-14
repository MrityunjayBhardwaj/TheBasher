// THE DIRECTOR'S VOCABULARY — whatever can be ADDED with the mouse can be ASKED FOR by name,
// and REFERRED TO afterwards (#324).
//
// This pins the rule that `Null` (#296) and `Curve` (#321) each broke on the way in. Both were
// scene objects in the Add menu and neither existed for the agent: `mesh.add`'s zod enum
// REJECTED them at runtime, and `identify`'s primitive list silently skipped them, so a
// director could build a path with the mouse and not be able to say "add a curve" — which is
// the entire camera-rig story. Nothing caught it, because both lists were hand-copied SUBSETS
// of `PrimitiveKind`: a scene object could be added to the union, wired into the menu, and
// shipped VOICELESS without a compile error or a red test.
//
// The lists are now DERIVED from `SCENE_OBJECT_KINDS`, so the drift is impossible by
// construction. These tests exist for the case the derivation is ever "simplified" back into a
// literal — they assert the RULE (every scene object is creatable and referrable), not the
// current membership of a list, so they keep their teeth as the vocabulary grows.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import {
  COMPUTE_KINDS,
  SCENE_OBJECT_KINDS,
  nodeTypeFor,
  type PrimitiveKind,
} from '../app/addPrimitives';
import { meshAddSchema, meshAddTool } from './tools/meshAdd';
import { identify } from './identify/identify';
import type { IdentifyResult } from './identify/types';
import type { NodeId } from '../core/dag/types';

/** The node ids an identify outcome names, whichever branch it took. A confident single hit
 *  commits `selectors`; a multi-hit ("everything") surfaces `candidates` for the user to pick
 *  from. Both are "the agent found these" — only the follow-up differs. */
function resolvedIds(r: IdentifyResult): NodeId[] {
  if (r.type === 'match') return r.selectors;
  if (r.type === 'ambiguous') return r.candidates.map((c) => c.id);
  return [];
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** Run mesh.add exactly as the agent does — through the schema, then the handler. */
function agentAdds(state: DagState, kind: string): DagState {
  const args = meshAddSchema.parse({ kind }); // the gate Null/Curve used to die at
  const result = meshAddTool.handler(args, { dagState: state } as never);
  let next = state;
  for (const op of result.ops) next = applyOp(next, op).next;
  return next;
}

describe('every scene object the mouse can add, the agent can add', () => {
  it.each(SCENE_OBJECT_KINDS)('mesh.add accepts %s and creates its node', (kind) => {
    const before = buildDefaultDagState();
    const after = agentAdds(before, kind);
    const created = Object.values(after.nodes).filter(
      (n) => !before.nodes[n.id] && n.type === nodeTypeFor(kind as PrimitiveKind),
    );
    expect(created, `mesh.add produced no ${nodeTypeFor(kind as PrimitiveKind)}`).toHaveLength(1);
  });

  it('names every scene object in the tool description the LLM reads', () => {
    // A third copy of the vocabulary lives in the description — and it is the one the model
    // actually consults, so a stale one is the loudest failure of all ("I can't add a curve").
    for (const kind of SCENE_OBJECT_KINDS) {
      expect(meshAddTool.description).toContain(kind);
    }
  });

  it('does NOT expose the compute vocabulary — that exclusion is a decision, not an oversight', () => {
    // "Add a Lag" is not a sentence a director says: these are floating number nodes with no
    // body, authored where their sources are picked. Pinned so a future "completeness" pass
    // can't quietly widen the agent's surface to nodes it has no way to place.
    for (const kind of COMPUTE_KINDS) {
      expect(meshAddSchema.safeParse({ kind }).success, `${kind} leaked into mesh.add`).toBe(false);
    }
  });
});

describe('every scene object the agent can add, it can refer to afterwards', () => {
  /** A scene holding one of every scene-object kind, added the way the agent adds them. */
  function sceneOfEverything(): DagState {
    let s = buildDefaultDagState();
    for (const kind of SCENE_OBJECT_KINDS) s = agentAdds(s, kind);
    return s;
  }

  it('"everything" resolves to every kind — none silently skipped', () => {
    const state = sceneOfEverything();
    const resolvedTypes = new Set(
      resolvedIds(identify({ query: 'everything' }, state)).map((id) => state.nodes[id]?.type),
    );
    for (const kind of SCENE_OBJECT_KINDS) {
      const type = nodeTypeFor(kind as PrimitiveKind);
      expect(resolvedTypes.has(type), `"everything" skipped ${type}`).toBe(true);
    }
  });

  // The words a director actually says. Nobody asks for "a Curve node" — they ask for the
  // path the camera flies along, or the target the actor looks at.
  it.each([
    ['the curve', 'Curve'],
    ['the path', 'Curve'],
    ['the spline', 'Curve'],
    ['the null', 'Null'],
    ['the empty', 'Null'],
    ['the controller', 'Null'],
    ['the target', 'Null'],
  ])('"%s" resolves to a %s', (query, type) => {
    const state = sceneOfEverything();
    const ids = resolvedIds(identify({ query }, state));
    expect(ids.length, `"${query}" resolved to nothing`).toBeGreaterThan(0);
    // Every id it resolved is of that type — the noun points at ONE kind, not a grab-bag.
    for (const id of ids) expect(state.nodes[id].type).toBe(type);
  });
});
