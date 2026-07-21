// idRefSweep — the ONE walker over the id-reference universe (#421, #424).
//
// Basher's graph has two halves. Edges carry the render tree, and `removeNode`
// already guards those: it refuses while a node is "still consumed by" another
// (ops.ts:143), so an edge can never dangle. The OTHER half travels in params —
// the V57 edge-less sidecars (keyframe channels, constraints, drivers, NLA strips)
// name their subject by id, not by wire. That half has never had a guard, so every
// delete could silently strand it.
//
// The stated intent at the op layer is already the right one — "removeNode does not
// silently dangle" (ops.ts:142). This module is that same invariant applied to the
// half the edge walk cannot see. It is deliberately a PURE function of
// (nodes, removedIds) → ops, with no store/registry side effects, so both delete
// authorities (the UI's `buildDeleteNodesOps` and the agent's `mutator.deleteNode`)
// can consume it and cannot drift — the divergence #424 is about.
//
// What each node type declares lives on `NodeDefinition.idRefs` (types.ts), NOT
// hardcoded here: a sweep with a hand-maintained field list is exactly the thing
// #421 warns goes stale at the next node kind.
//
// REF: src/core/dag/types.ts (the `idRefs` declaration + role/owns semantics);
//      src/app/sceneNodeActions.ts (the UI authority); issues #421, #424, #431.

import { getNodeType } from './registry';
import type { NodeId, Op } from './types';

/** Minimal node shape this walker reads (a DagState node subset). */
interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
}

function atPath(params: unknown, path: string): unknown {
  let cur: unknown = params;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The node ids a single declared ref currently points at (0, 1 or many). */
export function refIdsAt(params: unknown, path: string, shape: string): string[] {
  const raw = atPath(params, path);
  if (shape === 'idList') {
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && !!v) : [];
  }
  if (shape === 'ref') {
    const node = (raw as { node?: unknown } | undefined)?.node;
    return typeof node === 'string' && node ? [node] : [];
  }
  // 'id' and 'nested' both resolve to a plain string at `path`.
  return typeof raw === 'string' && raw ? [raw] : [];
}

/**
 * Everything deleting `seedIds` implies for the id-reference universe.
 *
 * `remove` is the seeds plus every node transitively pulled in — the 'subject'
 * referrers that are owned BY a removed node (a channel whose target is gone) and
 * the `owns` referents a removed node owned (a Track's strips). Computed to a
 * FIXPOINT: deleting an object removes the strips placed on it, and removing a strip
 * must in turn drop it from its Track's list. One pass is not enough.
 *
 * `ops` clears the 'argument' refs of nodes that SURVIVE — emitted only after the
 * removal set is final, so a node that is itself being removed never gets a pointless
 * (and invalid, since the node is gone) setParam.
 */
export function idRefSweep(
  nodes: Readonly<Record<string, NodeLike>>,
  seedIds: readonly NodeId[],
): { remove: Set<NodeId>; ops: Op[] } {
  const remove = new Set<NodeId>(seedIds);

  // 1. Fixpoint over both directions of ownership.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of Object.values(nodes)) {
      const refs = getNodeType(node.type)?.idRefs;
      if (!refs) continue;
      const selfRemoved = remove.has(node.id);
      for (const ref of refs) {
        const targets = refIdsAt(node.params, ref.path, ref.shape);
        // Downward: this node is going, so take what it owns with it.
        if (selfRemoved && ref.owns) {
          for (const t of targets) {
            if (nodes[t] && !remove.has(t)) {
              remove.add(t);
              changed = true;
            }
          }
          continue;
        }
        // Upward: the referent is going, and this node is owned by it.
        if (!selfRemoved && ref.role === 'subject' && targets.some((t) => remove.has(t))) {
          remove.add(node.id);
          changed = true;
        }
      }
    }
  }

  // 2. Clear dangling 'argument' refs on the survivors.
  const ops: Op[] = [];
  for (const node of Object.values(nodes)) {
    if (remove.has(node.id)) continue;
    const refs = getNodeType(node.type)?.idRefs;
    if (!refs) continue;
    for (const ref of refs) {
      if (ref.role !== 'argument') continue;
      const targets = refIdsAt(node.params, ref.path, ref.shape);
      if (!targets.some((t) => remove.has(t))) continue;
      if (ref.shape === 'idList') {
        // Drop the removed members, keep the rest in order.
        ops.push({
          type: 'setParam',
          nodeId: node.id,
          paramPath: ref.path,
          value: targets.filter((t) => !remove.has(t)),
        });
      } else if (ref.shape === 'ref') {
        // A whole `{ node }` param — the schema has it `.optional()`, so absent
        // is the natural empty.
        ops.push({ type: 'setParam', nodeId: node.id, paramPath: ref.path, value: undefined });
      } else {
        // 'id' and 'nested': clear the STRING in place. For 'nested' this
        // deliberately keeps the sibling fields (`sourceTransform.channel`,
        // `sourceSpare.key`) — dropping the whole object would silently switch a
        // driver back to its wired `in` road.
        ops.push({ type: 'setParam', nodeId: node.id, paramPath: ref.path, value: '' });
      }
    }
  }

  return { remove, ops };
}

