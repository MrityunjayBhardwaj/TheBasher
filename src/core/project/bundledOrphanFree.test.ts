// #436 — the bundled standard projects (the default "Untitled" + every curated
// example) must ship ORPHAN-FREE. New orphans can no longer be created at runtime
// (#433/#438/#439 guard the delete/duplicate/commit roads), and there are no legacy
// user saves to migrate — so the only projects that exist are the ones authored in
// `default.ts` / `examples.ts`. This guard pins them clean so a future hand-authored
// seed cannot quietly reintroduce debris: a box added without its `children` edge, or
// a channel whose `target` names a typo'd id.
//
// TWO kinds of debris, TWO checks:
//   1. Dangling id-ref — a param names a node that is not present. Checked with the
//      SHIPPED instrument (`findDanglingIdRef`, the V113 final-state guard).
//   2. Edge-orphan — a node wired into nothing: not reachable from any named output,
//      and not named by any live id-ref.
//
// ⚠️ The edge-orphan check must NOT treat every unreachable node as debris. A seed
// deliberately carries unreferenced ROOTS a naive purge would wrongly delete:
//   • `n_time` (TimeSource) — the canonical project clock; a leaf that animation
//     channels wire TO when they exist, consumed by nothing until then.
//   • `n_render` (RenderOutput) — the render sink; it CONSUMES the scene, so it is
//     never reachable by an inputs-walk rooted at `scene` — it is reachable only as
//     the `render` output root.
// Rooting at ALL outputs covers `n_render`; an explicit type allowlist covers the
// intentional leaves. Adding a new intentional leaf is a deliberate edit here, not a
// silent pass.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultProject } from './default';
import { buildAllExampleProjects } from './examples';
import { findDanglingIdRef, idRefsOutOf } from '../dag/idRefSweep';
import type { DagState } from '../dag/state';
import type { NodeRef } from '../dag/types';
import type { Project } from './index';

registerAllNodes();

// Node types that may legitimately sit unreferenced in a seed (see header).
const INTENTIONAL_UNREFERENCED_LEAVES = new Set(['TimeSource']);

/** Nodes reachable from ANY named output, walking inputs (consumer→producer). */
function reachableFromOutputs(state: DagState): Set<string> {
  const seen = new Set<string>();
  const stack = Object.values(state.outputs)
    .map((ref) => ref?.node)
    .filter((id): id is string => !!id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = state.nodes[id];
    if (!node) continue;
    for (const binding of Object.values(node.inputs ?? {})) {
      const refs: NodeRef[] = Array.isArray(binding) ? binding : [binding];
      for (const r of refs) if (r?.node) stack.push(r.node);
    }
  }
  return seen;
}

/** Every node named by a live id-ref anywhere in the graph. */
function idReferred(state: DagState): Set<string> {
  const out = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    for (const t of idRefsOutOf(node)) out.add(t);
  }
  return out;
}

/** Edge-orphans: nodes reachable by NEITHER an output walk NOR a live id-ref, that
 *  are not one of the allowlisted intentional leaves. */
function edgeOrphans(state: DagState): string[] {
  const reachable = reachableFromOutputs(state);
  const referred = idReferred(state);
  return Object.values(state.nodes)
    .filter(
      (n) =>
        !reachable.has(n.id) && !referred.has(n.id) && !INTENTIONAL_UNREFERENCED_LEAVES.has(n.type),
    )
    .map((n) => `${n.id}(${n.type})`)
    .sort();
}

function bundledProjects(): Project[] {
  return [buildDefaultProject(), ...buildAllExampleProjects()];
}

describe('#436 — bundled standard projects ship orphan-free', () => {
  it('no dangling id-ref (V113): no param names a missing node', () => {
    for (const project of bundledProjects()) {
      expect(findDanglingIdRef(project.state.nodes)).toBeNull();
    }
  });

  it('no edge-orphan: every node is reachable from an output or an id-ref (TimeSource leaf allowed)', () => {
    for (const project of bundledProjects()) {
      expect(edgeOrphans(project.state)).toEqual([]);
    }
  });

  // Control — the checks must actually be able to FAIL. A guard that cannot fail is
  // no guard (H180: falsify the instrument, not just the fixture).
  it('CONTROL: the checks catch a genuinely orphaned node and a genuine dangle', () => {
    const clean = buildDefaultProject().state;

    // (1) An edge-orphan: a BoxData wired into nothing.
    const withEdgeOrphan: DagState = {
      ...clean,
      nodes: {
        ...clean.nodes,
        n_stray_data: {
          id: 'n_stray_data',
          type: 'BoxData',
          inputs: {},
          params: { size: [1, 1, 1], material: { name: 'x', base: { color: '#fff' } } },
        } as unknown as (typeof clean.nodes)[string],
      },
    };
    expect(edgeOrphans(withEdgeOrphan)).toEqual(['n_stray_data(BoxData)']);

    // (2) A dangling id-ref: a channel whose `target` names a missing node.
    const withDangle: DagState = {
      ...clean,
      nodes: {
        ...clean.nodes,
        n_ghost_channel: {
          id: 'n_ghost_channel',
          type: 'KeyframeChannelVec3',
          inputs: {},
          params: { target: 'n_does_not_exist', paramPath: 'position', keys: [] },
        } as unknown as (typeof clean.nodes)[string],
      },
    };
    expect(findDanglingIdRef(withDangle.nodes)).toEqual({
      node: 'n_ghost_channel',
      missing: 'n_does_not_exist',
    });
  });
});
