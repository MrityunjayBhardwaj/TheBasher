// controllerHandles — the pure resolver behind the viewport handles (#295, Epic 1
// Inc 4, decision D-4). The viewport twin of controllersDock.ts: where the dock is a
// UI view over promoted spare params, a handle is the VIEWPORT view over the SAME
// datum — two views over one source (V34), Blender-grounded (a Geometry-Nodes gizmo
// "modifies the value in the socket"; `Gizmo.matrix_basis` is a world 4×4 anchoring
// the handle in the scene).
//
// A promoted spare of a spatial type gets a handle; the SHAPE defaults from the type
// (vec2/vec3 → point, float/int → slider). The optional `handle` field only OVERRIDES
// the shape (e.g. a float as a `dial`) + refines the slider axis/range. An override
// that does not match the type (a `point` on a float) is ignored — the type default
// wins — so a hand-authored / agent project can never render a nonsensical handle.
//
// This module is intentionally params/spare-only (no state, no evaluator, no THREE) so
// it is trivially unit-testable; the viewport component (ControllerHandles.tsx) adds
// the world anchor (resolveWorldTransform) + the drag → setSpareParam commit.
//
// REF: src/core/dag/types.ts (SpareParam.handle / SpareHandleSchema); decision D-4;
//      GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §4; sibling src/app/controllersDock.ts;
//      issue #295.

import type { SpareHandle, SpareParam } from '../core/dag/types';

export type HandleKind = SpareHandle['kind'];
export type HandleAxis = NonNullable<SpareHandle['axis']>;
type SpareType = SpareParam['type'];

/** A fully-resolved viewport handle: the type default + any valid override applied,
 *  so the viewport component never re-derives shape/axis/range. */
export interface HandleSpec {
  /** The node that owns the promoted spare. */
  nodeId: string;
  /** Display name for the node (meta.name ?? id) — for the DEV observation seam. */
  nodeName: string;
  /** The spare-param key. */
  key: string;
  /** The spare param's declared value type (drives point vs scalar drag math). */
  type: SpareType;
  /** The resolved handle shape (override if valid for the type, else type default). */
  kind: HandleKind;
  /** The current spare value (a number for slider/dial, a number[] for point). */
  value: unknown;
  /** Slider track axis / dial plane normal in the anchor's world frame (default per kind). */
  axis: HandleAxis;
  /** Slider range start (default 0). Ignored by point/dial. */
  min: number;
  /** Slider range end (default 1). Ignored by point/dial. */
  max: number;
}

interface NodeLike {
  readonly id: string;
  readonly meta?: { name?: string } | undefined;
  readonly spare?: Readonly<Record<string, SpareParam>> | undefined;
}

/** The default handle shape for a spare type, or null when the type is not spatial
 *  (bool/string get no handle). vec2/vec3 → a positionable point; float/int → a
 *  slider (D-4; `dial` is opt-in only via the override — there is no angle type). */
export function defaultHandleKind(type: SpareType): HandleKind | null {
  switch (type) {
    case 'vec2':
    case 'vec3':
      return 'point';
    case 'float':
    case 'int':
      return 'slider';
    default:
      return null;
  }
}

/** True when `kind` is a sensible handle for `type` — point drives a vector, slider
 *  and dial drive a scalar. Guards the override so an invalid combo falls back to the
 *  type default instead of rendering a handle whose drag math cannot write the value. */
export function kindValidForType(kind: HandleKind, type: SpareType): boolean {
  if (kind === 'point') return type === 'vec2' || type === 'vec3';
  // slider / dial
  return type === 'float' || type === 'int';
}

/** The effective handle kind for a spare: the override when present AND valid for the
 *  type, else the type default, else null (non-spatial type with no valid override). */
export function resolveHandleKind(param: SpareParam): HandleKind | null {
  const override = param.handle?.kind;
  if (override && kindValidForType(override, param.type)) return override;
  return defaultHandleKind(param.type);
}

const DEFAULT_AXIS: Record<HandleKind, HandleAxis> = {
  point: 'x', // unused by point (free 3D), a harmless default
  slider: 'x',
  dial: 'y',
};

/**
 * Every PROMOTED spare param that resolves to a viewport handle, across all nodes,
 * flattened into fully-resolved specs. A spare shows a handle iff it is promoted (the
 * controller opt-in, shared with the dock) AND its type/override resolves to a kind.
 * Ordered by node display name then key so the scene is stable across unrelated edits.
 */
export function collectHandleSpecs(nodes: Readonly<Record<string, NodeLike>>): HandleSpec[] {
  const out: HandleSpec[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.spare) continue;
    const nodeName = node.meta?.name?.trim() || node.id;
    for (const [key, param] of Object.entries(node.spare)) {
      if (param?.promoted !== true) continue;
      const kind = resolveHandleKind(param);
      if (!kind) continue;
      const h = param.handle;
      out.push({
        nodeId: node.id,
        nodeName,
        key,
        type: param.type,
        kind,
        value: param.value,
        axis: h?.axis ?? DEFAULT_AXIS[kind],
        min: typeof h?.min === 'number' ? h.min : 0,
        max: typeof h?.max === 'number' ? h.max : 1,
      });
    }
  }
  out.sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.key.localeCompare(b.key));
  return out;
}
