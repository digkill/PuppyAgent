import { MarkdownRenderer, renderMarkdown, sanitizeTerminal } from './terminal-markdown.ts';
import type { MarkdownOptions } from './terminal-markdown.ts';
import type { Language } from './types.ts';

/** Keep response formatting separate from the model transcript and tool/event output. */
export class AssistantOutput {
  root: string;
  sink: (text: string) => void;
  options: MarkdownOptions;
  language: Language;
  renderer: MarkdownRenderer | null = null;
  source = '';
  notices: string[] = [];
  paused = 0;
  deferred: string[] = [];
  constructor(root: string, sink: (text: string) => void, options: MarkdownOptions, language: Language = 'en') {
    this.root = root; this.sink = sink; this.options = options; this.language = language;
  }
  private write(text: string): void {
    if (!text) return;
    if (this.paused) this.deferred.push(text); else this.sink(text);
  }
  pause(): void { this.paused++; }
  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    if (!this.paused) { const text = this.deferred.join(''); this.deferred = []; if (text) this.sink(text); }
  }
  delta(sessionId: string, text: string): void {
    // Helpers are rendered on completion, so simultaneous token streams cannot interleave code.
    if (sessionId !== this.root || !text) return;
    if (!this.renderer) { this.renderer = new MarkdownRenderer(this.options); this.write('\n🐶\n'); }
    this.source += text;
    this.write(this.renderer.write(text));
  }
  complete(sessionId: string, text: string): void {
    if (sessionId === this.root && this.renderer) {
      if (text.startsWith(this.source)) this.write(this.renderer.write(text.slice(this.source.length)));
      else if (text !== this.source) {
        // A nonconforming gateway may stream a different text than its completed message.
        this.write(this.renderer.finish());
        this.write('\n🐶\n' + renderMarkdown(text, this.options));
        this.renderer = null;
      }
      this.finish(); return;
    }
    const prefix = sessionId === this.root ? '🐶' : `🐾 ${sanitizeTerminal(sessionId.slice(0, 8))}`;
    const block = `\n${prefix}\n${renderMarkdown(text, this.options)}`;
    if (this.renderer) this.notices.push(block); else this.write(block);
  }
  notice(text: string): void {
    const safe = sanitizeTerminal(text) + '\n';
    if (this.renderer) this.notices.push(safe); else this.write(safe);
  }
  finish(interrupted = false): void {
    if (this.renderer) {
      this.write(this.renderer.finish());
      if (interrupted) this.write(this.language === 'ru' ? '[Ответ прерван]\n' : '[Response interrupted]\n');
    }
    this.renderer = null; this.source = '';
    const notices = this.notices; this.notices = [];
    for (const notice of notices) this.write(notice);
  }
}
