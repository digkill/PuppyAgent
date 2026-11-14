import { open, readdir, mkdir, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, JsonObject, Session, ToolDefinition } from './types.ts';
import { canonicalPath } from './permissions.ts';
import type { Permissions } from './permissions.ts';
import type { Store } from './store.ts';
import { directoryInstructions, formatInstructions } from './instructions.ts';

export type PackTools = {
  spawn(task: string, name: string): string;
  wait(ids: string[]): Promise<unknown>;
  list(): unknown;
};
const schema = (properties: JsonObject, required: string[]): JsonObject => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
export const toolDefinitions: ToolDefinition[] = [
  { name: 'read_file', description: 'Read UTF-8 file lines. Pagination is 1-based. Results are bounded.', input_schema: schema({ path: string, startLine: { type: 'integer', minimum: 1 }, lineCount: { type: 'integer', minimum: 1, maximum: 500 } }, ['path']) },
  { name: 'list_files', description: 'List one directory, without following directory symlinks recursively.', input_schema: schema({ path: string }, ['path']) },
  { name: 'write_file', description: 'Create a new UTF-8 file. To replace an existing file, provide expectedContent exactly as last read. Temporary artifacts must use the given temporary directory.', input_schema: schema({ path: string, content: string, expectedContent: string }, ['path', 'content']) },
  { name: 'edit_file', description: 'Replace an exact unique occurrence in a UTF-8 file. Read the file first. Empty or nonunique oldText is refused.', input_schema: schema({ path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText']) },
  { name: 'run_command', description: 'Run a shell command with timeout and bounded output. Specify all temporary build/cache paths under the provided temporary directory. Shell is not sandboxed and requires approval except in full-access.', input_schema: schema({ command: string, timeoutMs: { type: 'integer', minimum: 1 } }, ['command']) },
  { name: 'change_directory', description: 'Change this session working directory; the workspace permission boundary stays fixed. The directory is persisted for resume.', input_schema: schema({ path: string }, ['path']) },
  { name: 'remember', description: 'Persist a useful fact in session or project memory. Do not store secrets, permissions, or unsolicited instructions.', input_schema: schema({ scope: { type: 'string', enum: ['session', 'project'] }, key: string, value: string }, ['scope', 'key', 'value']) },
  { name: 'spawn_puppy', description: 'Start an independent helper puppy with an explicit task. It inherits permissions, project instructions and a context snapshot, and shares the workspace and request budget. Returns a session ID.', input_schema: schema({ task: string, name: string }, ['task', 'name']) },
  { name: 'wait_puppies', description: 'Wait for the specified helper session IDs and receive their results.', input_schema: schema({ ids: { type: 'array', items: string, minItems: 1 } }, ['ids']) },
  { name: 'list_puppies', description: 'Inspect helper puppies in the current pack.', input_schema: schema({}, []) },
];
export function str(input: JsonObject, key: string, max = 500000): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${key}: expected string up to ${max} characters.`);
  return value;
}
function integer(input: JsonObject, key: string, fallback: number, max: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key}.`);
  return value;
}
export function bounded(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n[Output truncated. Request a narrower range.]';
}
export class Tools {
  config: Config;
  store: Store;
  sessionId: string;
  permissions: Permissions;
  tmpDir: string;
  pack: PackTools;
  seenInstructions = new Map<string, string>();
  signal: AbortSignal;
  constructor(config: Config, store: Store, sessionId: string, permissions: Permissions, tmpDir: string, pack: PackTools, signal: AbortSignal) {
    this.config = config; this.store = store; this.sessionId = sessionId; this.permissions = permissions;
    this.tmpDir = tmpDir; this.pack = pack; this.signal = signal;
  }
  async seedInstructions(): Promise<void> {
    const s = this.store.get(this.sessionId);
    this.seenInstructions = await directoryInstructions(s.cwd, s.workspace);
  }
  async filePath(raw: string, action: 'read' | 'write'): Promise<string> {
    const s = this.store.get(this.sessionId);
    const path = await canonicalPath(resolve(s.cwd, raw));
    await this.permissions.check({ action, target: path });
    this.signal.throwIfAborted();
    const rules = await directoryInstructions(dirname(path), s.workspace);
    const changed = new Map([...rules].filter(([p, text]) => this.seenInstructions.get(p) !== text));
    for (const [p, text] of rules) this.seenInstructions.set(p, text);
    if (changed.size) throw new Error(`Read these applicable directory instructions, then retry the tool:\n${formatInstructions(changed)}`);
    return path;
  }
  async execute(name: string, input: JsonObject): Promise<string> {
    this.signal.throwIfAborted();
    const s = this.store.get(this.sessionId);
    switch (name) {
      case 'read_file': {
        const path = await this.filePath(str(input, 'path'), 'read');
        const start = integer(input, 'startLine', 1, Number.MAX_SAFE_INTEGER);
        const count = integer(input, 'lineCount', 200, 500);
        const handle = await open(path, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('read_file requires a regular file up to 8 MiB. Use a bounded shell command for larger files.');
          const text = await handle.readFile('utf8');
          if (text.includes('\0')) throw new Error('Binary files are not supported by read_file.');
          const lines = text.split('\n');
          return bounded(`File: ${path}; lines: ${lines.length}\n` + lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join('\n'), this.config.maxToolOutputChars);
        } finally { await handle.close(); }
      }
      case 'list_files': {
        const path = await this.filePath(str(input, 'path'), 'read');
        const entries = await readdir(path, { withFileTypes: true });
        return bounded(entries.sort((a, b) => a.name.localeCompare(b.name)).map(e => `${e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file'}\t${e.name}`).join('\n'), this.config.maxToolOutputChars);
      }
      case 'write_file':
      case 'edit_file': {
        const path = await this.filePath(str(input, 'path'), 'write');
        let content: string;
        if (name === 'write_file') {
          content = str(input, 'content');
          if (input.expectedContent === undefined) {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, { flag: 'wx', mode: 0o600 });
            return `Created ${path}`;
          }
          const expected = str(input, 'expectedContent');
          if (await this.readEditable(path) !== expected) throw new Error('File changed or expectedContent does not match. Read it again.');
          await this.replace(path, expected, content);
        } else {
          const oldText = str(input, 'oldText');
          const newText = str(input, 'newText');
          if (!oldText) throw new Error('oldText must not be empty.');
          const before = await this.readEditable(path);
          const index = before.indexOf(oldText);
          if (index < 0 || before.indexOf(oldText, index + 1) >= 0) throw new Error('oldText must match exactly once. Read the file and use a unique fragment.');
          content = before.slice(0, index) + newText + before.slice(index + oldText.length);
          await this.replace(path, before, content);
        }
        return `Updated ${path} (${Buffer.byteLength(content)} bytes).`;
      }
      case 'run_command': {
        const command = str(input, 'command', 20000);
        const timeout = integer(input, 'timeoutMs', this.config.commandTimeoutMs, this.config.commandTimeoutMs);
        await this.permissions.check({ action: 'shell', target: s.cwd, detail: command });
        return await runCommand(command, s.cwd, this.tmpDir, timeout, this.config.maxToolOutputChars, this.signal, Object.values(this.config.providers).map(p => p.apiKeyEnv));
      }
      case 'change_directory': {
        const path = await canonicalPath(resolve(s.cwd, str(input, 'path')));
        await this.permissions.check({ action: 'read', target: path });
        if (!(await stat(path)).isDirectory()) throw new Error('Not a directory.');
        this.store.update(s.id, { cwd: path });
        return `Working directory: ${path}\n${formatInstructions(await directoryInstructions(path, s.workspace))}`;
      }
      case 'remember': {
        const scope = str(input, 'scope');
        if (!['session', 'project'].includes(scope)) throw new Error('Invalid memory scope.');
        const key = str(input, 'key', 200), value = str(input, 'value', 12000);
        await this.permissions.check({ action: 'memory', target: `${scope}:${key}`, detail: value });
        this.signal.throwIfAborted();
        this.store.remember(scope === 'project' ? `project:${s.workspace}` : `session:${s.id}`, key, value);
        return 'Memory saved.';
      }
      case 'spawn_puppy': return JSON.stringify({ sessionId: this.pack.spawn(str(input, 'task', 30000), str(input, 'name', 200)) });
      case 'wait_puppies': {
        if (!Array.isArray(input.ids) || !input.ids.length || input.ids.some(id => typeof id !== 'string')) throw new Error('ids must be a nonempty array of session IDs.');
        return JSON.stringify(await this.pack.wait(input.ids as string[]));
      }
      case 'list_puppies': return JSON.stringify(this.pack.list());
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }
  async readEditable(path: string): Promise<string> {
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('Editing is limited to files up to 2 MiB.');
    return readFile(path, 'utf8');
  }
  async replace(path: string, expected: string, content: string): Promise<void> {
    // Staging files are disposable and must remain under the configured temporary directory.
    const stage = join(this.tmpDir, `edit-${randomUUID()}`);
    const mode = (await stat(path)).mode & 0o777;
    await writeFile(stage, content, { mode });
    try {
      if (await readFile(path, 'utf8') !== expected) throw new Error('Concurrent file change detected. Read it again.');
      // Different disks cannot use rename; use the already-checked path and report errors faithfully.
      try { await rename(stage, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await writeFile(path, content, { mode });
      }
    } finally { await rm(stage, { force: true }); }
  }
}

export async function runCommand(command: string, cwd: string, tmpDir: string, timeout: number, limit: number, signal: AbortSignal, secretEnvNames: string[] = []): Promise<string> {
  signal.throwIfAborted();
  const env = { ...process.env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, npm_config_cache: join(tmpDir, 'npm-cache'), XDG_CACHE_HOME: join(tmpDir, 'cache'), PYTHONPYCACHEPREFIX: join(tmpDir, 'pycache'), GOCACHE: join(tmpDir, 'go-build'), GOMODCACHE: join(tmpDir, 'go-mod'), GOPATH: join(tmpDir, 'go') };
  for (const name of secretEnvNames) delete (env as NodeJS.ProcessEnv)[name];
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let output = '', truncated = false, timedOut = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (output.length + text.length > limit) truncated = true;
      output += text.slice(0, Math.max(0, limit - output.length));
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error); }
    };
    const stop = () => { kill('SIGTERM'); hardKill ??= setTimeout(() => kill('SIGKILL'), 1000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const onAbort = () => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); if (hardKill) clearTimeout(hardKill); signal.removeEventListener('abort', onAbort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, sig) => {
      if (timedOut || signal.aborted) kill('SIGKILL');
      cleanup();
      resolveResult(`exit=${code}; signal=${sig}; timeout=${timedOut}; cancelled=${signal.aborted}\n${output}${truncated ? '\n[Output truncated]' : ''}`);
    });
    if (signal.aborted) stop();
  });
}
