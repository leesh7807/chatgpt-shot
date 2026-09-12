import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

test('every public command has local help on both supported flags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-cli-'));
  const expected = new Map([
    ['config', /Usage:\n  chatgpt-shot config\n  chatgpt-shot config path\n  chatgpt-shot config show\n  chatgpt-shot config set KEY VALUE/],
    ['init', /Usage: chatgpt-shot init\n\nCreate or validate/],
    ['login', /Usage: chatgpt-shot login\n\nOpen the dedicated Chrome profile/],
    ['doctor', /Usage: chatgpt-shot doctor\n\nCheck configuration/],
    ['start', /Usage: chatgpt-shot start\n\nStart the local Service/],
    ['status', /Usage: chatgpt-shot status\n\nReport whether/],
    ['port', /Usage: chatgpt-shot port\n\nPrint the port/],
    ['submit', /Usage: chatgpt-shot submit "<prompt>"\n\nSubmit exactly one non-empty prompt/],
    ['stop', /Usage: chatgpt-shot stop\n\nStop the local Service/]
  ]);
  try {
    for (const [command, usage] of expected) {
      for (const flag of ['--help', '-h']) {
        const result = cli([command, flag], directory);
        assert.equal(result.status, 0, `${command} ${flag}`);
        assert.match(result.stdout, usage, `${command} ${flag}`);
        assert.equal(result.stderr, '', `${command} ${flag}`);
      }
    }
    assert.match(cli(['config', '--help'], directory).stdout, /config path[\s\S]*config show[\s\S]*config set KEY VALUE/);
    assert.match(cli(['submit', '--help'], directory).stdout, /chatgpt-shot submit "<prompt>"[\s\S]*exactly one non-empty prompt/);
    assert.equal(existsSync(join(directory, 'chatgpt-shot')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('help tokens resolve to their scope and are not submit prompts', () => {
  assert.deepEqual(parseCli(['--help']), { kind: 'help', scope: 'global' });
  for (const command of ['config', 'init', 'login', 'doctor', 'start', 'status', 'port', 'submit', 'stop'] as const) {
    for (const flag of ['--help', '-h']) assert.deepEqual(parseCli([command, flag]), { kind: 'help', scope: command });
  }
  assert.deepEqual(parseCli(['submit', '--help']), { kind: 'help', scope: 'submit' });
  assert.deepEqual(parseCli(['submit', '-h']), { kind: 'help', scope: 'submit' });
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
