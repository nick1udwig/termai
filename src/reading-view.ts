import MarkdownIt from 'markdown-it';
import './reading-view.css';

export interface ReadingView { element: HTMLElement; dispose(): void }
export interface ReadingResources { load(path: string): Promise<Blob>; open(path: string): void }

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  token.attrSet('rel', 'noopener noreferrer');
  token.attrSet('target', '_blank');
  return self.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  token.attrSet('data-reading-src', token.attrGet('src') || '');
  token.attrSet('src', 'data:,');
  token.attrSet('alt', token.content);
  return self.renderToken(tokens, index, options);
};

function localLink(file: string, href: string): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  try {
    const absolute = file.startsWith('/');
    const url = new URL(href, 'https://reader.invalid/' + file.replace(/^\/+/, ''));
    return (absolute ? '/' : '') + decodeURIComponent(url.pathname.slice(1));
  } catch { return undefined; }
}

export function readingView(file: string, blob: Blob, resources?: ReadingResources): ReadingView {
  const element = document.createElement('section'); element.className = 'reading-view';
  element.setAttribute('aria-label', 'Reading ' + file);
  const stage = document.createElement('div'); stage.className = 'reading-stage'; element.append(stage);
  const type = blob.type.split(';')[0];
  const urls: string[] = [];
  let disposed = false;
  const objectURL = (data: Blob) => { const url = URL.createObjectURL(data); urls.push(url); return url; };
  if (type === 'text/markdown' || /\.(?:md|markdown)$/i.test(file) && type.startsWith('text/')) {
    const paper = document.createElement('article'); paper.className = 'reading-paper reading-markdown';
    paper.textContent = 'Loading Markdown…'; stage.append(paper);
    void blob.text().then(value => {
      if (disposed) return;
      paper.innerHTML = markdown.render(value);
      for (const image of paper.querySelectorAll<HTMLImageElement>('img[data-reading-src]')) {
        const src = image.dataset.readingSrc || '';
        const path = localLink(file, src);
        if (!path || !resources) { image.replaceWith(document.createTextNode(image.alt)); continue; }
        void resources.load(path).then(data => {
          if (!disposed) image.src = objectURL(data);
        }).catch(() => { if (!disposed) image.replaceWith(document.createTextNode(image.alt)); });
      }
    });
    paper.addEventListener('click', event => {
      const link = (event.target as Element).closest('a[href]');
      if (!link || !paper.contains(link)) return;
      const href = link.getAttribute('href') || '';
      const path = localLink(file, href);
      if (!path || !resources) return;
      event.preventDefault(); resources.open(path);
    });
  } else if (type.startsWith('text/') || ['application/json', 'application/xml'].includes(type)) {
    const paper = document.createElement('article'); paper.className = 'reading-paper';
    const text = document.createElement('pre'); text.className = 'reading-text';
    text.textContent = 'Loading text…'; paper.append(text); stage.append(paper);
    void blob.text().then(value => { if (!disposed) text.textContent = value; });
  } else if (type.startsWith('image/')) {
    const image = document.createElement('img'); image.src = objectURL(blob); image.alt = file.split('/').at(-1) || 'Image'; image.className = 'reading-image';
    stage.append(image);
  } else if (type === 'application/pdf') {
    const frame = document.createElement('iframe'); frame.src = objectURL(blob); frame.title = 'PDF: ' + file; frame.className = 'reading-pdf'; stage.append(frame);
  } else if (type.startsWith('audio/') || type.startsWith('video/')) {
    const media = document.createElement(type.startsWith('audio/') ? 'audio' : 'video');
    media.src = objectURL(blob); media.controls = true; media.className = 'reading-media'; stage.append(media);
  } else {
    const message = document.createElement('p'); message.className = 'reading-unsupported';
    message.textContent = 'This file type has no browser preview yet.'; stage.append(message);
  }
  return { element, dispose: () => { disposed = true; for (const url of urls) URL.revokeObjectURL(url); element.remove(); } };
}

export function readingMessage(file: string, message: string, hint?: string): HTMLElement {
  const element = document.createElement('section'); element.className = 'reading-view reading-empty';
  const title = document.createElement('h1'); title.textContent = file.split('/').at(-1) || file;
  const detail = document.createElement('p'); detail.textContent = message;
  element.append(title, detail);
  if (hint) { const help = document.createElement('p'); help.className = 'reading-hint'; help.textContent = hint; element.append(help); }
  return element;
}
