import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvironment } from '../src/env.ts';

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
