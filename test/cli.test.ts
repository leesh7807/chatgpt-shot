import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShotError } from '../src/errors.js';
import { parseCli } from '../src/cli.js';

const cli = (args: string[], configHome: string) => spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: configHome } });

test('global help works before configuration is loaded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-cli-'));
  try {
    for (const flag of ['--help', '-h']) {
      const result = cli([flag], directory);
      assert.equal(result.status, 0); assert.match(result.stdout, /Usage: chatgpt-shot/); assert.equal(result.stderr, '');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('command help is local-only, including submit help', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-cli-'));
  try {
    for (const flag of ['--help', '-h']) {
      const result = cli(['submit', flag], directory);
      assert.equal(result.status, 0); assert.equal(result.stdout, 'Usage: chatgpt-shot submit "<prompt>"\n'); assert.equal(result.stderr, '');
    }
    const configHelp = cli(['config', '--help'], directory);
    assert.equal(configHelp.status, 0); assert.match(configHelp.stdout, /Usage: chatgpt-shot config/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('submit accepts one positional prompt exactly and preserves it', () => {
  assert.deepEqual(parseCli(['submit', 'review this']), { kind: 'command', command: 'submit', rest: ['review this'], prompt: 'review this' });
  for (const args of [['submit'], ['submit', 'review', 'this'], ['submit', '']]) {
    assert.throws(() => parseCli(args), (error: unknown) => error instanceof ShotError && error.code === 'CONFIG_INVALID' && error.message === 'Usage: chatgpt-shot submit "<prompt>"');
  }
});

test('submit rejects missing or multiple positional prompts before configuration is loaded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-cli-'));
  try {
    for (const args of [['submit'], ['submit', 'review', 'this']]) {
      const result = cli(args, directory);
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'CONFIG_INVALID: Usage: chatgpt-shot submit "<prompt>"\n');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
