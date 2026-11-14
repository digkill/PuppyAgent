import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeHighlighter, displayWidth, inlineMarkdown, MarkdownRenderer, renderMarkdown, sanitizeTerminal } from '../src/terminal-markdown.ts';
import { AssistantOutput } from '../src/terminal-output.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sample = [
  '# Puppy Agent', '', '**Bold** and *italic*, ~~removed~~ and `inline_code`.',
  '- [x] Done', '  - [ ] Next', '1. First', '> A quoted answer',
  '[MediaRise](https://MediaRise.org)', '', '```typescript',
  'const message = "**literal**\\n"; // keep code intact', 'console.log(message);', '```', '',
  '| Name | Status |', '| --- | --- |', '| Puppy | ready |', '| Щенок 🐶 | готов |', '', 'Last line.',
].join('\n');

test('Markdown formats headings, inline styles, lists, tasks, quotes and links', () => {
  const rich = renderMarkdown(sample);
  const text = sanitizeTerminal(rich);
  assert.match(rich, /\x1b\[1;36mPuppy Agent/);
  assert.match(rich, /\x1b\[1mBold/);
  assert.match(rich, /\x1b\[3mitalic/);
  assert.match(rich, /\x1b\[9mremoved/);
  assert.match(text, /• \[✓\] Done/);
  assert.match(text, /  • \[ \] Next/);
  assert.match(text, /1\. First/);
  assert.match(text, /│ A quoted answer/);
  assert.match(text, /MediaRise \(https:\/\/MediaRise.org\)/);
  assert.match(text, /╭─ typescript/);
  assert.match(text, /\*\*literal\*\*\\n/);
  assert.doesNotMatch(text, /```/);
});

test('streamed Markdown matches a complete response for every possible split point', () => {
  const expected = renderMarkdown(sample);
  for (let split = 0; split <= sample.length; split++) {
    const renderer = new MarkdownRenderer();
    assert.equal(renderer.write(sample.slice(0, split)) + renderer.write(sample.slice(split)) + renderer.finish(), expected, `split=${split}`);
  }
  const renderer = new MarkdownRenderer();
  let result = '';
  for (const char of sample) result += renderer.write(char);
  assert.equal(result + renderer.finish(), expected);
});

test('unfinished fences, tilde fences and unknown languages remain readable without losing code', () => {
  const renderer = new MarkdownRenderer({ color: false });
  assert.equal(renderer.write('```py\nprint("hello")'), '╭─ py\n');
  assert.equal(renderer.finish(), 'print("hello")\n╰─\n');
  const unknown = renderMarkdown('~~~~strange-language\n**literal**\n~~~\n~~~~', { color: true });
  assert.match(sanitizeTerminal(unknown), /\*\*literal\*\*\n~~~\n╰─/);
});

test('syntax colors do not change source characters or interpret Markdown inside code', () => {
  for (const [language, source] of [
    ['typescript', 'const value = "**hello**\\n"; // comment'],
    ['python', 'def greet(name): return True # comment'],
    ['go', 'func main() { value := 42 }'],
    ['json', '{"hello": true, "n": 42}'],
    ['sql', 'SELECT name FROM users WHERE id = 42;'],
    ['bash', 'export VALUE="hello" # comment'],
    ['diff', '+new line'],
    ['html', '<div class="card">Hello</div>'],
  ]) {
    const output = new CodeHighlighter(language, true).line(source);
    assert.match(output, /\x1b\[/, language);
    assert.equal(sanitizeTerminal(output), source, language);
  }
  const lexer = new CodeHighlighter('ts', true);
  assert.match(lexer.line('/* opening comment'), /\x1b\[2;90m/);
  const closing = lexer.line('continued */ const answer = 42;');
  assert.match(closing, /\x1b\[1;34mconst/);
  assert.equal(sanitizeTerminal(closing), 'continued */ const answer = 42;');
});

test('table widths account for emoji, CJK, combining characters and long cells', () => {
  assert.equal(displayWidth('Щенок'), 5);
  assert.equal(displayWidth('🐶'), 2);
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('e\u0301'), 1);
  const output = renderMarkdown('| Key | Value |\n| --- | --- |\n| 你好 | 🐶 |\n| e\u0301 | a very long cell that wraps |', { color: false, width: 32 });
  const lines = output.trimEnd().split('\n');
  assert.ok(lines.every(line => displayWidth(line) <= 32), output);
  assert.equal(new Set(lines.map(displayWidth)).size, 1, output);
  assert.match(output, /你好/);
  assert.ok(output.includes('a very long'));
});

test('table parser preserves escaped pipes and pipes inside inline code', () => {
  const output = renderMarkdown('| Key | Value |\n| --- | --- |\n| `a|b` | c\\|d |', { color: false });
  assert.ok(output.includes('a|b'));
  assert.ok(output.includes('c|d'));
});

test('plain output has no ANSI and raw mode retains Markdown source', () => {
  const plain = renderMarkdown(sample, { color: false });
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(plain, /Bold and italic/);
  assert.equal(renderMarkdown(sample, { color: false, markdown: false }), sample + '\n');
  assert.equal(inlineMarkdown('file_name_here and \\*literal\\* and ``a ` tick``', false), 'file_name_here and *literal* and a ` tick');
  assert.equal(renderMarkdown('# C#', { color: false }), 'C#\n');
});

test('untrusted terminal commands and colors cannot escape the renderer, including split SSE chunks', () => {
  const hostile = '\x1b[2J\x1b[31mHello\x1b[0m\x1b]52;c;c2VjcmV0\x07\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\\r';
  assert.equal(sanitizeTerminal(hostile), 'Helloclick');
  const renderer = new MarkdownRenderer({ color: false });
  const chunks = [hostile.slice(0, 2), hostile.slice(2, 15), hostile.slice(15)];
  assert.equal(chunks.map(c => renderer.write(c)).join('') + renderer.finish(), 'Helloclick\n');
  assert.doesNotMatch(renderMarkdown('```js\n' + hostile + '\n```'), /\x1b\[2J|\x1b\]52|\x1b\]8/);
});

test('assistant streaming renders once and keeps child replies and billing out of code blocks', () => {
  let output = '';
  const view = new AssistantOutput('root', text => { output += text; }, { color: false, markdown: true });
  const reply = '## Result\n```js\nconst answer = 42;\n```';
  view.delta('root', '## Res');
  view.delta('root', 'ult\n```js\nconst answer = 42;');
  view.complete('child-123', '**Helper** finished');
  view.notice('credits=0.2');
  assert.doesNotMatch(output, /Helper|credits/);
  view.delta('root', '\n```');
  view.complete('root', reply);
  assert.equal(output.match(/const answer/g)?.length, 1);
  assert.ok(output.indexOf('╰─') < output.indexOf('Helper'));
  assert.ok(output.indexOf('Helper') < output.indexOf('credits=0.2'));
});

test('interrupted responses flush readable partial code and deferred output pauses for approvals', () => {
  let output = '';
  const view = new AssistantOutput('root', text => { output += text; }, { color: false }, 'ru');
  view.pause();
  view.delta('root', '```py\nprint("hello")');
  assert.equal(output, '');
  view.finish(true);
  view.resume();
  assert.match(output, /print\("hello"\)\n╰─\n\[Ответ прерван\]/);
  assert.equal(output.match(/print\("hello"\)/g)?.length, 1);
});

test('CLI renders streamed Markdown once, honors raw/pipe modes, and explicitly enables colors', async () => {
  const base = process.env.PUPPY_TEST_TMP;
  if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'markdown-cli-'));
  try {
    const transport = join(root, 'transport.mjs'), envFile = join(root, '.env'), config = join(root, 'config.json');
    await writeFile(envFile, '');
    await writeFile(config, JSON.stringify({ provider: 'test', tmpDir: join(root, 'tmp'), dataDir: join(root, 'data'), providers: { test: { protocol: 'anthropic', auth: 'none', apiKeyEnv: '', model: 'test', baseUrl: 'https://example.com/v1', stream: true, maxTaskCredits: 1 } } }));
    const text = '# Hello\n```ts\nconst answer = 42;\n```\n';
    await writeFile(transport, `
      globalThis.fetch=async()=>{
        const text=${JSON.stringify(text)};
        const events=[{type:'message_start',message:{role:'assistant',content:[],usage:{input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}}];
        for(let i=0;i<text.length;i+=3)events.push({type:'content_block_delta',index:0,delta:{type:'text_delta',text:text.slice(i,i+3)}});
        events.push({type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20},credits_consumed:0.1},{type:'message_stop'});
        return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
      };
    `);
    const cli = async (flags: string[]) => new Promise<string>((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), 'run', 'demo', ...flags], {
        cwd: root, env: { ...process.env, NO_COLOR: '1', PUPPY_ENV_FILE: envFile, PUPPY_PROVIDER: 'test', PUPPY_CONFIG: config, PUPPY_TMP_DIR: join(root, 'tmp'), NODE_OPTIONS: `--import=${pathToFileURL(transport).href}` }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      child.on('error', reject); child.on('close', code => code === 0 ? resolveResult(output) : reject(new Error(output)));
    });
    const rich = await cli(['--color']);
    assert.match(rich, /\x1b\[1;36mHello/);
    assert.match(rich, /\x1b\[1;34mconst/);
    assert.equal(sanitizeTerminal(rich).match(/const answer/g)?.length, 1);
    for (const flags of [[], ['--no-color'], ['--color', '--no-markdown']]) {
      const raw = await cli(flags);
      assert.doesNotMatch(raw, /\x1b/);
      assert.ok(raw.includes(text));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
