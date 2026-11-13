import { readFile, mkdir, realpath, stat, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, Language, PermissionMode, ProviderConfig } from './types.ts';

export const MODES: PermissionMode[] = ['read-only', 'ask', 'workspace-write', 'full-access'];
export const defaults: Config = {
  language: 'en',
  provider: 'kie',
  providers: {
    kie: { protocol: 'anthropic', baseUrl: 'https://api.kie.ai/claude/v1', modelsUrl: 'https://api.kie.ai/anthropic/v1/models', auth: 'bearer', apiKeyEnv: 'KIE_API_KEY', model: 'claude-opus-5-5', stream: true, promptCache: 'off', maxTaskCredits: 10 },
  },
  tmpDir: '', dataDir: '~/.local/share/puppy-agent', permissionMode: 'ask',
  maxSteps: 40, maxPackCalls: 80, maxChildren: 6, maxParallelChildren: 3, maxDepth: 2,
  maxOutputTokens: 4096, contextBudgetTokens: 48000, requestTimeoutMs: 120000,
  commandTimeoutMs: 60000, maxToolOutputChars: 24000,
  instructions: '', instructionFiles: [],
};
export function expandPath(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}
export function configPath(): string {
  return resolve(expandPath(process.env.PUPPY_CONFIG || '~/.config/puppy-agent/config.json'));
}
export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must be a JSON object.');
  const cfg = { ...defaults, ...raw } as Config;
  if (!['en', 'ru'].includes(cfg.language)) throw new Error('config.language must be en or ru.');
  for (const key of ['provider', 'tmpDir', 'dataDir', 'instructions'] as const) {
    if (typeof cfg[key] !== 'string') throw new Error(`Invalid config.${key}`);
  }
  if (!cfg.tmpDir || !isAbsolute(expandPath(cfg.tmpDir))) throw new Error('Set config.tmpDir to an absolute, writable directory. No temp fallback is used.');
  if (!isAbsolute(expandPath(cfg.dataDir))) throw new Error('config.dataDir must be absolute (or start with ~/).');
  cfg.tmpDir = expandPath(cfg.tmpDir);
  cfg.dataDir = expandPath(cfg.dataDir);
  if (!MODES.includes(cfg.permissionMode)) throw new Error('Invalid permissionMode.');
  if (!Array.isArray(cfg.instructionFiles) || cfg.instructionFiles.some(p => typeof p !== 'string')) throw new Error('Invalid instructionFiles.');
  for (const key of ['maxSteps', 'maxPackCalls', 'maxChildren', 'maxParallelChildren', 'maxDepth', 'maxOutputTokens', 'contextBudgetTokens', 'requestTimeoutMs', 'commandTimeoutMs', 'maxToolOutputChars'] as const) {
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 1) throw new Error(`config.${key} must be a positive integer.`);
  }
  if (cfg.contextBudgetTokens < cfg.maxOutputTokens * 2) throw new Error('contextBudgetTokens must be at least twice maxOutputTokens.');
  if (!cfg.providers || typeof cfg.providers !== 'object' || Array.isArray(cfg.providers) || !cfg.providers[cfg.provider]) throw new Error('Selected provider is missing.');
  for (const [name, p] of Object.entries(cfg.providers)) validateProvider(name, p);
  return cfg;
}
function validateProvider(name: string, p: ProviderConfig): void {
  if (!p || !['anthropic', 'openai-chat'].includes(p.protocol) || !['bearer', 'x-api-key', 'none'].includes(p.auth) || typeof p.model !== 'string' || typeof p.apiKeyEnv !== 'string') throw new Error(`Invalid provider ${name}.`);
  if (p.stream !== undefined && typeof p.stream !== 'boolean') throw new Error(`Provider ${name}: stream must be boolean.`);
  if (p.maxTaskCredits !== undefined && (typeof p.maxTaskCredits !== 'number' || !Number.isFinite(p.maxTaskCredits) || p.maxTaskCredits <= 0)) throw new Error(`Provider ${name}: maxTaskCredits must be a positive number.`);
  if (p.stream && p.protocol !== 'anthropic') throw new Error(`Provider ${name}: streaming currently requires the anthropic protocol.`);
  if (p.promptCache !== undefined && !['off', '5m', '1h'].includes(p.promptCache)) throw new Error(`Provider ${name}: invalid promptCache.`);
  if (p.promptCache && p.promptCache !== 'off' && p.protocol !== 'anthropic') throw new Error(`Provider ${name}: promptCache requires the anthropic protocol.`);
  if (p.pricing !== undefined) {
    if (!p.pricing || typeof p.pricing !== 'object' || Array.isArray(p.pricing)) throw new Error(`Provider ${name}: invalid pricing.`);
    for (const [key, value] of Object.entries(p.pricing)) {
      if (['source', 'asOf'].includes(key)) { if (typeof value !== 'string') throw new Error(`Invalid pricing.${key}`); }
      else if (!['inputUsdPerMTok', 'outputUsdPerMTok', 'cacheReadUsdPerMTok', 'cacheWrite5mUsdPerMTok', 'cacheWrite1hUsdPerMTok', 'usdPerCredit'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid pricing.${key}`);
    }
  }
  validateProviderUrl(p.baseUrl, name);
  if (p.modelsUrl !== undefined) {
    validateProviderUrl(p.modelsUrl, name);
    if (new URL(p.modelsUrl).origin !== new URL(p.baseUrl).origin) throw new Error(`Provider ${name}: modelsUrl must have the same origin as baseUrl.`);
  }
}
function validateProviderUrl(value: string, name: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error(`Provider ${name}: put credentials in environment variables, not the URL.`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error(`Provider ${name} requires HTTPS (except localhost).`);
}
export async function loadConfig(tmpDir = process.env.PUPPY_TMP_DIR): Promise<Config> {
  try {
    const raw: unknown = JSON.parse(await readFile(configPath(), 'utf8'));
    if (tmpDir !== undefined && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      (raw as Record<string, unknown>).tmpDir = tmpDir;
    }
    return validateConfig(raw);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No config at ${configPath()}. Run: npm start -- init (set PUPPY_TMP_DIR in .env or pass --tmp /absolute/temp/path).`);
    throw error;
  }
}
export async function initConfig(tmpDir = process.env.PUPPY_TMP_DIR || '', language: Language = 'en'): Promise<string> {
  if (!tmpDir) throw new Error('Set PUPPY_TMP_DIR in .env or pass --tmp /absolute/temp/path.');
  const cfg = validateConfig({ ...defaults, tmpDir, language });
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}
export async function prepareRuntime(cfg: Config): Promise<string> {
  // Do not create a missing external mount point on the internal disk.
  for (const path of [cfg.tmpDir, cfg.dataDir]) {
    if (path.startsWith('/Volumes/')) {
      const volume = '/' + path.split('/').slice(1, 3).join('/');
      if (!(await stat(volume).catch(() => null))?.isDirectory()) throw new Error(`Volume unavailable: ${volume}`);
      if ((await stat(volume)).dev === (await stat('/Volumes')).dev) throw new Error(`Volume is not mounted: ${volume}`);
    }
  }
  await mkdir(cfg.dataDir, { recursive: true, mode: 0o700 });
  await chmod(cfg.dataDir, 0o700);
  await mkdir(cfg.tmpDir, { recursive: true, mode: 0o700 });
  const taskTmp = join(await realpath(cfg.tmpDir), `run-${randomUUID()}`);
  await mkdir(taskTmp, { mode: 0o700 });
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = taskTmp;
  return taskTmp;
}
