import { defineConfig } from 'vite';
import { externalWasm, compressedAssets, appShell, terminalPreloads } from './build/assets.ts';
export default defineConfig({
  base: './', build: { target: 'es2022', rolldownOptions: { input: { app: 'index.html', terminal: 'terminal.html' } } },
  optimizeDeps: { exclude: ['ghostty-web'] },
  plugins: [externalWasm(), terminalPreloads(), compressedAssets(), appShell()],
});
