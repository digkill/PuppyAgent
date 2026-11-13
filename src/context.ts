import type { Message, StoredMessage } from './types.ts';

// Deliberately conservative UTF-8-byte estimate. No tokenizer assumption or silent history slicing.
export function estimateTokens(system: string, messages: Message[], tools: unknown = []): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system, messages, tools }), 'utf8') / 2);
}
export function compactionSplit(messages: StoredMessage[]): { older: StoredMessage[]; recent: StoredMessage[] } | null {
  // Keep at least two complete user turns; never split tool_use from tool_result.
  const userTurns = messages.map((m, i) => m.role === 'user' && m.content.some(b => b.type === 'text') ? i : -1).filter(i => i >= 0);
  if (userTurns.length < 3) {
    // A long coding task may contain many tool rounds without another user message.
    // Cut before an assistant round, retain two complete rounds and pin the exact task.
    const rounds = messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0);
    if (rounds.length < 4) return null;
    const cut = rounds[rounds.length - 2];
    const task = messages.slice(0, cut).findLast(m => m.role === 'user' && m.content.some(b => b.type === 'text'));
    if (!task) return null;
    return { older: messages.slice(0, cut), recent: [task, ...messages.slice(cut)] };
  }
  const cut = userTurns[userTurns.length - 2];
  if (cut <= 0) return null;
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}
export function activeHistory(messages: StoredMessage[], after: number): StoredMessage[] {
  const active = messages.filter(m => m.id > after);
  if (active[0]?.role === 'assistant') {
    const task = messages.findLast(m => m.id <= after && m.role === 'user' && m.content.some(b => b.type === 'text'));
    if (task) return [task, ...active];
  }
  return active;
}
export function textContent(message: Message): string {
  return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
