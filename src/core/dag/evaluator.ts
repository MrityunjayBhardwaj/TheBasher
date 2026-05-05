// Evaluator: walks the DAG lazily, caches by content hash, detects cycles.
//
// Three responsibilities (THESIS.md §10):
//   1. Resolve dependencies via topological sort (cycle detection: visited
//      set + depth limit 32).
//   2. Cache by content hash. Invalidate downstream on param/input change.
//   3. (P0 stub) Schedule by cost — `cheap`/`medium` run main thread inline;
//      `expensive` will route to a worker in P1+. The hook lives here so
//      callers don't need to change.
//
// Cache key: hash(nodeType, paramsHash, inputHashesSorted, time IFF !pure).
// Pure nodes do not include time in their hash; downstream invalidation is
// driven by upstream Time-source nodes when those land in P3.
//
// REF: THESIS.md §10, §51, vyapti V2 (purity), krama K2 step 6 (invalidate).

import { hashString, hashValue, type ContentHash } from './hash';
import { requireNodeType } from './registry';
import type { DagState } from './state';
import type { EvalCtx, NodeId, ResolvedInputs } from './types';

export interface EvalResult<T = unknown> {
  value: T;
  hash: ContentHash;
}

export interface EvaluatorCache {
  get(key: string): EvalResult | undefined;
  set(key: string, value: EvalResult): void;
  invalidate(predicate: (key: string) => boolean): void;
  clear(): void;
  size(): number;
}

export function createEvaluatorCache(): EvaluatorCache {
  const map = new Map<string, EvalResult>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    invalidate: (pred) => {
      for (const k of [...map.keys()]) if (pred(k)) map.delete(k);
    },
    clear: () => map.clear(),
    size: () => map.size,
  };
}

const DEPTH_LIMIT = 32;

export interface EvaluateOptions {
  cache?: EvaluatorCache;
  ctx?: EvalCtx;
  /** Output socket. Defaults to first declared output. */
  socket?: string;
}

const DEFAULT_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

interface Frame {
  id: NodeId;
  depth: number;
  visiting: boolean;
}

export function evaluate(
  state: DagState,
  nodeId: NodeId,
  options: EvaluateOptions = {},
): EvalResult {
  const cache = options.cache;
  const ctx = options.ctx ?? DEFAULT_CTX;
  // Per-evaluation memo so a single sub-graph isn't re-walked twice when
  // multiple downstream consumers share an upstream.
  const memo = new Map<NodeId, EvalResult>();
  const onStack = new Set<NodeId>();

  function evalNode(id: NodeId, depth: number): EvalResult {
    if (depth > DEPTH_LIMIT) {
      throw new Error(`Evaluator: depth limit ${DEPTH_LIMIT} exceeded at ${id}`);
    }
    if (onStack.has(id)) {
      throw new Error(`Evaluator: cycle detected at ${id}`);
    }
    const memoed = memo.get(id);
    if (memoed) return memoed;
    const node = state.nodes[id];
    if (!node) throw new Error(`Evaluator: node not found: ${id}`);
    const def = requireNodeType(node.type);

    onStack.add(id);

    // Resolve inputs.
    const resolved: ResolvedInputs = {};
    const inputHashes: Record<string, string | string[]> = {};
    for (const [socket, binding] of Object.entries(node.inputs)) {
      if (Array.isArray(binding)) {
        const values: unknown[] = [];
        const hashes: string[] = [];
        for (const ref of binding) {
          const sub = evalNode(ref.node, depth + 1);
          values.push(extractSocket(sub.value, ref.socket));
          hashes.push(`${ref.socket}:${sub.hash}`);
        }
        resolved[socket] = values;
        inputHashes[socket] = hashes;
      } else {
        const sub = evalNode(binding.node, depth + 1);
        resolved[socket] = extractSocket(sub.value, binding.socket);
        inputHashes[socket] = `${binding.socket}:${sub.hash}`;
      }
    }

    onStack.delete(id);

    const paramsHash = hashValue(node.params);
    const inputsHashStr = hashValue(inputHashes);
    const timePart = def.pure ? '' : `|t:${ctx.time.frame}.${ctx.time.seconds}`;
    const cacheKey = `${node.id}@${node.type}#${node.version}|p:${paramsHash}|i:${inputsHashStr}${timePart}`;

    if (cache) {
      const hit = cache.get(cacheKey);
      if (hit) {
        memo.set(id, hit);
        return hit;
      }
    }

    const out = def.evaluate(node.params, resolved, ctx);
    const hash = hashString(cacheKey);
    const result: EvalResult = { value: out, hash };
    if (cache) cache.set(cacheKey, result);
    memo.set(id, result);
    return result;
  }

  const result = evalNode(nodeId, 0);
  if (options.socket) {
    return {
      value: extractSocket(result.value, options.socket),
      hash: result.hash,
    };
  }
  return result;
}

function extractSocket(value: unknown, socket: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, socket)) return rec[socket];
  }
  // Single-output nodes may return the bare value rather than a record.
  return value;
}

/**
 * Topological order: dependencies first. Throws on cycle.
 * Used for batch operations (save, validate, full re-eval).
 */
export function topoSort(state: DagState, root: NodeId): NodeId[] {
  const order: NodeId[] = [];
  const visited = new Set<NodeId>();
  const stack: Frame[] = [{ id: root, depth: 0, visiting: false }];
  const onStack = new Set<NodeId>();

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.depth > DEPTH_LIMIT) {
      throw new Error(`topoSort: depth limit ${DEPTH_LIMIT} exceeded at ${frame.id}`);
    }
    if (frame.visiting) {
      stack.pop();
      onStack.delete(frame.id);
      if (!visited.has(frame.id)) {
        visited.add(frame.id);
        order.push(frame.id);
      }
      continue;
    }
    if (visited.has(frame.id)) {
      stack.pop();
      continue;
    }
    if (onStack.has(frame.id)) {
      throw new Error(`topoSort: cycle detected at ${frame.id}`);
    }
    onStack.add(frame.id);
    frame.visiting = true;
    const node = state.nodes[frame.id];
    if (!node) throw new Error(`topoSort: node not found: ${frame.id}`);
    for (const binding of Object.values(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      for (const ref of refs) {
        if (!visited.has(ref.node)) {
          stack.push({ id: ref.node, depth: frame.depth + 1, visiting: false });
        }
      }
    }
  }
  return order;
}
