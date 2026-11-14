/** Small, dependency-free terminal Markdown renderer. It emits only our own SGR sequences. */
export type MarkdownOptions = { color?: boolean; width?: number; markdown?: boolean };
const reset = '\x1b[0m';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function sanitizeTerminal(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(sanitizeTerminal(value))) {
    if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(segment)) continue;
    width += /[\p{Extended_Pictographic}\p{Regional_Indicator}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(segment) ? 2 : 1;
  }
  return width;
}
function paint(text: string, codes: number[], color: boolean): string {
  return color && codes.length && text ? `\x1b[${codes.join(';')}m${text}${reset}` : text;
}
function closing(text: string, marker: string, from: number): number {
  let index = text.indexOf(marker, from);
  while (index >= 0) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) return index;
    index = text.indexOf(marker, index + marker.length);
  }
  return -1;
}
export function inlineMarkdown(value: string, color = true, base: number[] = [], depth = 0): string {
  const text = sanitizeTerminal(value);
  if (depth > 8) return paint(text, base, color);
  let output = '', literal = '', i = 0;
  const flush = () => { output += paint(literal, base, color); literal = ''; };
  while (i < text.length) {
    if (text[i] === '\\' && /[\\`*{}_\[\]()#+.!|~>-]/.test(text[i + 1] || '')) { literal += text[i + 1]; i += 2; continue; }
    if (text[i] === '`') {
      let length = 1;
      while (text[i + length] === '`') length++;
      const marker = '`'.repeat(length), end = closing(text, marker, i + length);
      if (end >= 0) {
        flush();
        let content = text.slice(i + length, end);
        if (/^ .* $/.test(content) && content.trim()) content = content.slice(1, -1);
        output += paint(content, [...base, 33], color); i = end + length; continue;
      }
      literal += marker; i += length; continue;
    }
    const link = text.slice(i).match(/^(!?)\[([^\]\n]*)\]\(/);
    if (link) {
      let end = i + link[0].length, nesting = 1;
      while (end < text.length && nesting) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '(') nesting++;
        if (text[end] === ')') nesting--;
        if (nesting) end++;
      }
      if (!nesting) {
        const url = text.slice(i + link[0].length, end).trim().replace(/^<(.+)>$/, '$1');
        flush();
        output += inlineMarkdown(link[2] || (link[1] ? 'image' : url), color, [...base, 34, 4], depth + 1);
        if (url && url !== link[2]) output += paint(` (${url})`, [...base, 2], color);
        i = end + 1; continue;
      }
    }
    const autoLink = text.slice(i).match(/^<(https?:\/\/[^>\s]+)>/);
    if (autoLink) { flush(); output += paint(autoLink[1], [...base, 34, 4], color); i += autoLink[0].length; continue; }
    let matched = false;
    for (const [marker, codes] of [['***', [1, 3]], ['___', [1, 3]], ['**', [1]], ['__', [1]], ['~~', [9]], ['*', [3]], ['_', [3]]] as [string, number[]][]) {
      if (!text.startsWith(marker, i) || /\s/.test(text[i + marker.length] || ' ')) continue;
      if (marker.includes('_') && /[\p{L}\p{N}]/u.test(text[i - 1] || '')) continue;
      const end = closing(text, marker, i + marker.length);
      if (end <= i + marker.length || /\s/.test(text[end - 1])) continue;
      if (marker.includes('_') && /[\p{L}\p{N}]/u.test(text[end + marker.length] || '')) continue;
      flush(); output += inlineMarkdown(text.slice(i + marker.length, end), color, [...base, ...codes], depth + 1);
      i = end + marker.length; matched = true; break;
    }
    if (!matched) literal += text[i++];
  }
  flush(); return output;
}

const aliases: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', golang: 'go', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', html: 'markup', xml: 'markup', svg: 'markup', c: 'cpp', 'c++': 'cpp', rs: 'rust', cs: 'csharp' };
const languages = new Set(['typescript', 'javascript', 'python', 'go', 'bash', 'json', 'jsonc', 'yaml', 'sql', 'php', 'css', 'markup', 'diff', 'cpp', 'rust', 'java', 'csharp']);
const keywords = new Set(('abstract as async await break case catch class const continue debugger declare default def defer del delete do elif else enum except export extends extern final finally fn for from func function go if implements import in instanceof interface is lambda let match namespace new nonlocal of package pass private protected pub public raise range readonly ref return select sizeof static struct super switch this throw throws trait try type typeof union use using var void volatile when where while with yield').split(' '));
const constants = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NULL', 'NaN', 'Infinity']);
const sqlWords = new Set('SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE JOIN LEFT RIGHT INNER OUTER ON AS GROUP BY ORDER LIMIT OFFSET HAVING CREATE ALTER DROP TABLE INDEX PRIMARY KEY REFERENCES DEFAULT NULL IS IN LIKE DISTINCT ASC DESC UNION ALL BEGIN COMMIT ROLLBACK RETURNING'.split(' '));
const shellCommands = new Set('echo printf cd export unset source exit set npm node python python3 go git yarn pnpm bun docker curl'.split(' '));

