import { CellFlags, type GhosttyCell, type GhosttyTerminal } from 'ghostty-web';

interface Glyph { text: string; width: number; row: number; col: number; cell: GhosttyCell; link?: string }
interface Row { glyphs: Glyph[]; text: string; background?: string }
export interface LayoutCursor { row: number; x: number }
export interface CodexLayout { text: string; rows: number; cursor(row: number, col: number): LayoutCursor | undefined }
const bg = (cell: GhosttyCell) => `${cell.bg_r};${cell.bg_g};${cell.bg_b}`;
const content = (glyphs: Glyph[]) => glyphs.map(g => g.text).join('');
const width = (glyphs: Glyph[]) => glyphs.reduce((sum, g) => sum + g.width, 0);
const trim = (glyphs: Glyph[]) => { let end = glyphs.length; while (end && glyphs[end - 1].text === ' ') end--; return glyphs.slice(0, end); };
const left = (glyphs: Glyph[]) => { let start = 0; while (start < glyphs.length && glyphs[start].text === ' ') start++; return glyphs.slice(start); };

/** The shaded composer is an unambiguous width hint; observer frames can be
 * larger than the PTY, and old scrollback may have been drawn at other widths. */
export function codexColumns(text: string): number | undefined {
  const rows = text.split(/\r?\n/);
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 80); i--) {
    if (!/\x1b\[[\d;]*48[;:]/.test(rows[i])) continue;
    const plain = rows[i].replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\))/g, '');
    // Blank painted rows contain ASCII spaces, so their length is in cells.
    if (/^ {20,1000}$/.test(plain)) return plain.length;
  }
}

/** Adapt recognized Codex controls and prose, retaining each glyph's original
 * cell coordinates for the real PTY cursor. Other TUIs keep the ordinary path. */
