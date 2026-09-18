import { readdir, readFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { probe, SharedTask } from './probes.ts';
import type { Catalog, Flag } from '../src/protocol.ts';
import { tokens } from './repair.ts';
import { directoryEntries } from './directories.ts';
export { historySources as initialHistory } from './history.ts';
const flagCache = new Map<string, { stamp: number; task: SharedTask<Flag[] | undefined> }>();

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
  const entries = await directoryEntries(cwd, 10000);
  // Immediate entries take precedence over descendants, even in large projects.
  for (const entry of entries) paths.push(entry.name + (entry.isDirectory() ? '/' : ''));
  for (const dir of entries) {
    if (paths.length >= 4000) break;
    if (!dir.isDirectory() || skip.has(dir.name) || dir.name.startsWith('.')) continue;
    const children = await directoryEntries(path.join(cwd, dir.name), 4000 - paths.length);
    for (const child of children) {
      if (paths.length >= 4000) break;
      paths.push(path.join(dir.name, child.name) + (child.isDirectory() ? '/' : ''));
    }
  }
  return paths;
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
export async function describe(commandLine: string, cwd: string, signal = AbortSignal.timeout(4000)): Promise<Flag[] | undefined> {
  signal.throwIfAborted();
  const args = tokens(commandLine).map(t => t.value);
  if (!/^(python|python3)$/.test(args[0]) || !args[1]?.endsWith('.py')) return undefined;
  const file = path.resolve(cwd, args[1]);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    signal.throwIfAborted();
    let cached = flagCache.get(file);
    if (cached?.stamp !== info.mtimeMs || cached.task.aborted) {
      const task = new SharedTask<Flag[] | undefined>(async probeSignal => {
        try {
          const { stdout } = await probe('python3', ['-I', '-c', AST_SCRIPT, file], { timeout: 1500, maxBuffer: 128 * 1024 }, probeSignal);
          return JSON.parse(stdout);
        } catch { probeSignal.throwIfAborted(); return undefined; }
      });
      if (flagCache.size >= 200) flagCache.delete(flagCache.keys().next().value!);
      cached = { stamp: info.mtimeMs, task }; flagCache.set(file, cached);
    }
    return await cached.task.wait(signal);
  } catch { signal.throwIfAborted(); return undefined; }
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
