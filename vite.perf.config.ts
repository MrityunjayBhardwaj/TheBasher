// #1727 — the perf build: the production bundle (minified, React's production build) with the dev
// seams the perf specs drive still on, so a table taken here leaves out React's development-only
// overhead and nothing else.
//
//   - `import.meta.env.DEV` is defined true, so `window.__basher_*` (boot.ts) and the frame
//     profiler install. Every other dev-only branch in `src/` runs too; React itself does not
//     change, since it picks its build from NODE_ENV, which `vite build` sets to production.
//   - `react-dom` and `react-reconciler` resolve to React's PROFILING builds — the production
//     builds with <Profiler> callbacks kept, which the plain production builds drop, so the
//     `react` stages still read. The viewport's subtrees (the scene, the gizmo) are rendered by
//     @react-three/fiber's own reconciler, not react-dom, so both are needed.
//
// Used by `npm run perf:prod` (playwright.perf-prod.config.ts). Never deployed: it builds into
// dist/perf.
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(
  base,
  defineConfig({
    define: { 'import.meta.env.DEV': 'true' },
    resolve: {
      alias: [
        { find: /^react-dom$/, replacement: 'react-dom/profiling' },
        {
          find: /^react-reconciler$/,
          replacement: 'react-reconciler/cjs/react-reconciler.profiling.min.js',
        },
      ],
    },
    build: { outDir: 'dist/perf', sourcemap: false },
    preview: { port: 5187, strictPort: true },
  }),
);
