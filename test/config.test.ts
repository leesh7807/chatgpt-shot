import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureConfigFile, paths, readConfigValues, setConfigValue } from '../src/config.js';

test('stores user configuration in XDG config with owner-only permissions', () => {
  const prior = process.env.XDG_CONFIG_HOME; const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-config-'));
  try {
    process.env.XDG_CONFIG_HOME = directory;
    const state = paths(); setConfigValue('NOTION_TOKEN', 'secret', state); setConfigValue('CHATGPT_SHOT_NOTION_DATABASE_URL', 'https://www.notion.so/0123456789abcdef0123456789abcdef', state);
    assert.deepEqual(readConfigValues(state), { NOTION_TOKEN: 'secret', CHATGPT_SHOT_NOTION_DATABASE_URL: 'https://www.notion.so/0123456789abcdef0123456789abcdef' });
    assert.equal(statSync(state.envPath).mode & 0o777, 0o600);
  } finally { if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; rmSync(directory, { recursive: true, force: true }); }
});

test('creates an owner-only commented configuration template', () => {
  const prior = process.env.XDG_CONFIG_HOME; const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-config-'));
  try {
    process.env.XDG_CONFIG_HOME = directory;
    const state = paths(); ensureConfigFile(state);
    const contents = readFileSync(state.envPath, 'utf8');
    assert.match(contents, /# Fill in the two required values below\./);
    assert.match(contents, /NOTION_TOKEN=\nCHATGPT_SHOT_NOTION_DATABASE_URL=\n/);
    assert.match(contents, /# CHATGPT_SHOT_EXECUTION_TIMEOUT_MS=900000/);
    assert.equal(statSync(state.envPath).mode & 0o777, 0o600);
  } finally { if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; rmSync(directory, { recursive: true, force: true }); }
});
