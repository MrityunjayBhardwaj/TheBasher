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
// Cache key: `${node.id}@${node.type}#${node.version}|p:${paramsHash}|i:${inputsHash}${timePart}`
// — i.e. node.id AND version are part of the key, NOT just (type, params, inputs).
// Consequence: two STRUCTURALLY IDENTICAL nodes do NOT share a cache entry (the id
// differs), which is deliberate — it lets `invalidate()` target a single node by id
// prefix. `timePart` is appended only when `!pure`; pure nodes omit time so downstream
// invalidation is driven by upstream Time-source nodes when those land in P3.
// (An earlier version of this comment listed the key WITHOUT id/version — drift; the
// code below at `const cacheKey` is authoritative.)
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

// Params-hash memo (perf — H48 6th occurrence). `hashValue(node.params)` over a
// heavy imported asset (e.g. a glTF TransformClip with hundreds of per-bone tracks)
// measured ~35ms on the cicada, and the evaluator recomputes it on EVERY uncached
// evaluate — the cache key is built BEFORE the cache lookup (see below), so a warm
// cache does NOT avoid it. A read-side resolver that re-evaluates per inspector row
// then pays it 3–6×/commit → the ~458ms edit-lag a selected heavy-asset child shows.
//
// node.params is REPLACED on every setParam (ops.ts applySetParam → fresh
// `parsed.data`) and SHARED by reference for every unchanged node (structural
// sharing, V42 / ops.ts:278-282). So a WeakMap keyed by the params object identity
// is exact: a HIT means the params are the same object (byte-identical content); a
// changed param is a NEW object → miss → recompute for that one node only. This
// makes per-node param hashing O(changed) instead of O(scene). Module-level so it
// survives across evaluate() calls and cache instances (the cost is per params
// object, not per evaluation). GC'd with the params object (WeakMap).
const paramsHashMemo = new WeakMap<object, ContentHash>();
function hashParams(params: unknown): ContentHash {
  if (params === null || typeof params !== 'object') return hashValue(params);
  const memoed = paramsHashMemo.get(params as object);
  if (memoed !== undefined) return memoed;
  const h = hashValue(params);
  paramsHashMemo.set(params as object, h);
  return h;
}

// Optional dev-only instrumentation. Receives the self-time of each node's
// evaluate() body (0 for a cache hit) and whether the result came from cache.
// Inert unless armed by the frame profiler (production never sets it), so the
// eval hot path costs one null check.
type EvalPerfHook = (selfMs: number, cacheHit: boolean) => void;
let evalPerfHook: EvalPerfHook | null = null;
export function __setEvalPerfHook(hook: EvalPerfHook | null): void {
  evalPerfHook = hook;
}

export interface EvaluateOptions {
  cache?: EvaluatorCache;
  ctx?: EvalCtx;
  /** Output socket. Defaults to first declared output. */
  socket?: string;
  /** Per-node value injection: for every id present, the evaluator returns the mapped
   *  value INSTEAD of running that node's `evaluate` (its inputs are not walked). The
   *  Solver replay seam (statefulOps.ts) uses this to feed the previous-frame output
   *  into Prev_Frame leaves and the live input into SolverInput leaves each frame — the
   *  temporal-feedback mechanism the pure evaluator (one frame, no previous output)
   *  can't express. The injected value is folded into downstream input-hashes (so a
   *  changed injection invalidates correctly); the seam cooks with no shared cache, so
   *  there is no cross-frame poisoning. */
  overrides?: ReadonlyMap<NodeId, unknown>;
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
  const overrides = options.overrides;
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
    // Injected leaf (Solver replay seam): return the fed value directly, skipping the
    // node's own evaluate + input walk. Its hash reflects the value, so downstream
    // input-hashes differ when the injection changes (per-frame correctness).
    if (overrides && overrides.has(id)) {
      const value = overrides.get(id);
      const injected: EvalResult = { value, hash: hashValue(value) };
      memo.set(id, injected);
      return injected;
    }
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

    const paramsHash = hashParams(node.params);
    const inputsHashStr = hashValue(inputHashes);
    const timePart = def.pure ? '' : `|t:${ctx.time.frame}.${ctx.time.seconds}`;
    const cacheKey = `${node.id}@${node.type}#${node.version}|p:${paramsHash}|i:${inputsHashStr}${timePart}`;

    if (cache) {
      const hit = cache.get(cacheKey);
      if (hit) {
        if (evalPerfHook) evalPerfHook(0, true);
        memo.set(id, hit);
        return hit;
      }
    }

    const evalStart = evalPerfHook ? performance.now() : 0;
    const out = def.evaluate(node.params, resolved, ctx);
    if (evalPerfHook) evalPerfHook(performance.now() - evalStart, false);
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
