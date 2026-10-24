import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const threeWebgpu = path.resolve(root, 'node_modules/three/build/three.webgpu.js');

// Remap bare `three` (used by examples/jsm) to the WebGPU build so one module graph.
export default defineConfig({
  // Project Pages URL is https://stellanjoh2.github.io/TankU/
  base: '/TankU/',
  resolve: {
    alias: [
      { find: /^three$/, replacement: threeWebgpu },
    ],
    dedupe: ['three'],
  },
  optimizeDeps: {
    // Force re-bundle against the WebGPU entry (avoids stale classic three cache).
    include: ['three', 'three/webgpu'],
  },
});
