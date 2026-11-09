// objectNames — the name a new scene object is given (#1518).
//
// Blender names an object when it makes it, and never leaves one nameless: "Cube", then "Cube.001".
// Here a node with no `meta.name` shows its id (`nodeDisplayName`), so before this a director's new
// objects read `obj_mw43har3_z1tx` in the outliner. Every door that makes an object for the director
// asks this file, so the words and the numbering live in one place.
//
// THE WORDS are Blender's where Blender has the thing (the object each `bpy.ops.object.*_add` makes:
// Cube, Sphere, Point, Sun, Spot, Area, Camera, Armature, Empty). Three have no Blender twin and use
// the word the Add menu uses: Curve (Blender says BezierCurve or NurbsPath for two shapes this one
// path stands for), Transform (a wrapper over one child) and Ambient (a World setting there).
//
// THE NUMBERS. The first free number after the base, so a gap left by a delete is reused and a copy of
// `Cube.005` with `Cube.001` free is `Cube.001`, as `buildDuplicateNodesOps` has numbered since #1561.
// "Free" is across every name in the graph, as a Blender object's name is unique across its file.
//
// REF: src/app/sceneTreeWalk.ts (`nodeDisplayName`); src/core/dag/nodeName.ts (`ownName`).

import { ownName } from '../core/dag/nodeName';
import type { DagState } from '../core/dag/state';
import type { Node, NodeId } from '../core/dag/types';
import { chainSocketOfType } from './operatorChain';

const LIGHT_WORD: Record<string, string> = {
  Point: 'Point',
  Directional: 'Sun',
  Spot: 'Spot',
  Area: 'Area',
};

const DATA_WORD: Record<string, string> = {
  BoxData: 'Cube',
  SphereData: 'Sphere',
  CurveData: 'Curve',
  CameraData: 'Camera',
  Skeleton: 'Armature',
};

const FUSED_WORD: Record<string, string> = {
  Group: 'Empty',
  Null: 'Empty',
  Transform: 'Transform',
  AmbientLight: 'Ambient',
};

type Named = Pick<Node, 'type' | 'params'>;

/**
 * The word for an object of this type and data. Undefined for what is not an object the director
 * adds and names: a data block, a sidecar, a Material, a compute node.
 */
export function objectBaseName(object: Named, data?: Named): string | undefined {
  if (object.type !== 'Object') return FUSED_WORD[object.type];
  if (data?.type === 'LightData') {
    const kind = (data.params as { lightKind?: string } | undefined)?.lightKind;
    return LIGHT_WORD[kind ?? ''] ?? 'Light';
  }
  return (data && DATA_WORD[data.type]) ?? 'Object';
}

/** The word for a node already in the graph, reaching through its data's operator stack. */
export function objectBaseNameOf(state: DagState, id: NodeId): string | undefined {
  const node = state.nodes[id];
  if (!node) return undefined;
  const seen = new Set<NodeId>();
  const first = (binding: unknown) =>
    (Array.isArray(binding) ? binding[0] : binding) as { node?: NodeId } | undefined;
  let data = first(node.inputs.data)?.node;
  while (data && !seen.has(data)) {
    seen.add(data);
    const spine = chainSocketOfType(state.nodes[data]?.type ?? '');
    const below = spine ? first(state.nodes[data]?.inputs[spine])?.node : undefined;
    if (!below) break;
    data = below;
  }
  return objectBaseName(node, data ? state.nodes[data] : undefined);
}

/** Every name in the graph, as the taken set a new name is chosen against. */
export function takenObjectNames(state: DagState): Set<string> {
  const taken = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    const name = ownName(node);
    if (name) taken.add(name);
  }
  return taken;
}

/** `name` with Blender's numeric suffix replaced by the first free one (`Cube` → `Cube.001`). */
export function numberedName(name: string, taken: Set<string>): string {
  const base = name.replace(/\.\d{3,}$/, '');
  for (let i = 1; ; i++) {
    const candidate = `${base}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * A name for a light that comes aimed, and for its empty ("Spot.001", "Spot.001.aim"): the first
 * name of the word whose `.aim` is free too, so the empty always reads as the light's. Both taken.
 */
export function freshAimedNames(word: string, taken: Set<string>): { name: string; aim: string } {
  const probe = new Set(taken);
  for (;;) {
    const name = freshObjectName(word, probe);
    const aim = `${name}.aim`;
    if (!taken.has(aim)) {
      taken.add(name);
      taken.add(aim);
      return { name, aim };
    }
  }
}

/** `wanted` when it is free, else its first free number. Either way it is taken afterwards. */
export function freshObjectName(wanted: string, taken: Set<string>): string {
  if (taken.has(wanted)) return numberedName(wanted, taken);
  taken.add(wanted);
  return wanted;
}
