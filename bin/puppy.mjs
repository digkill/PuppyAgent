#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  console.error('Puppy Agent requires Node.js 22.15 or newer.');
  process.exit(1);
}
// Run TypeScript natively, retaining the caller's working directory and environment.
const compiled = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const entry = existsSync(compiled) ? [compiled] : ['--experimental-strip-types', fileURLToPath(new URL('../src/cli.ts', import.meta.url))];
const child = spawn(process.execPath, [...entry, ...process.argv.slice(2)], { stdio: 'inherit' });
// Terminal signals reach both processes; keep the wrapper alive while the agent saves progress.
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGINT'));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
