import { defineConfig } from 'vite';
import { externalWasm, compressedAssets } from './build/assets.ts';
export default defineConfig({
  base: './', build: { target: 'es2022' },
  optimizeDeps: { exclude: ['ghostty-web'] },
  plugins: [externalWasm(), compressedAssets()],
});
