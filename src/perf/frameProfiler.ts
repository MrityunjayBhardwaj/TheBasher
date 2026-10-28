// Dev-only frame profiler. Decomposes the per-frame cost into three
// independently-attributable budgets so "the engine is slow" becomes a
// measured claim instead of an inference:
//
//   - eval:   self-time inside DAG node evaluate() calls (CPU graph eval).
//             Armed via the evaluator's perf hook; a node's evaluate() body
//             is timed, cache hits record 0ms but increment the hit count.
//   - react:  React render + commit for the scene subtree, measured by a
//             <Profiler onRender>. eval runs INSIDE that commit (the viewport
//             pulls evaluate() during render), so eval is a SUBSET of react —
//             reactOnly = react - eval is the reconciliation cost proper.
//   - gpu:    renderer.info proxy (triangles + draw calls) sampled every
//             frame, plus a best-effort WebGL2 timer-query (null in headless).
//
// Plus the total rAF interval — everything, including browser paint + idle —
// which is the ground-truth "did we hold the frame budget" signal.
//
// #1727 — and the same costs PER FRAME, by stage (`perFrame`): every stage's milliseconds are
// summed between two animation frames, so a playback run can say which stage grew. The stages
// overlap and do not add up to the frame: `eval` runs inside `react` and inside `world`.
//   - eval:        DAG evaluate() self-time (as above), wherever it ran.
//   - react:       the scene subtree's commits (as above).
//   - react:<id>:  another <PerfBoundary id> subtree's commits (the gizmo's, `react:gizmo`).
//   - world:       world and parent-world transform reads (`resolveWorldTransform`,
//                  `resolveParentWorldMatrix`), outermost call only.
//   - render:      CPU time inside `renderer.render` (every pass the frame draws). The GPU's own
//                  time is not in it.
//
// Lives outside src/nodes/** so the V2 purity lint does not apply (this is
// instrumentation, not a node). All collection no-ops unless a run is armed
// via start(); production never calls start(), so the hooks are inert.
//
// Exposed on window.__basher_perf (DEV only) so a headless harness can drive
// start/stop and read the summary without a React bridge.

import { __setEvalPerfHook } from '../core/dag/evaluator';

export interface BudgetSummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export interface PerfSummary {
  /** Total rAF interval per frame (ms) — the ground-truth frame budget. */
  frame: BudgetSummary;
  /** React render+commit per commit (ms). Only commit frames sample this. */
  react: BudgetSummary;
  /** reactOnly = react - eval, the reconciliation cost minus graph eval. */
  reactOnly: BudgetSummary;
  /** DAG eval self-time per commit (ms). */
  eval: BudgetSummary;
  /** Best-effort GPU time via WebGL2 timer query (ms); empty if unsupported. */
  gpu: BudgetSummary;
  /** Triangles submitted last render (steady-state scene load). */
  triangles: number;
  /** Draw calls last render. */
  drawCalls: number;
  /** Cache hit / miss totals across the run (eval cache efficiency). */
  cacheHits: number;
  cacheMisses: number;
  /** Eval-call count across the run (node-evaluations, hits + misses). */
  evalCalls: number;
  /** How many commits the scene subtree made during the run (its re-render frequency). Other
   *  profiled subtrees (the gizmo's) are not counted here: they are in `commitsPerFrame` and their
   *  own `react:<id>` stage. */
  commits: number;
  /** #1727 — milliseconds per animation frame, by stage (see the header). A stage nothing
   *  recorded during the run is absent. */
  perFrame: Record<string, BudgetSummary>;
  /** #1727 — React commits per animation frame, every profiled subtree. */
  commitsPerFrame: BudgetSummary;
  /** #1731 — commits of each profiled subtree other than the scene, by id, over the run (how
   *  often the gizmo re-rendered), with the frames the run counted. */
  subtreeCommits: Record<string, number>;
  frames: number;
}

const EMPTY: BudgetSummary = { count: 0, p50: 0, p95: 0, max: 0, mean: 0 };

