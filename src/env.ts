import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

/** Load Puppy's own .env, independent of the repository selected with --cwd. */
export function loadEnvironment(path = fileURLToPath(new URL('../.env', import.meta.url))): void {
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
