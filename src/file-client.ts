import type { FileClient } from './file-browser.ts';
/** Downloads use a short-lived, single-use URL so the browser streams to disk. */
export function saveDownload(base: string, ticket: string) {
  const url = new URL('api/files/download', base); url.searchParams.set('ticket', ticket);
  const link = document.createElement('a'); link.href = url.href; link.download = ''; link.referrerPolicy = 'no-referrer'; document.body.append(link); link.click(); link.remove();
}
export function fileClient(base: string, session: string, token: () => string | undefined, authenticate: () => Promise<void>): FileClient {
  async function request(route: string, query: Record<string, string>, init: RequestInit = {}) {
    const url = new URL(route, base); url.search = new URLSearchParams({ session, ...query }).toString();
    const send = () => fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { ...init.headers, ...(token() ? { Authorization: 'Bearer ' + token() } : {}) } });
    let response = await send();
    if (response.status === 401) { await authenticate(); response = await send(); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'File transfer failed.');
    return result;
  }
  return {
    async mkdir(path, name) { await request('api/files/mkdir', {}, { method: 'POST', body: JSON.stringify({ path, name }), headers: { 'Content-Type': 'application/json' } }); },
    list: path => request('api/files/list', { path }),
    async upload(path, file, signal) {
      if (file.size > 1024 ** 3) throw new Error('Uploads are limited to 1 GB per file.');
      await request('api/files/upload', { path, name: file.name }, { method: 'POST', body: file, signal, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    async download(path) {
      const { ticket } = await request('api/files/download', {}, { method: 'POST', body: JSON.stringify({ path }), headers: { 'Content-Type': 'application/json' } });
      saveDownload(base, ticket);
    },
  };
}
