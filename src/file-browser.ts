import './file-browser.css';
import type { FileListing, FileEntry } from './file-protocol.ts';

export interface FileClient {
  list(path: string): Promise<FileListing>;
  download(path: string): Promise<void>;
  upload(path: string, file: File, signal: AbortSignal): Promise<void>;
}
const folder = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M3 5h10l3 3h13a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>';
const documentIcon = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M7 2h12l7 7v20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M19 2v8h7" fill="none" stroke="#282a3f" stroke-width="2"/></svg>';
function button(label: string, action: () => void) { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.onclick = action; return el; }
export function fileSize(size: number) { if (size < 1024) return size + ' bytes'; const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024))); return (size / 1024 ** unit).toFixed(1) + ' ' + ['bytes', 'KB', 'MB', 'GB'][unit]; }
function permissions(entry: FileEntry) { return (entry.symlink ? 'l' : entry.directory ? 'd' : '-') + Array.from({ length: 9 }, (_, n) => entry.mode & (1 << (8 - n)) ? 'rwx'[n % 3] : '-').join(''); }
export function fileBrowser(client: FileClient, initial = '.', changed: (path: string) => void = () => {}) {
  const element = document.createElement('section'); element.className = 'file-browser'; element.setAttribute('aria-label', 'Files');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const crumbs = document.createElement('nav'); crumbs.className = 'file-breadcrumbs'; crumbs.setAttribute('aria-label', 'Directory');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search this folder'; search.setAttribute('aria-label', 'Search this folder'); search.className = 'file-search'; search.hidden = true;
  const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  const status = document.createElement('p'); status.className = 'file-status'; status.role = 'status'; status.setAttribute('aria-live', 'polite');
  const list = document.createElement('div'); list.className = 'file-list'; list.setAttribute('aria-label', 'Directory contents');
  let current = initial, listing: FileListing | undefined, generation = 0, disposed = false, uploading = false;
  const abort = new AbortController();
  const upload = button('↑ Upload', () => picker.click()); upload.className = 'file-upload';
  const refresh = button('↻', () => void load(current)); refresh.setAttribute('aria-label', 'Refresh folder');
  const find = button('⌕', () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); else { search.value = ''; render(); } }); find.setAttribute('aria-label', 'Search files');
  toolbar.append(crumbs, upload, refresh, find); element.append(toolbar, search, status, list, picker);
  const error = (reason: unknown) => { if (!disposed) { status.textContent = reason instanceof Error ? reason.message : 'File transfer failed.'; status.classList.add('error'); } };
  function render() {
    list.replaceChildren(); if (!listing) return;
    const row = (name: string, directory: boolean, action: () => void, info?: FileEntry) => {
      const b = button('', action); b.className = 'file-row'; b.setAttribute('aria-label', (directory ? 'Open folder ' : 'Download ') + name);
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.innerHTML = directory ? folder : documentIcon;
      const text = document.createElement('span'); text.className = 'file-details';
      const title = document.createElement('span'); title.className = 'file-name'; title.textContent = name;
      const meta = document.createElement('span'); meta.className = 'file-meta';
      if (info) { const mode = document.createElement('span'), date = document.createElement('span'); mode.textContent = permissions(info); date.textContent = new Date(info.modified).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); meta.append(mode, date); }
      text.append(title);
      if (info && !directory) { const size = document.createElement('span'); size.className = 'file-size'; size.textContent = fileSize(info.size); title.append(size); }
      text.append(meta); b.append(icon, text); list.append(b);
    };
    if (current !== '/') row('..', true, () => void load(listing!.parent));
    const shown = listing.entries.filter(entry => entry.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()));
    for (const item of shown) {
      const path = (current === '/' ? '' : current) + '/' + item.name;
      row(item.name, item.directory, () => item.directory ? void load(path) : void client.download(path).catch(error), item);
    }
    if (!shown.length) { const empty = document.createElement('p'); empty.className = 'file-empty'; empty.textContent = search.value ? 'No matching files.' : 'This folder is empty.'; list.append(empty); }
  }
  async function load(path: string) {
    const request = ++generation; upload.disabled = true; status.classList.remove('error'); status.textContent = 'Loading files…'; list.setAttribute('aria-busy', 'true');
    try {
      const result = await client.list(path); if (disposed || request !== generation) return;
      listing = result; current = result.path; changed(current); search.value = ''; crumbs.replaceChildren();
      crumbs.append(button('/', () => void load('/')));
      let prefix = ''; for (const part of current.split('/').filter(Boolean)) { prefix += '/' + part; const target = prefix; crumbs.append(button(part, () => void load(target))); }
      status.textContent = result.truncated ? 'Showing the first 10,000 entries. Open a subfolder to browse further.' : ''; render();
    } catch (e) { if (request === generation) error(e); }
    finally { if (request === generation) { list.setAttribute('aria-busy', 'false'); upload.disabled = uploading; } }
  }
  picker.onchange = async () => {
    if (upload.disabled) { picker.value = ''; return; } const files = [...picker.files || []], destination = current; picker.value = ''; if (!files.length) return;
    uploading = true; upload.disabled = true;
    try { for (const file of files) { status.classList.remove('error'); status.textContent = 'Uploading ' + file.name + '…'; await client.upload(destination, file, abort.signal); } await load(current); status.textContent = `${files.length} file${files.length === 1 ? '' : 's'} uploaded.`; }
    catch (e) { error(e); }
    finally { uploading = false; upload.disabled = false; }
  };
  search.oninput = render;
  void load(initial);
  return { element, dispose() { disposed = true; abort.abort(); element.remove(); } };
}
