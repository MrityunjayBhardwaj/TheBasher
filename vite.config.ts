import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { blenderMockPlugin } from './tools/vite/vite-plugin-blender-mock';

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
  },
  preview: {
    port: 5181,
    strictPort: true,
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
