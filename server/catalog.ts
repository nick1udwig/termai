import { readdir, readFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Catalog, Flag } from '../src/protocol.ts';
import { tokens } from './repair.ts';
export { historySources as initialHistory } from './history.ts';
const exec = promisify(execFile);
const flagCache = new Map<string, { stamp: number; flags: Flag[] }>();

export async function executableNames(): Promise<string[]> {
  const names = new Set(['cd', 'pwd', 'echo', 'printf', 'export', 'alias', 'history', 'source', 'jobs', 'fg', 'bg', 'type', 'exit']);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(entries.map(async name => {
      try { await access(path.join(dir, name), constants.X_OK); if ((await stat(path.join(dir, name))).isFile()) names.add(name); } catch { /* broken links */ }
    }));
  }
  return [...names].sort();
}
export async function pathsIn(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  const skip = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', '.cache']);
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  // Immediate entries take precedence over descendants, even in large projects.
  for (const entry of entries) paths.push(entry.name + (entry.isDirectory() ? '/' : ''));
  for (const dir of entries) {
    if (paths.length >= 4000) break;
    if (!dir.isDirectory() || skip.has(dir.name) || dir.name.startsWith('.')) continue;
    const children = await readdir(path.join(cwd, dir.name), { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (paths.length >= 4000) break;
      paths.push(path.join(dir.name, child.name) + (child.isDirectory() ? '/' : ''));
    }
  }
  return paths.slice(0, 10000);
}
const AST_SCRIPT = `import ast,json,sys
try:
 tree=ast.parse(open(sys.argv[1],encoding='utf-8').read())
 flags=[]
 for node in ast.walk(tree):
  if not isinstance(node,ast.Call): continue
  name=getattr(node.func,'attr','')
  if name not in ('add_argument','option'): continue
  options={k.arg:k.value.value for k in node.keywords if isinstance(k.value,ast.Constant)}
  takes=options.get('action','') not in ('store_true','store_false','count','help','version') and options.get('is_flag') != True and options.get('nargs') != 0
  for arg in node.args:
   if isinstance(arg,ast.Constant) and isinstance(arg.value,str) and arg.value.startswith('-'):
    flags.append({'name':arg.value,'takesValue':takes})
 print(json.dumps(flags))
except (SyntaxError,UnicodeError,OSError): print('[]')
`;
/** Static Python inspection does not import or execute the user's script. */
export async function describe(commandLine: string, cwd: string): Promise<Flag[] | undefined> {
  const args = tokens(commandLine).map(t => t.value);
  if (!/^(python|python3)$/.test(args[0]) || !args[1]?.endsWith('.py')) return undefined;
  const file = path.resolve(cwd, args[1]);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    const cached = flagCache.get(file);
    if (cached?.stamp === info.mtimeMs) return cached.flags;
    const { stdout } = await exec('python3', ['-I', '-c', AST_SCRIPT, file], { timeout: 1500, maxBuffer: 128 * 1024 });
    const flags: Flag[] = JSON.parse(stdout);
    if (flagCache.size >= 200) flagCache.clear();
    flagCache.set(file, { stamp: info.mtimeMs, flags });
    return flags;
  } catch { return undefined; }
}
export function flagsFromHelp(help: string): Flag[] {
  const flags = new Map<string, Flag>();
  for (const line of help.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    if (!/^\s*-/.test(line)) continue;
    const declaration = line.trimStart().split(/\s{2,}/)[0].replace(/--\[no-\]([a-zA-Z][\w-]*)/g, '--$1, --no-$1');
    const entries = [...declaration.matchAll(/(?:^|[\s,|])(--?[a-zA-Z][\w-]*)(?:(?:[ =]|\[=)([A-Z][A-Z_0-9-]*|<[^>]+>|\{[^}]+\})(?=\s|,|\]|$))?/g)];
    const takesValue = entries.some(match => !!match[2] && !match[0].includes('[='));
    for (const match of entries) flags.set(match[1], { name: match[1], takesValue, ...(match[0].includes('[=') ? { optionalValue: true } : {}) });
  }
  return [...flags.values()];
}