/**
 * Inverse index of the id-reference universe: for each referenced node id, the ids
 * of the nodes naming it. Built once per traversal so an "who points at me?" walk is
 * O(1) per step instead of O(nodes) — the same reason `expandClosure` pre-builds its
 * consumer index for edges.
 */
export function buildIdRefIndex(nodes: Readonly<Record<string, NodeLike>>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    const refs = getNodeType(node.type)?.idRefs;
    if (!refs) continue;
    for (const ref of refs) {
      for (const target of refIdsAt(node.params, ref.path, ref.shape)) {
        const list = index.get(target);
        if (list) {
          if (!list.includes(node.id)) list.push(node.id);
        } else {
          index.set(target, [node.id]);
        }
      }
    }
  }
  return index;
}

/** The node ids `node` names through its declared refs (the outward direction). */
export function idRefsOutOf(node: NodeLike): string[] {
  const out: string[] = [];
  for (const ref of getNodeType(node.type)?.idRefs ?? []) {
    for (const target of refIdsAt(node.params, ref.path, ref.shape)) {
      if (!out.includes(target)) out.push(target);
    }
  }
  return out;
}

/**
 * The nodes OWNED BY any node in `ids` through a SUBJECT idRef — a keyframe channel
 * whose target is being duplicated, a constraint on it, a driver of it, a strip
 * placed on it (#434). This is the copy-direction twin of the delete sweep's upward
 * walk: the exact set delete REMOVES when a subject's referent goes, reused to decide
 * what a duplicate must CLONE alongside its subtree. Argument-only referrers are
 * excluded — a constraint that merely AIMS AT a duplicated object belongs to a
 * different object and is not copied.
 */
export function subjectReferrersInto<T extends NodeLike>(
  nodes: Readonly<Record<string, T>>,
  ids: ReadonlySet<string>,
): T[] {
  const out: T[] = [];
  for (const node of Object.values(nodes)) {
    if (ids.has(node.id)) continue; // a subtree node is cloned by the main walk, not here
    const refs = getNodeType(node.type)?.idRefs;
    if (!refs) continue;
    const owned = refs.some(
      (r) => r.role === 'subject' && refIdsAt(node.params, r.path, r.shape).some((t) => ids.has(t)),
    );
    if (owned) out.push(node);
  }
  return out;
}

function setAtPath(obj: unknown, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]] as Record<string, unknown>;
  cur[segs[segs.length - 1]] = value;
}

/**
 * A deep copy of `node`'s params with every declared id rewritten by `remap`. The
 * copy-direction counterpart to the sweep's clear: where the sweep empties a dangling
 * ref, this REPOINTS it. Callers pass `id => idMap.get(id) ?? id`, so a subject ref
 * into the cloned subtree lands on the clone while an argument ref to a SHARED node (a
 * followed curve, a played Action) is left pointing at the original — the exact rule
 * the edge rewire applies to wired inputs. Only refs that currently hold a value are
 * touched, and a nested id is rewritten in place so its siblings (`sourceTransform`'s
 * `channel`, `sourceSpare`'s `key`) survive.
 */
export function remapIdRefs(node: NodeLike, remap: (id: string) => string): unknown {
  const params = structuredClone(node.params);
  const refs = getNodeType(node.type)?.idRefs;
  if (!refs) return params;
  for (const ref of refs) {
    const cur = refIdsAt(params, ref.path, ref.shape);
    if (cur.length === 0) continue;
    if (ref.shape === 'idList') {
      setAtPath(params, ref.path, cur.map(remap));
    } else if (ref.shape === 'ref') {
      // `<path>` is the `{ node }` object; rewrite `.node` so any siblings survive.
      setAtPath(params, `${ref.path}.node`, remap(cur[0]));
    } else {
      // 'id' — a plain string at `path`; 'nested' — a string already ending in `.node`.
      setAtPath(params, ref.path, remap(cur[0]));
    }
  }
  return params;
}
