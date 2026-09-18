import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
export function appShell(): Plugin {
  let publicDir = '', root = '';
  return {
    name: 'termai-app-shell',
    configResolved(config) { publicDir = config.publicDir; root = config.root; },
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter(name => !/\.(?:gz|br|map)$/.test(name)).sort();
      const hash = createHash('sha256');
      for (const name of files) {
        const output = bundle[name];
        hash.update(name).update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const name of ['sw.js', 'icon.svg', 'manifest.webmanifest']) hash.update(readFileSync(path.join(publicDir, name)));
      hash.update(readFileSync(path.join(root, 'index.html')));
      const assets = ['', 'icon.svg', 'manifest.webmanifest', ...files.filter(name => name.startsWith('assets/'))];
      const source = readFileSync(path.join(publicDir, 'sw.js'), 'utf8')
        .replace('__TERMAI_BUILD__', hash.digest('hex').slice(0, 20))
        .replace(/\/\*__TERMAI_ASSETS__\*\/\s*\[[^\]]*\]/, JSON.stringify(assets));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
