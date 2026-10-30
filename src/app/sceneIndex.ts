// sceneIndex — who holds each node, and what animates it, read off the node table ONCE per
// graph (#1729).
//
// WHY THIS EXISTS. A world-transform read (`resolveWorldTransform`, `resolveParentWorldMatrix`)
// used to find its node by searching the scene from the top, and at every node it passed it
// folded that node's channels — `layeredChannelValues` and `driverChannelValuesForTarget`, each
// a scan of the whole node table. N nodes visited × an N-node scan each: the read cost the square
// of the scene's size (2.3 ms at 214 nodes, 10.2 ms at 426 on the alley scene), and the selected
// object's gizmo makes it on every playhead change.
//
// This index answers the same questions by lookup. It is built in one pass and kept per node
// table: the graph is immutable, so an edit yields a new `state.nodes` record and a new index,
// and a playhead change — which edits nothing — reuses it (the `subjectClock` owners cache works
// the same way).
//
// What it holds:
//   - `parentsOf(id)`: every scene-graph holder of `id` (the sockets `sceneHierarchy` names), the
//     Scene included, one entry per holding. A read can then walk UP from its node to the scene
//     instead of searching down, so it costs the node's depth, not the scene's size.
//   - `layeredNodesFor(id)`: the part of the node table `layeredChannelValues(_, id)` reads —
//     `id`'s channels, the strips placed on `id`, their actions, and every track (a track's
//     mute/solo/order is a global input to every fold). Folding against it gives exactly what
//     folding against the whole table gives, at the size of what animates `id`.
//   - `hasDriversOn(id)`: whether any ParamDriver names `id`, so the driver fold — which scans
//     the table itself — is only entered for a node something drives.
//
// It does not change `layeredChannels.ts` or `paramDrivers.ts`: the folds run as they always
// have, on less table.
//
// REF: issue #1729; src/app/sceneHierarchy.ts (the holder relation); src/app/subjectClock.ts
//      (`ownersOf`, the same per-table cache).

import type { DagState } from '../core/dag/state';
import { isKeyframeChannelNode } from './animate/paramAnimationState';
import { hierarchyChildIds } from './sceneHierarchy';

type Nodes = DagState['nodes'];
type Node = Nodes[string];

export interface SceneIndex {
  /** Every node holding `id` as a scene-graph child, in node-table order, one entry per holding
   *  (a Group listing it twice appears twice). The Scene counts as a holder. */
  parentsOf(id: string): readonly string[];
  /** The nodes `layeredChannelValues(_, id)` reads, as a node table. */
  layeredNodesFor(id: string): Nodes;
  /** True when a ParamDriver names `id` as its target. */
  hasDriversOn(id: string): boolean;
}

const EMPTY: readonly string[] = [];
const indexCache = new WeakMap<Nodes, SceneIndex>();

/** The index of `nodes`, built on first use and kept while the table is unchanged. */
export function sceneIndexOf(nodes: Nodes): SceneIndex {
  const hit = indexCache.get(nodes);
  if (hit) return hit;
  const index = buildSceneIndex(nodes);
  indexCache.set(nodes, index);
  return index;
}

function buildSceneIndex(nodes: Nodes): SceneIndex {
  const parents = new Map<string, string[]>();
  const channels = new Map<string, Node[]>();
  const strips = new Map<string, Node[]>();
  const tracks: Node[] = [];
  const driven = new Set<string>();
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const node of Object.values(nodes)) {
    for (const child of hierarchyChildIds(node)) push(parents, child, node.id);
    const target = (node.params as { target?: unknown } | undefined)?.target;
    if (node.type === 'Track') tracks.push(node);
    if (typeof target !== 'string' || !target) continue;
    // The same predicates the folds apply (`directChannelNodesForTarget`, the strip and driver
    // scans), or wider: a node the fold then rejects costs a lookup, a node left out would be lost.
    if (isKeyframeChannelNode(node)) push(channels, target, node);
    else if (node.type === 'Strip') push(strips, target, node);
    else if (node.type === 'ParamDriver') driven.add(target);
  }

  const layered = new Map<string, Nodes>();
  return {
    parentsOf: (id) => parents.get(id) ?? EMPTY,
    hasDriversOn: (id) => driven.has(id),
    layeredNodesFor(id) {
      const known = layered.get(id);
      if (known) return known;
      const table: Record<string, Node> = {};
      // Channels first and in table order: `directChannelNodesForTarget` returns them in the
      // order it meets them, and the fold is stable over equal `order`.
      for (const node of channels.get(id) ?? []) table[node.id] = node;
      for (const strip of strips.get(id) ?? []) {
        table[strip.id] = strip;
        const action = (strip.params as { action?: unknown }).action;
        if (typeof action === 'string' && nodes[action]) table[action] = nodes[action];
      }
      for (const track of tracks) table[track.id] = track;
      layered.set(id, table);
      return table;
    },
  };
}
