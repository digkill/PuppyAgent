import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, defaults, initConfig, loadConfig, prepareRuntime, validateConfig } from './config.ts';
import { loadEnvironment, userEnvPath } from './env.ts';
import { stripTypeScriptTypes } from 'node:module';
import { homedir } from 'node:os';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
type InstallRecord = { version: string; prefix: string; sourceDirectory: string; repository: string; installedAt: string };
type InstallOptions = { source?: string; prefix?: string; sourceDirectory?: string; repository?: string };
export const settingsEnvPath = () => process.env.PUPPY_ENV_FILE ? resolve(process.env.PUPPY_ENV_FILE) : userEnvPath();
export const installRecordPath = () => join(dirname(settingsEnvPath()), 'install.json');

async function command(program: string, args: string[], cwd: string, capture = false): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd, shell: false, env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (capture) {
      child.stdout!.on('data', b => { output += b; });
      // Keep stderr out of errors: git/npm may include a credential-bearing URL.
      child.stderr!.resume();
    }
    child.on('error', () => reject(new Error(`Cannot start ${program}. Check that it is installed and available in PATH.`)));
    child.on('close', code => code === 0 ? resolveResult(output.trim()) : reject(new Error(`${program} exited with code ${code}.`)));
  });
}
async function manifest(source: string): Promise<{ name: string; version: string; repository?: { url?: string } }> {
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'puppy-agent' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a Puppy Agent package with a stable semantic version.');
  return pkg;
}
export function newerVersion(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid version.');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
async function workDirectory(): Promise<string> {
  const tmpDir = process.env.PUPPY_INSTALL_TMP_DIR || process.env.PUPPY_TMP_DIR || (await loadConfig()).tmpDir;
  const path = await prepareRuntime(validateConfig({ ...defaults, tmpDir, dataDir: dirname(settingsEnvPath()) }));
  process.env.npm_config_cache = join(path, 'npm-cache');
  process.env.npm_config_update_notifier = 'false';
  process.env.GIT_TERMINAL_PROMPT = '0';
  return path;
}
async function preserveEnvironment(source: string): Promise<void> {
  const target = settingsEnvPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (resolve(join(source, '.env')) === resolve(target)) return;
  try { await copyFile(join(source, '.env'), target, constants.COPYFILE_EXCL); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(target, `KIE_API_KEY=\nPUPPY_TMP_DIR=${process.env.PUPPY_TMP_DIR || ''}\nPUPPY_MODEL=${process.env.PUPPY_MODEL || 'claude-opus-5-5'}\nPUPPY_EFFORT=${process.env.PUPPY_EFFORT || 'medium'}\n`, { flag: 'wx', mode: 0o600 });
  }
  await chmod(target, 0o600);
}
export async function buildPackage(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  // Explicit allowlist: a source checkout's .env, databases and dependencies never enter the package.
  for (const name of ['package.json', 'bin', 'README.md', 'README.ru.md', 'puppy.config.example.json', '.env.example', 'assets', 'puppy_agent.py']) {
    try { await cp(join(source, name), join(target, name), { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await chmod(join(target, 'bin', 'puppy.mjs'), 0o755);
  let files: string[];
  try { files = await readdir(join(source, 'src')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
    return;
  }
  await mkdir(join(target, 'dist'), { recursive: true });
  for (const name of files.filter(n => n.endsWith('.ts'))) {
    const raw = await readFile(join(source, 'src', name), 'utf8');
    const code = stripTypeScriptTypes(raw, { mode: 'strip' }).replace(/(['"])(\.{1,2}\/[^'"\n]+)\.ts\1/g, '$1$2.js$1');
    await writeFile(join(target, 'dist', name.replace(/\.ts$/, '.js')), code);
  }
}
export async function installGlobal(options: InstallOptions = {}): Promise<void> {
  const source = await realpath(resolve(options.source || packageRoot));
  const pkg = await manifest(source);
  loadEnvironment(join(source, '.env'));
  const work = await workDirectory();
  try {
    const configuredPrefix = options.prefix || await command('npm', ['prefix', '--global'], source, true);
    const writable = await access(join(configuredPrefix, process.platform === 'win32' ? '' : 'bin'), constants.W_OK).then(() => true, () => false);
    const prefix = resolve(!options.prefix && !writable ? join(homedir(), '.local') : configuredPrefix);
    const stage = join(work, 'package');
    await buildPackage(source, stage);
    const result = JSON.parse(await command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], stage, true));
    const packed = result[0];
    if (!packed || basename(packed.filename) !== packed.filename || !packed.filename.endsWith('.tgz')) throw new Error('Unexpected npm pack result.');
    if (packed.files.some((f: { path: string }) => /(^|\/)\.env($|\.(?!example$))/.test(f.path))) throw new Error('Refusing to install an archive containing a private .env file.');
    await command('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(work, packed.filename)], source);
    await preserveEnvironment(source);
    if (!(await stat(configPath()).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }))) await initConfig(process.env.PUPPY_TMP_DIR || (await loadConfig()).tmpDir);
    const record: InstallRecord = {
      version: pkg.version, prefix, sourceDirectory: options.sourceDirectory || source,
      repository: options.repository || pkg.repository?.url || 'https://github.com/digkill/PuppyAgent.git', installedAt: new Date().toISOString(),
    };
    await writeFile(installRecordPath(), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    console.log(`Puppy Agent ${pkg.version} installed. Created by MediaRise · MediaRise.org`);
    console.log(`Command directory: ${process.platform === 'win32' ? prefix : join(prefix, 'bin')} (must be in PATH)`);
    console.log(`Environment: ${settingsEnvPath()}\nRun: puppy\nUpdate: puppy update`);
  } finally { await rm(work, { recursive: true, force: true }); }
}
export async function updateGlobal(options: { local?: boolean; source?: string; prefix?: string; check?: boolean } = {}): Promise<void> {
  let record: InstallRecord;
  try { record = JSON.parse(await readFile(installRecordPath(), 'utf8')); }
  catch { throw new Error('No installer record. First run: npm run install:global'); }
  if (options.local || options.source) {
    const source = options.source || record.sourceDirectory;
    if (options.check) { console.log(`Installed: ${record.version}; local source: ${(await manifest(source)).version}`); return; }
    await installGlobal({ source, prefix: options.prefix || record.prefix, repository: record.repository });
    return;
  }
  const repository = new URL(record.repository);
  if (repository.protocol !== 'https:' || repository.username || repository.password || repository.search || repository.hash) throw new Error('Updater requires a credential-free HTTPS repository URL.');
  const work = await workDirectory();
  try {
    const source = join(work, 'source');
    await command('git', ['clone', '--quiet', '--depth', '1', repository.toString(), source], work, true);
    const latest = await manifest(source);
    if (!newerVersion(latest.version, record.version)) { console.log(`Already up to date: ${record.version} (repository: ${latest.version}).`); return; }
    if (options.check) { console.log(`Update available: ${record.version} → ${latest.version}`); return; }
    await installGlobal({ source, prefix: options.prefix || record.prefix, sourceDirectory: record.sourceDirectory, repository: record.repository });
  } finally { await rm(work, { recursive: true, force: true }); }
}