export class CodeHighlighter {
  language: string;
  color: boolean;
  multiline: string | null = null;
  constructor(language: string, color: boolean) { this.language = aliases[language.toLowerCase()] || language.toLowerCase(); this.color = color; }
  line(value: string): string {
    const text = sanitizeTerminal(value), lang = this.language;
    if (!this.color || !languages.has(lang)) return text;
    if (lang === 'diff') return paint(text, text.startsWith('+') ? [32] : text.startsWith('-') ? [31] : text.startsWith('@@') ? [36] : [], true);
    let i = 0, output = '';
    const token = (end: number, codes: number[]) => { output += paint(text.slice(i, end), codes, true); i = end; };
    while (i < text.length) {
      if (this.multiline) {
        const end = closing(text, this.multiline, i);
        const comment = this.multiline === '*/' || this.multiline === '-->';
        if (end < 0) { token(text.length, comment ? [2, 90] : [32]); break; }
        token(end + this.multiline.length, comment ? [2, 90] : [32]); this.multiline = null; continue;
      }
      const rest = text.slice(i);
      if ((lang === 'python' || lang === 'bash' || lang === 'yaml') && rest.startsWith('#') || lang === 'sql' && rest.startsWith('--') || !['python', 'bash', 'yaml', 'sql', 'markup', 'json', 'css'].includes(lang) && rest.startsWith('//')) { token(text.length, [2, 90]); break; }
      const commentEnd = lang === 'markup' && rest.startsWith('<!--') ? '-->' : !['python', 'bash', 'yaml', 'json', 'markup'].includes(lang) && rest.startsWith('/*') ? '*/' : null;
      if (commentEnd) {
        const opening = commentEnd === '-->' ? 4 : 2, end = text.indexOf(commentEnd, i + opening);
        if (end < 0) { this.multiline = commentEnd; token(text.length, [2, 90]); break; }
        token(end + commentEnd.length, [2, 90]); continue;
      }
      const triple = lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''")) ? rest.slice(0, 3) : null;
      if (triple) {
        const end = closing(text, triple, i + 3);
        if (end < 0) { this.multiline = triple; token(text.length, [32]); break; }
        token(end + 3, [32]); continue;
      }
      const quote = text[i];
      if (quote === '"' || quote === "'" || quote === '`' && ['typescript', 'javascript', 'go', 'bash'].includes(lang)) {
        const end = closing(text, quote, i + 1);
        if (end < 0) {
          if (quote === '`' || ['bash', 'sql'].includes(lang)) this.multiline = quote;
          token(text.length, [32]); break;
        }
        const isKey = (lang === 'json' || lang === 'jsonc') && /^\s*:/.test(text.slice(end + 1));
        token(end + 1, isKey ? [36] : [32]); continue;
      }
      const number = rest.match(/^(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)(?:n|f)?\b/i);
      if (number && !/[\w$]/.test(text[i - 1] || '')) { token(i + number[0].length, [35]); continue; }
      const word = rest.match(['yaml', 'css', 'markup', 'bash'].includes(lang) ? /^[\p{L}_$][\p{L}\p{N}_$-]*/u : /^[\p{L}_$][\p{L}\p{N}_$]*/u);
      if (word) {
        const value = word[0], after = text.slice(i + value.length);
        let codes: number[] = [];
        if (constants.has(value)) codes = [35];
        else if (lang === 'bash' && value.startsWith('$')) codes = [36];
        else if (lang === 'bash' && shellCommands.has(value)) codes = [33];
        else if (lang === 'sql' ? sqlWords.has(value.toUpperCase()) : !['json', 'jsonc', 'yaml', 'markup', 'css'].includes(lang) && keywords.has(value)) codes = [1, 34];
        else if (lang === 'markup' && /<\/?\s*$/.test(text.slice(0, i))) codes = [31];
        else if (['yaml', 'css'].includes(lang) && /^\s*:/.test(after)) codes = [36];
        else if (/^\s*\(/.test(after) && !['json', 'yaml', 'markup'].includes(lang)) codes = [33];
        token(i + value.length, codes); continue;
      }
      token(i + 1, /[{}\[\]():=<>+*/!&|%?-]/.test(text[i]) ? [90] : []);
    }
    return output;
  }
}

function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out: string[] = []; let current = '', ticks = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) { current += text[i] + text[++i]; continue; }
    if (text[i] === '`') {
      let run = 1; while (text[i + run] === '`') run++;
      ticks = ticks === run ? 0 : ticks || run; current += '`'.repeat(run); i += run - 1; continue;
    }
    if (text[i] === '|' && !ticks) { out.push(current.trim()); current = ''; } else current += text[i];
  }
  out.push(current.trim()); return out;
}
function wrap(value: string, width: number): string[] {
  const out: string[] = []; let line = '', used = 0;
  for (const { segment } of segmenter.segment(value)) {
    const size = displayWidth(segment);
    if (line && used + size > width) { out.push(line); line = ''; used = 0; }
    line += segment; used += size;
  }
  out.push(line); return out;
}

