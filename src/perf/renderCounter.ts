// DEV-only render-count instrument (H48 4th-occurrence / B13 gate).
//
// Counts React renders per labelled component so an e2e can prove the H48 goal
// directly: "edit node A → renderer B's render count does NOT move." A render
// count is the RIGHT witness here (not gl.info, not the false-witness
// __basher_evaluate seam): it measures the exact thing the fix changes — whether
// an unrelated edit re-renders a heavy asset's subtree — and it is independent of
// GPU and of asset size, so the gate runs headless / in CI on a tiny fixture.
//
// Inert in production: the bump short-circuits on `import.meta.env.DEV`, so the
// hot path costs one boolean check and no window churn ships.
//
// REF: src/viewport/SceneFromDAG.tsx GltfAssetR (the instrumented renderer),
//      tests/e2e/perf-render-count.spec.ts (the gate), [[H48]] [[B13]].

const counts = new Map<string, number>();

let exposed = false;
function expose(): void {
  if (exposed) return;
  exposed = true;
  const w = window as unknown as Record<string, unknown>;
  // Snapshot getter — the e2e reads a plain object across the Playwright boundary.
  w.__basher_render_counts = () => Object.fromEntries(counts) as Record<string, number>;
}

/** Increment the render count for `label`. DEV-only; a no-op in production. */
export function bumpRenderCount(label: string): void {
  if (!import.meta.env.DEV) return;
  counts.set(label, (counts.get(label) ?? 0) + 1);
  expose();
}