function summarize(samples: number[]): BudgetSummary {
  if (samples.length === 0) return { ...EMPTY };
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

class FrameProfiler {
  private armed = false;
  private rafId = 0;
  private lastFrameTs = 0;

  // Per-run sample arrays.
  private frameIntervals: number[] = [];
  private reactSamples: number[] = [];
  private reactOnlySamples: number[] = [];
  private evalSamples: number[] = [];
  private gpuSamples: number[] = [];

  // Per-commit accumulators (reset when the commit is recorded).
  private evalMsThisCommit = 0;
  private evalCallsThisCommit = 0;

  // Run totals.
  private cacheHits = 0;
  private cacheMisses = 0;
  private evalCalls = 0;
  private commits = 0;
  private subtreeCommits = new Map<string, number>();
  private lastTriangles = 0;
  private lastDrawCalls = 0;

  // #1727 — per-frame stage totals: accumulated between two ticks, pushed on the tick.
  private stageThisFrame = new Map<string, number>();
  private stageSamples = new Map<string, number[]>();
  private commitsThisFrame = 0;
  private commitSamples: number[] = [];
  private stageDepth = new Map<string, number>();

  /** Add `ms` to `stage` for this frame. */
  recordStage(stage: string, ms: number): void {
    if (!this.armed) return;
    this.stageThisFrame.set(stage, (this.stageThisFrame.get(stage) ?? 0) + ms);
  }

  /** Run `fn`, timing it as `stage` when a run is armed. Re-entrant calls of the same stage are
   *  counted once, in the outermost call. Unarmed it is just `fn()`. */
  measure<T>(stage: string, fn: () => T): T {
    if (!this.armed) return fn();
    const depth = this.stageDepth.get(stage) ?? 0;
    if (depth > 0) return fn();
    this.stageDepth.set(stage, 1);
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.stageDepth.set(stage, 0);
      this.recordStage(stage, performance.now() - t0);
    }
  }

  /** A commit of a profiled subtree other than the scene (`<PerfBoundary id>`). */
  recordSubtreeCommit(id: string, actualMs: number): void {
    if (!this.armed) return;
    this.commitsThisFrame += 1;
    this.subtreeCommits.set(id, (this.subtreeCommits.get(id) ?? 0) + 1);
    this.recordStage(`react:${id}`, actualMs);
  }

  private flushFrame(): void {
    for (const [stage, ms] of this.stageThisFrame) {
      let samples = this.stageSamples.get(stage);
      if (!samples) {
        // A stage first seen now read 0 on every frame before it.
        samples = new Array<number>(this.commitSamples.length).fill(0);
        this.stageSamples.set(stage, samples);
      }
      samples.push(ms);
    }
    for (const [stage, samples] of this.stageSamples) {
      if (!this.stageThisFrame.has(stage)) samples.push(0);
    }
    this.commitSamples.push(this.commitsThisFrame);
    this.stageThisFrame = new Map();
    this.commitsThisFrame = 0;
  }

  /** Called by the evaluator perf hook for every node evaluation. */
  recordEval(selfMs: number, hit: boolean): void {
    if (!this.armed) return;
    this.evalMsThisCommit += selfMs;
    this.evalCallsThisCommit += 1;
    this.evalCalls += 1;
    if (hit) this.cacheHits += 1;
    else this.cacheMisses += 1;
    this.recordStage('eval', selfMs);
  }

  /** Called by the React <Profiler onRender> for the scene subtree. */
  recordReactCommit(actualMs: number): void {
    if (!this.armed) return;
    this.commits += 1;
    this.commitsThisFrame += 1;
    this.recordStage('react', actualMs);
    this.reactSamples.push(actualMs);
    // eval ran inside this commit; subtract it to isolate reconciliation.
    const evalMs = this.evalMsThisCommit;
    this.evalSamples.push(evalMs);
    this.reactOnlySamples.push(Math.max(0, actualMs - evalMs));
    this.evalMsThisCommit = 0;
    this.evalCallsThisCommit = 0;
  }

  /** Called every frame by the in-canvas GPU probe. */
  recordGpu(triangles: number, drawCalls: number, gpuMs: number | null): void {
    if (!this.armed) return;
    this.lastTriangles = triangles;
    this.lastDrawCalls = drawCalls;
    if (gpuMs !== null && gpuMs >= 0) this.gpuSamples.push(gpuMs);
  }

  /** Begin a measurement run: clears samples, starts the rAF interval timer. */
  start(): void {
    this.armed = true;
    this.frameIntervals = [];
    this.reactSamples = [];
    this.reactOnlySamples = [];
    this.evalSamples = [];
    this.gpuSamples = [];
    this.evalMsThisCommit = 0;
    this.evalCallsThisCommit = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.evalCalls = 0;
    this.commits = 0;
    this.subtreeCommits = new Map();
    this.stageThisFrame = new Map();
    this.stageSamples = new Map();
    this.commitsThisFrame = 0;
    this.commitSamples = [];
    this.stageDepth = new Map();
    this.lastFrameTs = performance.now();
    const tick = () => {
      const now = performance.now();
      this.flushFrame();
      this.frameIntervals.push(now - this.lastFrameTs);
      this.lastFrameTs = now;
      if (this.armed) this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** End the run and return the computed summary. */
  stop(): PerfSummary {
    this.armed = false;
    cancelAnimationFrame(this.rafId);
    return this.summary();
  }

  summary(): PerfSummary {
    // Drop the first few warm-up intervals (mount + first paint spike).
    const warm = this.frameIntervals.slice(Math.min(5, this.frameIntervals.length));
    // The per-frame series drop the same warm-up frames, so they line up with `frame`.
    const skip = (xs: number[]) => xs.slice(Math.min(5, xs.length));
    const perFrame: Record<string, BudgetSummary> = {};
    for (const [stage, samples] of this.stageSamples) perFrame[stage] = summarize(skip(samples));
    return {
      frame: summarize(warm),
      react: summarize(this.reactSamples),
      reactOnly: summarize(this.reactOnlySamples),
      eval: summarize(this.evalSamples),
      gpu: summarize(this.gpuSamples),
      triangles: this.lastTriangles,
      drawCalls: this.lastDrawCalls,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      evalCalls: this.evalCalls,
      commits: this.commits,
      perFrame,
      commitsPerFrame: summarize(skip(this.commitSamples)),
      subtreeCommits: Object.fromEntries(this.subtreeCommits),
      frames: this.commitSamples.length,
    };
  }

  isArmed(): boolean {
    return this.armed;
  }
}

export const frameProfiler = new FrameProfiler();

/** #1727 — time `fn` as `stage` of the current frame while a run is armed; otherwise just
 *  `fn()`. For app code whose cost a playback table reports (the world-transform reads). */
export function measureStage<T>(stage: string, fn: () => T): T {
  return frameProfiler.measure(stage, fn);
}

let installed = false;

/**
 * Wire the evaluator hook + the window seam. Idempotent. DEV-only — calling
 * this in production is a no-op so the eval hot path stays clean.
 */
export function installFrameProfiler(): void {
  if (installed || !import.meta.env.DEV) return;
  installed = true;
  __setEvalPerfHook((selfMs, hit) => frameProfiler.recordEval(selfMs, hit));
  (window as unknown as Record<string, unknown>).__basher_perf = {
    start: () => frameProfiler.start(),
    stop: () => frameProfiler.stop(),
    summary: () => frameProfiler.summary(),
    isArmed: () => frameProfiler.isArmed(),
  };
}
