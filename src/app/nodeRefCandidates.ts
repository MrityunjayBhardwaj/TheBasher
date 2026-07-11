// nodeRefCandidates — the pure candidate resolver for the general node-ref param picker
// (the Blender object-picker / Houdini node-path-param idiom). Given a `kind` declared by
// a node's `refParams`, list the nodes a user may pick for that reference. Kept pure +
// testable (no store reads); the Inspector's NodeRefField consumes it.
//
// The `kind` filter uses GROUND-TRUTH signals, not a fragile type denylist (every scene
// node — mesh, light, camera, group — outputs 'SceneObject', so the socket type can't
// discriminate):
//   • 'mesh'         — `resolveEvaluatedMesh` resolves (non-null) → an actual geometry
//                      producer (BoxMesh/Sphere/Gltf/Baked/Modified), never a light/camera/
//                      group/Null. This is exactly what the geometry sampler can consume.
//   • 'transformable'— the node carries a vec3 `position` param (what the world resolver
//                      reads) → a Null / mesh / group / camera / light; excludes infra
//                      nodes (Scene, RenderOutput, TimeSource, ParamDriver) that have none.
//   • 'any'          — every node except the querying node itself.
//
// REF: src/core/dag/types.ts (NodeDefinition.refParams); src/app/resolveEvaluatedMesh.ts;
//      src/app/NPanel.tsx (NodeRefField).

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';

export type NodeRefKind = 'mesh' | 'transformable' | 'any';

export interface NodeRefCandidate {
  id: string;
  /** The user-facing label: the node's name, else its id. */
  label: string;
  /** The node type, shown as a secondary hint (e.g. "BoxMesh"). */
  type: string;
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/**
 * The nodes eligible for a `kind` reference, excluding `selfId` (a node never
 * references itself). Sorted by label for a stable picker. `ctx`/`cache` are used only
 * for the 'mesh' ground-truth check (mesh-ness is time-invariant, so a frame-0 ctx is
 * fine); pass the shared cache when one is available to avoid redundant evaluation.
 */
export function nodeRefCandidates(
  state: DagState,
  kind: NodeRefKind,
  selfId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): NodeRefCandidate[] {
  const out: NodeRefCandidate[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.id === selfId) continue;
    const ok =
      kind === 'any'
        ? true
        : kind === 'transformable'
          ? isVec3((node.params as { position?: unknown } | undefined)?.position)
          : resolveEvaluatedMesh(state, node.id, ctx, cache) !== null; // 'mesh'
    if (!ok) continue;
    out.push({ id: node.id, label: node.meta?.name?.trim() || node.id, type: node.type });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