export function layoutCodex(terminal: GhosttyTerminal, starts: number[], columns: number, caret?: LayoutCursor): CodexLayout | undefined {
  if (columns >= terminal.cols || columns < 8) return;
  const history = terminal.getScrollbackLength(), total = history + terminal.rows;
  const defaults = terminal.getColors(), defaultBg = `${defaults.background.r};${defaults.background.g};${defaults.background.b}`;
  const viewport = terminal.getViewport();
  const rows: Row[] = starts.map((start, index) => {
    const glyphs: Glyph[] = [];
    const end = index + 1 < starts.length ? starts[index + 1] : Math.min(total, history + terminal.getCursor().y + 1);
    for (let row = start; row < end; row++) {
      const cells = row < history ? terminal.getScrollbackLine(row) : viewport.slice((row - history) * terminal.cols, (row - history + 1) * terminal.cols);
      for (const [col, cell] of (cells || []).entries()) {
        if (!cell.width) continue;
        const text = cell.grapheme_len > 1 ? (row < history ? terminal.getScrollbackGraphemeString(row, col) : terminal.getGraphemeString(row - history, col))?.replaceAll('\0', ' ') || ' '
          : cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' ';
        const link = cell.hyperlink_id ? (row < history ? terminal.getScrollbackHyperlinkUri(row, col) : terminal.getHyperlinkUri(row - history, col)) || undefined : undefined;
        glyphs.push({ text, width: cell.width, row, col, cell, link });
      }
    }
    const painted = glyphs.find(g => bg(g.cell) !== defaultBg);
    const background = painted && glyphs.filter(g => bg(g.cell) === bg(painted.cell)).length >= glyphs.length * .9 ? bg(painted.cell) : undefined;
    return { glyphs, text: content(trim(glyphs)), background };
  });
  const composer = rows.findLastIndex(row => row.background && /^\s*› /.test(row.text));
  // Menus, fullscreen tools and future Codex layouts fall back without guessing.
  if (composer < 0 || rows.length - composer > 35) return;
  let first = composer, last = composer;
  while (first && rows[first - 1].background === rows[composer].background) first--;
  while (last + 1 < rows.length && rows[last + 1].background === rows[composer].background) last++;

  const positions = new Map<number, Map<number, LayoutCursor>>();
  const output: { glyphs: Glyph[]; background?: string }[] = [];
  const place = (glyphs: Glyph[], background?: string) => {
    const row = output.length; let x = 0;
    for (const glyph of glyphs) {
      let cells = positions.get(glyph.row); if (!cells) positions.set(glyph.row, cells = new Map());
      for (let offset = 0; offset < glyph.width; offset++) cells.set(glyph.col + offset, { row, x: x + offset });
      x += glyph.width;
    }
    output.push({ glyphs, background });
  };
  const wrap = (glyphs: Glyph[], indent: number, background?: string, words = true) => {
    let rest = glyphs, continuation = false;
    if (!rest.length) { place([], background); return; }
    while (rest.length) {
      const inset = continuation ? Math.min(indent, columns - 2) : 0, available = columns - inset;
      let end = 0, used = 0;
      while (end < rest.length && used + rest[end].width <= available) used += rest[end++].width;
      if (!end) end = 1;
      if (words && end < rest.length) {
        let space = end; while (space > 0 && rest[space - 1].text !== ' ') space--;
        // Keep indentation out of the word-break search. Long tokens still wrap.
        if (space > (continuation ? 0 : indent) && content(rest.slice(0, space)).trim()) end = space;
      }
      const line = background ? rest.slice(0, end) : trim(rest.slice(0, end));
      if (inset) {
        const sample = rest[0];
        place([...Array.from({ length: inset }, () => ({ ...sample, text: ' ', width: 1, row: -1, col: -1 })), ...line], background);
      } else place(line, background);
      const consumed = rest.slice(0, end), next = words && !background ? left(rest.slice(end)) : rest.slice(end);
      const endPosition = { row: output.length - 1, x: Math.min(columns - 1, inset + width(line)) };
      // Deleted wrap spaces belong to the end of their preceding visual line.
      for (const g of [...consumed.slice(line.length), ...rest.slice(end, rest.length - next.length)]) {
        let cells = positions.get(g.row); if (!cells) positions.set(g.row, cells = new Map());
        cells.set(g.col, endPosition);
      }
      rest = next; continuation = true;
    }
  };
  const structured = (text: string) => /^\s{4,}\S|[│┃┌┐└┘├┤┬┴┼╭╮╰╯─━]|^\s*(?:\|.*\||[+\-] |@@|\$ |(?:const|let|def|fn|import|export)\b)/u.test(text);
  const ellipsis = (glyphs: Glyph[], limit: number) => {
    if (width(glyphs) <= limit) return glyphs;
    let used = 0, end = 0; while (end < glyphs.length && used + glyphs[end].width < limit) used += glyphs[end++].width;
    return [...trim(glyphs.slice(0, end)), { ...glyphs[end], text: '…', width: 1, row: -1, col: -1 }];
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; let glyphs = trim(row.glyphs);
    if (i >= first && i <= last) {
      // Paint the local row with EL rather than wrapping desktop-width spaces.
      // Keep draft whitespace up to its caret, but discard the widget's padding.
      if (caret && row.glyphs.some(g => g.row === caret.row)) {
        const end = row.glyphs.findLastIndex(g => g.row === caret.row && g.col <= caret.x) + 1;
        glyphs = row.glyphs.slice(0, Math.max(glyphs.length, end));
      }
      wrap(glyphs, 2, row.background); continue;
    }
    if (i > last) {
      // Compact the status and independently right-aligned warning/hint groups.
      glyphs = left(glyphs);
      const groups: Glyph[][] = [[]]; let spaces: Glyph[] = [];
      for (const g of glyphs) {
        if (g.text === ' ') { spaces.push(g); continue; }
        if (spaces.length >= 3 && groups.at(-1)!.length) groups.push([]);
        else groups.at(-1)!.push(...spaces);
        spaces = []; groups.at(-1)!.push(g);
      }
      if (groups.length > 1) {
        // Keep alerts visible; shortcut hints may occupy their own compact row.
        for (const group of groups) place(ellipsis(group, columns));
      } else {
        // Preserve model/effort, then shorten a path to its last component.
        const pathStart = glyphs.findIndex((g, n) => (g.text === '~' && glyphs[n + 1]?.text === '/') || (g.text === '/' && (!n || glyphs[n - 1].text === ' ')));
        if (pathStart >= 0 && width(glyphs) > columns) {
          let pathEnd = pathStart; while (pathEnd < glyphs.length && glyphs[pathEnd].text !== ' ') pathEnd++;
          const slash = glyphs.findLastIndex((g, n) => n >= pathStart && n < pathEnd && g.text === '/');
          if (slash > pathStart) glyphs.splice(pathStart, slash - pathStart, { ...glyphs[pathStart], text: '…', width: 1, row: -1, col: -1 });
        }
        place(ellipsis(glyphs, columns));
      }
      continue;
    }
    // Codex's italic Recap/callout uses a large desktop hanging indent. Join its
    // continuation rows and choose a small mobile indent; never join code rows.
    if (/^\s*↳ /.test(row.text) && glyphs.some(g => g.cell.flags & CellFlags.ITALIC)) {
      while (i + 1 < first && /^\s{2,}\S/.test(rows[i + 1].text) && left(trim(rows[i + 1].glyphs)).every(g => g.cell.flags & CellFlags.ITALIC)) {
        const next = left(trim(rows[++i].glyphs));
        glyphs.push({ ...next[0], text: ' ', width: 1, row: -1, col: -1 }, ...next);
      }
      glyphs = left(glyphs); wrap(glyphs, 2); continue;
    }
    const indent = Math.min(2, row.text.length - row.text.trimStart().length + (/^\s*[•›]/.test(row.text) ? 2 : 0));
    wrap(glyphs, indent, undefined, !structured(row.text));
  }
  const style = (g: Glyph) => {
    const c = g.cell, codes = ['0'];
    for (const [flag, code] of [[CellFlags.BOLD, 1], [CellFlags.ITALIC, 3], [CellFlags.UNDERLINE, 4], [CellFlags.STRIKETHROUGH, 9], [CellFlags.INVERSE, 7], [CellFlags.INVISIBLE, 8], [CellFlags.BLINK, 5], [CellFlags.FAINT, 2]]) if (c.flags & flag) codes.push(String(code));
    const fg = defaults.foreground;
    codes.push(c.fg_r === fg.r && c.fg_g === fg.g && c.fg_b === fg.b ? '39' : `38;2;${c.fg_r};${c.fg_g};${c.fg_b}`);
    codes.push(bg(c) === defaultBg ? '49' : `48;2;${bg(c)}`);
    return '\x1b[' + codes.join(';') + 'm';
  };
  const text = output.map(row => {
    let result = '', current = '', link: string | undefined;
    for (const g of row.glyphs) {
      const next = style(g); if (next !== current) { result += next; current = next; }
      const href = g.link?.replace(/[\x00-\x1f\x7f]/g, '');
      if (href !== link) { result += '\x1b]8;;' + (href || '') + '\x1b\\'; link = href; }
      result += g.text;
    }
    if (link) result += '\x1b]8;;\x1b\\';
    if (row.background && width(row.glyphs) < columns) result += '\x1b[0;48;2;' + row.background + 'm\x1b[K';
    return result + '\x1b[0m';
  }).join('\r\n');
  return { text, rows: output.length, cursor(row, col) {
    const cells = positions.get(row), exact = cells?.get(col); if (exact) return exact;
    if (!cells?.size) return;
    const end = [...cells.keys()].filter(x => x <= col).sort((a, b) => b - a)[0];
    if (end === undefined) return;
    const pos = cells.get(end)!; return { row: pos.row, x: Math.min(columns - 1, pos.x + col - end) };
  } };
}
