// uiEvaluatorCache — the ONE evaluator cache every long-lived UI reader shares (#1315).
//
// Before this, each panel, gizmo and viewport follower held its own
// `useMemo(() => createEvaluatorCache(), [])`. Each was correct, but they shared nothing:
// selecting the AI-walk example's armature mounted a dozen readers, and each re-ran the
// walk's whole-clip retarget through its own empty cache (12–26 retargets, ~0.4–1.7 s per
// selection), even though the viewport had computed that exact result a frame earlier.
//
// SHARING IS EXACT, NOT APPROXIMATE. A pure node's key is its id, type, version, params hash
// and input hashes. An impure node's key also carries the time. Content the evaluator reads
// but cannot produce (generated motion) bumps the content epoch, which drops the whole cache
// (`evaluator.ts`). So two readers asking the same question get the same answer from one
// entry, and a changed graph asks a different question.
//
// WHO DOES NOT USE IT: a one-shot action (render, export, bake) creates its own cache and
// drops it when done, so its work does not sit in memory after the action. The diff
// overlay evaluates a forked state, which would fill this cache with entries no live
// reader asks for.
//
// BOUNDED: it lives all session, and every frame played adds one entry per impure node.
// Least-recently-used entries go first, and a read refreshes an entry, so whatever a
// per-frame reader asks for every frame stays.
//
// REF: src/core/dag/evaluator.ts (`createEvaluatorCache`, the content epoch); issue #1315.

import { createEvaluatorCache, type EvaluatorCache } from '../core/dag/evaluator';

/**
 * Entries kept. Measured 2026-09-30 on the AI-walk example (in-app, 600 played frames): the whole
 * graph held 24 entries and did not grow (nothing impure is evaluated per frame there). With one
 * time-driven chain added (Lag → Math → a driver on a mounted field) it grew 3 entries per frame,
 * so this bound is ~110 s of playback of such a chain at 60 fps before the oldest time-keyed
 * entries start to go. The per-component caches it replaced grew the same way, with no bound.
 */
export const UI_EVALUATOR_CACHE_MAX_ENTRIES = 20_000;

export const uiEvaluatorCache: EvaluatorCache = createEvaluatorCache({
  maxEntries: UI_EVALUATOR_CACHE_MAX_ENTRIES,
});
