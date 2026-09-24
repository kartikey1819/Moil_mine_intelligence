import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Multi-page app: the dashboard and the model lab. The live exploration scripts are classic
// (non-module) scripts shared with ml/verify_runtime.js, so they live in public/js and are served as-is.
// /api is proxied to the Node API server (server/index.mjs, port 8710).
export default defineConfig({
  server: { port: 5173, open: !process.env.NO_OPEN, proxy: { '/api': { target: 'http://localhost:8710', changeOrigin: true, timeout: 180000, proxyTimeout: 180000 } } },
  optimizeDeps: { include: ['echarts', 'leaflet', 'three', 'three/addons/controls/OrbitControls.js'] },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        modelLab: resolve(import.meta.dirname, 'model-lab.html'),
      },
    },
  },
});
