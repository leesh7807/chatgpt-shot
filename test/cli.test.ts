import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShotError } from '../src/errors.js';
import { parseCli } from '../src/cli.js';

const cli = (args: string[], configHome: string, extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: configHome, ...extraEnv } });

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
    ['open', /Usage: chatgpt-shot open\n\nOpen the retained Chrome profile/],
    ['doctor', /Usage: chatgpt-shot doctor\n\nCheck configuration/],
    ['start', /Usage: chatgpt-shot start\n\nStart the local Service/],
    ['status', /Usage: chatgpt-shot status\n\nReport whether/],
    ['port', /Usage: chatgpt-shot port\n\nPrint the port/],
    ['submit', /Usage: chatgpt-shot submit \[--diagnostics\] \[--observe-approval\] "<prompt>"\n\nSubmit exactly one non-empty prompt and print its accepted Job UUID/],
    ['jobs', /Usage:\n  chatgpt-shot jobs[\s\S]*current State, Result, or Error/],
    ['attempts', /Usage:\n  chatgpt-shot attempts[\s\S]*latest 100 local submission diagnostic trails/],
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
    assert.match(cli(['submit', '--help'], directory).stdout, /chatgpt-shot submit \[--diagnostics\] \[--observe-approval\] "<prompt>"[\s\S]*exactly one non-empty prompt/);
    assert.equal(existsSync(join(directory, 'chatgpt-shot')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('help tokens resolve to their scope and are not submit prompts', () => {
  assert.deepEqual(parseCli(['--help']), { kind: 'help', scope: 'global' });
  for (const command of ['config', 'init', 'open', 'doctor', 'start', 'status', 'port', 'submit', 'jobs', 'attempts', 'stop'] as const) {
    for (const flag of ['--help', '-h']) assert.deepEqual(parseCli([command, flag]), { kind: 'help', scope: command });
  }
  assert.deepEqual(parseCli(['submit', '--help']), { kind: 'help', scope: 'submit' });
  assert.deepEqual(parseCli(['submit', '-h']), { kind: 'help', scope: 'submit' });
});

test('submit accepts one positional prompt exactly and preserves it', () => {
  assert.deepEqual(parseCli(['submit', 'review this']), { kind: 'command', command: 'submit', rest: ['review this'], prompt: 'review this' });
  assert.deepEqual(parseCli(['submit', '--diagnostics', 'review this']), { kind: 'command', command: 'submit', rest: ['--diagnostics', 'review this'], prompt: 'review this', diagnostics: true });
  assert.deepEqual(parseCli(['submit', '--observe-approval', '--diagnostics', 'review this']), { kind: 'command', command: 'submit', rest: ['--observe-approval', '--diagnostics', 'review this'], prompt: 'review this', diagnostics: true, observeApproval: true });
  for (const args of [['submit'], ['submit', 'review', 'this'], ['submit', ''], ['submit', '--wait'], ['submit', '--diagnostics'], ['submit', '--observe-approval']]) {
    assert.throws(() => parseCli(args), (error: unknown) => error instanceof ShotError && error.code === 'CONFIG_INVALID' && error.message === 'Usage: chatgpt-shot submit [--diagnostics] [--observe-approval] "<prompt>"');
  }
});

test('attempts accepts an optional version 4 Job UUID only', () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  assert.deepEqual(parseCli(['attempts']), { kind: 'command', command: 'attempts', rest: [] });
  assert.deepEqual(parseCli(['attempts', id]), { kind: 'command', command: 'attempts', rest: [id] });
  assert.throws(() => parseCli(['attempts', 'not-a-uuid']), (error: any) => error.code === 'CONFIG_INVALID');
});

test('attempts reads local diagnostics without requiring a Notion configuration', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-attempts-config-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-attempts-cache-'));
  try {
    const result = cli(['attempts'], configHome, { XDG_CACHE_HOME: cacheHome });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { attempts: [] });
    assert.equal(result.stderr, '');
  } finally { rmSync(configHome, { recursive: true, force: true }); rmSync(cacheHome, { recursive: true, force: true }); }
});

test('submit rejects missing or multiple positional prompts before configuration is loaded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-cli-'));
  try {
    for (const args of [['submit'], ['submit', 'review', 'this'], ['submit', '--wait'], ['submit', '--diagnostics']]) {
      const result = cli(args, directory);
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'CONFIG_INVALID: Usage: chatgpt-shot submit [--diagnostics] [--observe-approval] "<prompt>"\n');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
