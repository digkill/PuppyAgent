import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { realpath, stat, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configPath, initConfig, loadConfig, MODES, prepareRuntime } from './config.ts';
import { Store } from './store.ts';
import { PuppyAgent } from './agent.ts';
import { HttpProvider } from './provider.ts';
import { helpText, language, t } from './i18n.ts';
import { renderMascot } from './mascot.ts';
import { summarizeUsage, usageText } from './usage.ts';
import { loadEnvironment } from './env.ts';
import type { Language, PermissionMode, Session } from './types.ts';
import type { PermissionRequest } from './permissions.ts';

// Do not allow model/file output to inject terminal escape sequences or carriage returns.
function printable(value: string): string { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
function print(text: string): void { stdout.write(printable(text) + '\n'); }
function mode(value: string): PermissionMode {
  if (!MODES.includes(value as PermissionMode)) throw new Error(`Unknown permission mode: ${value}`);
  return value as PermissionMode;
}
async function directory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${canonical}`);
  return canonical;
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, tmp: { type: 'string' }, cwd: { type: 'string' },
      provider: { type: 'string' }, permission: { type: 'string' },
      language: { type: 'string' },
      'no-banner': { type: 'boolean' },
      json: { type: 'boolean' }, 'run-id': { type: 'string' },
      new: { type: 'boolean' }, last: { type: 'boolean' }, here: { type: 'boolean' },
    },
  });
  const requestedLanguage = values.language ? language(values.language) : undefined;
  if (values.help) { print(helpText(requestedLanguage || 'en')); return; }
  loadEnvironment();
  const command = positionals[0] || 'chat';
  if (command === 'init') {
    const lang = requestedLanguage || 'en';
    print(`${t(lang, 'created')} ${await initConfig(values.tmp, lang)}\n${t(lang, 'configure')}`);
    return;
  }
  if (command === 'config') { print(configPath()); return; }
  if (!['models', 'chat', 'run', 'resume', 'sessions', 'usage'].includes(command)) throw new Error(`Unknown command: ${command}\n${helpText(requestedLanguage || 'en')}`);
  const cfg = await loadConfig(values.tmp);
  if (requestedLanguage) cfg.language = requestedLanguage;
  if (values.provider) {
    if (!cfg.providers[values.provider]) throw new Error('Unknown provider.');
    cfg.provider = values.provider;
  }
  if (values.permission) cfg.permissionMode = mode(values.permission);
  if (command === 'models') {
    const provider = new HttpProvider(cfg.providers[cfg.provider], cfg.requestTimeoutMs);
    const models = await provider.models();
    print(models.join('\n') || t(cfg.language, 'noModels'));
    return;
  }
  const tmpDir = await prepareRuntime(cfg);
  let store: Store | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  let active: PuppyAgent | undefined;
  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  let approvalQueue = Promise.resolve();
  try {
    const dbPath = join(cfg.dataDir, 'sessions.sqlite');
    store = new Store(dbPath);
    await chmod(dbPath, 0o600);
    const db = store;
    const initialCwd = await directory(values.cwd || process.cwd());
    if (command === 'sessions') { listSessions(db, cfg.language, values.here ? initialCwd : undefined); return; }
    if (command === 'usage') {
      const selected = positionals[1] ? db.get(positionals[1]) : db.list(values.here ? initialCwd : undefined)[0];
      if (!selected) throw new Error(t(cfg.language, 'noSession'));
      const records = db.requests(selected.id, values['run-id']);
      print(values.json ? JSON.stringify({ sessionId: selected.id, latestTask: db.latestTask(selected.id), summary: summarizeUsage(records), requests: records }, null, 2) : usageText(records, cfg.language === 'ru'));
      return;
    }
    const createSession = (cwd: string): Session => db.create({ cwd, provider: cfg.provider, model: cfg.providers[cfg.provider].model, permissionMode: cfg.permissionMode, language: cfg.language });
    let session: Session;
    if (command === 'resume') {
      if (values.provider) throw new Error('Resume uses its saved provider/model. Start a new session to change provider.');
      const saved = positionals[1] ? db.get(positionals[1]) : db.list(values.here ? initialCwd : undefined)[0];
      if (!saved) throw new Error(t(cfg.language, 'noSession'));
      session = saved;
    } else if (command === 'chat' && !values.new && !values.provider) {
      session = db.list(initialCwd)[0] || createSession(initialCwd);
    } else session = createSession(initialCwd);
    await directory(session.cwd); // Fail clearly if the saved directory was removed or unmounted.
    if (values.permission) db.update(session.id, { permissionMode: cfg.permissionMode });
    if (requestedLanguage) db.update(session.id, { language: requestedLanguage });
    session = db.get(session.id);
    const onInterrupt = () => { if (active) { active.cancel(); print('\n' + t(session.language, 'stopping')); } else rl?.close(); };
    if (interactive) {
      rl = createInterface({ input: stdin, output: stdout, terminal: true });
      rl.on('SIGINT', onInterrupt);
    } else process.on('SIGINT', onInterrupt);
    const ask = async (request: PermissionRequest): Promise<boolean> => {
      if (!rl) { print(`${t(session.language, 'approvalDenied')}: ${request.action} ${request.target}`); return false; }
      let allowed = false;
      const next = approvalQueue.then(async () => {
        try {
          const answer = await rl!.question(printable(`\n${t(session.language, 'allow')} ${request.action}: ${request.target}${request.detail ? '\n' + request.detail : ''}\n${t(session.language, 'yesNo')} `), { signal: active?.controller.signal });
          allowed = /^(y|yes|да)$/i.test(answer.trim());
        } catch { allowed = false; }
      });
      approvalQueue = next.catch(() => {});
      await next;
      return allowed;
    };
    const makeAgent = () => {
      let streamedText = '';
      return new PuppyAgent({ config: cfg, store: db, tmpDir, approve: ask, emit: event => {
      const detail = event.detail as Record<string, unknown>;
      const prefix = event.sessionId === session.id ? '🐶' : `🐾 ${event.sessionId.slice(0, 8)}`;
      if (event.type === 'text_delta' && event.sessionId === session.id) {
        if (!streamedText) stdout.write(`\n${prefix} `);
        streamedText += String(detail.text);
        stdout.write(printable(String(detail.text)));
      }
      if (event.type === 'assistant') {
        if (event.sessionId === session.id && streamedText === detail.text) print('');
        else print(`\n${prefix} ${detail.text}`);
        if (event.sessionId === session.id) streamedText = '';
      }
      if (event.type === 'usage') {
        const tokens = detail.usage as Record<string, unknown>;
        print(`\n${prefix} cache read=${tokens.cacheReadInputTokens ?? '?'} write=${tokens.cacheCreationInputTokens ?? '?'} · credits=${detail.creditsConsumed ?? '?'} · task=${detail.taskCredits}/${detail.creditLimit ?? '∞'}`);
      }
      if (event.type === 'tool_start') print(`${prefix} → ${detail.name}`);
      if (event.type === 'puppy_spawned') print(`${prefix} ${t(session.language, 'helper')} ${detail.name}: ${detail.id}`);
      if (event.type === 'recovery') print(`${prefix} ${t(session.language, 'recovered')}`);
      } });
    };
    const run = async (prompt?: string, resumeTask = false) => {
      active = makeAgent();
      try { await active.run(session.id, prompt, resumeTask); }
      catch (error) { print(`🐶 ${(error as Error).message}`); if (command === 'run') process.exitCode = 1; }
      finally { active = undefined; session = db.get(session.id); }
    };
    if (interactive && command !== 'run' && !values['no-banner']) {
      stdout.write(renderMascot({ language: session.language, columns: stdout.columns, color: !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' }));
    }
    showStatus(session, tmpDir);
    if (command === 'run') {
      const task = positionals.slice(1).join(' ');
      if (!task.trim()) throw new Error('Usage: npm start -- run "task"');
      await run(task);
      return;
    }
    if (!rl) throw new Error(t(session.language, 'terminalRequired'));
    print(t(session.language, 'welcome'));
    while (true) {
      let line: string;
      try { line = (await rl.question(`\n${t(session.language, 'you')} › `)).trim(); }
      catch { break; }
      if (!line) continue;
      if (!line.startsWith('/')) { await run(line); continue; }
      const space = line.indexOf(' ');
      const name = space === -1 ? line : line.slice(0, space);
      const argument = space === -1 ? '' : line.slice(space + 1).trim();
      try {
        if (name === '/exit' || name === '/quit') break;
        switch (name) {
          case '/help': print(helpText(session.language)); break;
          case '/status': showStatus(db.get(session.id), tmpDir); break;
          case '/sessions': listSessions(db, session.language); break;
          case '/resume': {
            if (!argument) throw new Error('Usage: /resume SESSION_ID');
            const target = db.get(argument);
            await directory(target.cwd);
            session = target;
            showStatus(session, tmpDir); break;
          }
          case '/new': session = createSession(session.cwd); showStatus(session, tmpDir); break;
          case '/cd': {
            if (!argument) throw new Error('Usage: /cd PATH');
            const cwd = await directory(resolve(session.cwd, argument));
            // A user-selected directory starts a new workspace session. An agent's change_directory keeps its original boundary.
            session = db.list(cwd)[0] || createSession(cwd);
            showStatus(session, tmpDir); break;
          }
          case '/permissions':
            if (!argument) { print(session.permissionMode); break; }
            db.update(session.id, { permissionMode: mode(argument) });
            session = db.get(session.id); showStatus(session, tmpDir); break;
          case '/language':
            if (argument) db.update(session.id, { language: language(argument) });
            session = db.get(session.id);
            cfg.language = session.language;
            print(t(session.language, 'languageSet')); break;
          case '/continue': await run('Continue the current task. Inspect uncertain outcomes before repeating interrupted actions.', true); break;
          case '/usage': {
            const records = db.requests(session.id);
            print(argument === 'json' ? JSON.stringify({ sessionId: session.id, latestTask: db.latestTask(session.id), summary: summarizeUsage(records), requests: records }, null, 2) : usageText(records, session.language === 'ru'));
            break;
          }
          case '/compact': {
            const owner = `compact-${process.pid}`;
            db.acquire(session.id, owner);
            const heartbeat = setInterval(() => {
              try { db.renew(session.id, owner); } catch { active?.cancel(); }
            }, 10000);
            heartbeat.unref();
            active = makeAgent();
            try { print(t(session.language, await active.compact(db.get(session.id), active.provider(session), true) ? 'summarized' : 'noCompaction')); }
            finally { clearInterval(heartbeat); active = undefined; db.release(session.id, owner); }
            break;
          }
          case '/memory': print(JSON.stringify({ global: db.memory('global'), project: db.memory(`project:${session.workspace}`), session: db.memory(`session:${session.id}`) }, null, 2)); break;
          case '/remember': {
            const separator = argument.indexOf(' ');
            if (separator < 1) throw new Error('Usage: /remember KEY VALUE (project memory)');
            db.remember(`project:${session.workspace}`, argument.slice(0, separator), argument.slice(separator + 1)); print(t(session.language, 'memorySaved')); break;
          }
          case '/forget': db.forget(`project:${session.workspace}`, argument); print(t(session.language, 'memoryRemoved')); break;
          default: print(t(session.language, 'unknownCommand'));
        }
      } catch (error) { print(`🐶 ${(error as Error).message}`); }
    }
    process.removeListener('SIGINT', onInterrupt);
  } finally {
    active?.cancel();
    if (active) await active.drain();
    rl?.close();
    store?.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}
function listSessions(store: Store, lang: Language, cwd?: string): void {
  const sessions = store.list(cwd);
  print(sessions.map(s => `${s.id}  ${s.status.padEnd(11)}  ${s.title}\n  ${s.cwd}`).join('\n') || t(lang, 'noSessions'));
}
function showStatus(session: Session, tmpDir: string): void {
  print(`🐶 Puppy Agent · ${session.id}\n${session.cwd}\n${session.provider} / ${session.model || t(session.language, 'modelMissing')} · ${session.permissionMode}\n${t(session.language, 'tokens')}: ${session.inputTokens} in / ${session.outputTokens} out · tmp: ${tmpDir}`);
  if (session.permissionMode === 'full-access') print(t(session.language, 'fullAccess'));
}

main().catch(error => { print(`🐶 ${(error as Error).message}`); process.exitCode = 1; });