export class MarkdownRenderer {
  options: Required<MarkdownOptions>;
  pending = '';
  fence: { marker: string; size: number; highlighter: CodeHighlighter } | null = null;
  candidate: string | null = null;
  table: { headers: string[]; rows: string[][] } | null = null;
  constructor(options: MarkdownOptions = {}) {
    this.options = { color: options.color ?? true, width: Math.max(20, Math.min(240, options.width || 80)), markdown: options.markdown ?? true };
  }
  write(chunk: string): string {
    this.pending += chunk;
    let output = '', newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, ''); this.pending = this.pending.slice(newline + 1);
      output += this.line(sanitizeTerminal(line));
    }
    return output;
  }
  finish(): string {
    let output = '';
    if (this.pending) { output += this.line(sanitizeTerminal(this.pending)); this.pending = ''; }
    if (this.candidate !== null) { output += this.prose(this.candidate); this.candidate = null; }
    if (this.table) output += this.flushTable();
    if (this.fence) { output += paint('╰─', [2, 90], this.options.color) + '\n'; this.fence = null; }
    return output;
  }
  private line(line: string): string {
    if (!this.options.markdown) return line + '\n';
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (this.fence) {
      if (marker && marker[1][0] === this.fence.marker && marker[1].length >= this.fence.size && !marker[2].trim()) {
        this.fence = null; return paint('╰─', [2, 90], this.options.color) + '\n';
      }
      return this.fence.highlighter.line(line) + '\n';
    }
    let output = '';
    if (this.table) {
      if (line.includes('|') && !marker && cells(line).length === this.table.headers.length) {
        this.table.rows.push(cells(line));
        if (this.table.rows.length >= 200) {
          const headers = this.table.headers; output += this.flushTable(); this.table = { headers, rows: [] };
        }
        return output;
      }
      output += this.flushTable();
    }
    if (this.candidate !== null) {
      const header = cells(this.candidate), separator = cells(line);
      if (header.length > 1 && header.length === separator.length && separator.every(s => /^:?-{3,}:?$/.test(s))) {
        this.table = { headers: header, rows: [] }; this.candidate = null; return output;
      }
      output += this.prose(this.candidate); this.candidate = null;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      const language = marker[2].trim().split(/\s+/)[0].slice(0, 32);
      this.fence = { marker: marker[1][0], size: marker[1].length, highlighter: new CodeHighlighter(language, this.options.color) };
      return output + paint(`╭─ ${language || 'code'}`, [2, 90], this.options.color) + '\n';
    }
    if (line.includes('|') && cells(line).length > 1) { this.candidate = line; return output; }
    return output + this.prose(line);
  }
  private prose(line: string): string {
    const color = this.options.color;
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) return paint('─'.repeat(Math.min(60, this.options.width)), [2, 90], color) + '\n';
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/);
    if (heading) return inlineMarkdown(heading[2].replace(/[ \t]+#+[ \t]*$/, '').trimEnd(), color, heading[1].length <= 2 ? [1, 36] : [1]) + '\n';
    const quote = line.match(/^\s{0,3}(>\s*)+(.*)$/);
    if (quote) {
      const depth = line.slice(0, line.indexOf(quote[2])).split('>').length - 1;
      return paint('│ '.repeat(Math.max(1, depth)), [2, 90], color) + inlineMarkdown(quote[2], color, [2]) + '\n';
    }
    const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (list) {
      const bullet = /^\d/.test(list[2]) ? list[2] : '•';
      const box = list[3] !== undefined ? list[3].toLowerCase() === 'x' ? '[✓] ' : '[ ] ' : '';
      return list[1] + paint(bullet, [36], color) + ' ' + paint(box, [32], color) + inlineMarkdown(list[4], color) + '\n';
    }
    return inlineMarkdown(line.replace(/ {2,}$/, ''), color) + '\n';
  }
  private flushTable(): string {
    const table = this.table!; this.table = null;
    const rows = [table.headers, ...table.rows].map(row => row.map(cell => inlineMarkdown(cell, false)));
    const available = Math.max(rows[0].length, this.options.width - rows[0].length * 3 - 1);
    const maxWidth = Math.max(1, Math.floor(available / rows[0].length));
    const widths = rows[0].map((_, i) => Math.max(1, Math.min(maxWidth, Math.max(...rows.map(row => displayWidth(row[i]))))));
    const border = (left: string, middle: string, right: string) => paint(left + widths.map(w => '─'.repeat(w + 2)).join(middle) + right, [2, 90], this.options.color) + '\n';
    let output = border('┌', '┬', '┐');
    rows.forEach((row, index) => {
      const wrapped = row.map((value, i) => wrap(value, widths[i]));
      for (let line = 0; line < Math.max(...wrapped.map(c => c.length)); line++) {
        output += '│ ' + wrapped.map((cell, i) => {
          const text = cell[line] || '';
          return paint(text + ' '.repeat(Math.max(0, widths[i] - displayWidth(text))), index === 0 ? [1, 36] : [], this.options.color);
        }).join(' │ ') + ' │\n';
      }
      if (index === 0) output += border('├', '┼', '┤');
    });
    return output + border('└', '┴', '┘');
  }
}
export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const renderer = new MarkdownRenderer(options);
  return renderer.write(text) + renderer.finish();
}
