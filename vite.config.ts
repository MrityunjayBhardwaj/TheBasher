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
    port: 5173,
    strictPort: false,
    fs: {
      deny: ['blockbench/**'],
    },
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
