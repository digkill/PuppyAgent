import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';

/** Load Puppy's own .env, independent of the repository selected with --cwd. */
export function userEnvPath(): string { return join(homedir(), '.config', 'puppy-agent', '.env'); }
export function loadEnvironment(path?: string): void {
  if (path === undefined) {
    if (process.env.PUPPY_ENV_FILE) { loadEnvironment(process.env.PUPPY_ENV_FILE); return; }
    loadEnvironment(fileURLToPath(new URL('../.env', import.meta.url)));
    // A global install follows the original checkout's .env while it still exists.
    // The protected user-level copy remains a fallback if the checkout is removed.
    try {
      const record = JSON.parse(readFileSync(join(dirname(userEnvPath()), 'install.json'), 'utf8'));
      if (typeof record.sourceDirectory === 'string' && isAbsolute(record.sourceDirectory)) loadEnvironment(join(record.sourceDirectory, '.env'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new Error('Unable to read Puppy installation settings.');
    }
    loadEnvironment(userEnvPath());
    return;
  }
  try {
    // Node preserves values already supplied by the parent process.
    loadEnvFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Do not include parser errors or file contents: they could contain credentials.
      throw new Error(`Unable to load Puppy Agent .env (${code || 'unknown error'}).`);
    }
  }
}
