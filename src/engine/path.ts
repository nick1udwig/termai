/** POSIX paths on the shell host, independent of the browser's operating system. */
export function resolve(...parts: string[]): string {
  const result: string[] = [];
  for (const part of parts) {
    if (part.startsWith('/')) result.length = 0;
    for (const component of part.split('/')) {
      if (!component || component === '.') continue;
      if (component === '..') result.pop(); else result.push(component);
    }
  }
  return '/' + result.join('/');
}
export function join(...parts: string[]): string {
  // Callers use an absolute cwd/home as the first component.
  return resolve(parts.filter(Boolean).join('/'));
}
