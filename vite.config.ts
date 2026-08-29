import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { blenderMockPlugin } from './tools/vite/vite-plugin-blender-mock';
import { TRIPO_PROXY_ROUTES, rewriteTripoProxyPath } from './src/core/modelgen/tripoProxy';

/**
 * Tripo answers no CORS preflight, so a page cannot call its API host directly
 * (issue #804). These routes give the page a same-origin path instead.
 *
 * The table is imported rather than restated: the client builds its base URL
 * from the same routes, and a second copy of a host here would drift into a 404
 * that reads exactly like the service being down.
 *
 * 🔑 The generated model's DOWNLOAD is deliberately absent — it comes from a
 * different host that already sends `access-control-allow-origin: *`, so it is
 * reachable from a page as-is. Routing 40+ MB of mesh through the dev server
 * would buy nothing and would invent a production dependency.
 *
 * 🔴 Dev and preview only. A production build served by a static host has no
 * such route; where the call originates in production is the open half of #804.
 */
const tripoProxy: Record<string, ProxyOptions> = Object.fromEntries(
  TRIPO_PROXY_ROUTES.map((route) => [
    route.path,
    {
      target: route.target,
      changeOrigin: true,
      rewrite: rewriteTripoProxyPath,
    },
  ]),
);

export default defineConfig({
  plugins: [react(), blenderMockPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Constrain dep-scan to our entry. Without this, the GPL blockbench/
  // reference checkout gets crawled (it has an index.html with broken
  // imports) and dev server boot fails.
  optimizeDeps: {
    entries: ['index.html', 'src/**/*.{ts,tsx}'],
  },
  server: {
    // 5173 collides with another local project on this dev box; pin to 5180
    // and refuse to fall through. Playwright config matches.
    port: 5180,
    strictPort: true,
    fs: {
      deny: ['blockbench/**'],
    },
    proxy: tripoProxy,
  },
  preview: {
    port: 5181,
    strictPort: true,
    proxy: tripoProxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
});
