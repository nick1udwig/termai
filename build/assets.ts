import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

export function externalWasm(): Plugin {
  return {
    name: 'termai-external-wasm', enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith('/ghostty-web/dist/ghostty-web.js')) return;
      const payload = /"data:application\/wasm;base64,[A-Za-z0-9+/=]+"/g;
      if ([...code.matchAll(payload)].length !== 1) throw new Error('Review Ghostty WASM packaging before updating ghostty-web.');
      return { code: "import termaiWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';\n" + code.replace(payload, 'termaiWasmUrl'), map: null };
    },
  };
}
export function compressedAssets(): Plugin {
  return {
    name: 'termai-compressed-assets',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (!/\.(?:js|css|wasm|svg)$/.test(output.fileName)) continue;
        const source = output.type === 'chunk' ? output.code : output.source;
        const bytes = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source);
        if (bytes.length < 1024) continue;
        for (const [suffix, compress] of [['gz', gzipSync], ['br', brotliCompressSync]] as const) {
          const compressed = compress(bytes);
          if (compressed.length < bytes.length) this.emitFile({ type: 'asset', fileName: `${output.fileName}.${suffix}`, source: compressed });
        }
      }
    },
  };
}
