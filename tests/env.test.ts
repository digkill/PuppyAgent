import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvironment } from '../src/env.ts';
import { defaults, initConfig, loadConfig } from '../src/config.ts';

test('.env supplies provider credentials without overriding existing environment values', async () => {
  const base = process.env.PUPPY_TEST_TMP;
  if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'env-'));
  const fromFile = 'PUPPY_ENV_TEST_FROM_FILE', inherited = 'PUPPY_ENV_TEST_INHERITED';
  const saved = [process.env[fromFile], process.env[inherited]];
  try {
    delete process.env[fromFile];
    process.env[inherited] = 'shell-value';
    const path = join(root, '.env');
    await writeFile(path, `${fromFile}="fixture-key"\n${inherited}=file-value\n`);
    loadEnvironment(path);
    assert.equal(process.env[fromFile], 'fixture-key');
    assert.equal(process.env[inherited], 'shell-value');
    assert.doesNotThrow(() => loadEnvironment(join(root, 'missing.env')));
  } finally {
    for (const [i, key] of [fromFile, inherited].entries()) {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('temp configuration uses flag, environment, then config; init needs no --tmp with environment set', async () => {
  const base = process.env.PUPPY_TEST_TMP;
  if (!base) throw new Error('Set PUPPY_TEST_TMP explicitly.');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'env-tmp-'));
  const saved = { config: process.env.PUPPY_CONFIG, tmp: process.env.PUPPY_TMP_DIR };
  try {
    process.env.PUPPY_CONFIG = join(root, 'config.json');
    process.env.PUPPY_TMP_DIR = join(root, 'from-env');
    await initConfig();
    assert.equal(JSON.parse(await readFile(process.env.PUPPY_CONFIG, 'utf8')).tmpDir, process.env.PUPPY_TMP_DIR);
    await writeFile(process.env.PUPPY_CONFIG, JSON.stringify({ ...defaults, tmpDir: join(root, 'from-config') }));
    assert.equal((await loadConfig()).tmpDir, join(root, 'from-env'));
    assert.equal((await loadConfig(join(root, 'from-flag'))).tmpDir, join(root, 'from-flag'));
    delete process.env.PUPPY_TMP_DIR;
    assert.equal((await loadConfig()).tmpDir, join(root, 'from-config'));
    process.env.PUPPY_TMP_DIR = 'relative/path';
    await assert.rejects(loadConfig(), /absolute/);
  } finally {
    if (saved.config === undefined) delete process.env.PUPPY_CONFIG; else process.env.PUPPY_CONFIG = saved.config;
    if (saved.tmp === undefined) delete process.env.PUPPY_TMP_DIR; else process.env.PUPPY_TMP_DIR = saved.tmp;
    await rm(root, { recursive: true, force: true });
  }
});
