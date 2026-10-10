import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
let packaged: Record<string, unknown> = {};
try { packaged = JSON.parse(readFileSync(new URL('release.json', root), 'utf8')); }
catch (error: any) { if (error.code !== 'ENOENT') throw error; }
export const release = { version: pkg.version as string, commit: packaged.commit || null, platform: process.platform, arch: process.arch, node: process.version, packaged: !!packaged.commit };
export const applicationRoot = fileURLToPath(root);
