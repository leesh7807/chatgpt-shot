import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShotError } from '../src/errors.js';
import { doctor, inspectAttempt, parseCli } from '../src/cli.js';
import { LocalJobTelemetryWriter } from '../src/job-telemetry.js';
import { NotionStore } from '../src/notion.js';

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
    ['doctor', /Usage: chatgpt-shot doctor \[--browser\][\s\S]*without starting a Service or browser/],
    ['start', /Usage: chatgpt-shot start\n\nStart the local Service/],
    ['status', /Usage: chatgpt-shot status\n\nReport whether/],
    ['port', /Usage: chatgpt-shot port\n\nPrint the port/],
    ['submit', /Usage: chatgpt-shot submit \[--diagnostics\] \[--observe-approval\] "<prompt>"\n\nSubmit exactly one non-empty prompt and print its accepted Job UUID/],
    ['jobs', /Usage:\n  chatgpt-shot jobs[\s\S]*current State, Result, or Error/],
    ['attempts', /Usage:\n  chatgpt-shot attempts[\s\S]*latest 100 local submission diagnostic trails/],
    ['inspect', /Usage: chatgpt-shot inspect <uuid>[\s\S]*retry safety/],
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
  for (const command of ['config', 'init', 'open', 'doctor', 'start', 'status', 'port', 'submit', 'jobs', 'attempts', 'inspect', 'stop'] as const) {
    for (const flag of ['--help', '-h']) assert.deepEqual(parseCli([command, flag]), { kind: 'help', scope: command });
  }
  assert.deepEqual(parseCli(['submit', '--help']), { kind: 'help', scope: 'submit' });
  assert.deepEqual(parseCli(['submit', '-h']), { kind: 'help', scope: 'submit' });
  assert.deepEqual(parseCli(['doctor']), { kind: 'command', command: 'doctor', rest: [] });
  assert.deepEqual(parseCli(['doctor', '--browser']), { kind: 'command', command: 'doctor', rest: ['--browser'], doctorBrowser: true });
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

test('inspect accepts exactly one version 4 Attempt UUID', () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  assert.deepEqual(parseCli(['inspect', id]), { kind: 'command', command: 'inspect', rest: [id] });
  for (const args of [['inspect'], ['inspect', 'bad'], ['inspect', id, id]]) assert.throws(() => parseCli(args), (error: any) => error.code === 'CONFIG_INVALID');
  assert.throws(() => parseCli(['doctor', '--active']), (error: any) => error.code === 'CONFIG_INVALID');
});

test('default doctor reports passive capabilities without creating a Service or browser profile', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-config-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-data-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-cache-'));
  try {
    const result = cli(['doctor'], configHome, { XDG_DATA_HOME: dataHome, XDG_CACHE_HOME: cacheHome });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'passive');
    assert.equal(report.checks.service.status, 'absent');
    assert.equal(report.checks.private_browser.status, 'not_checked');
    assert.equal(report.checks.visible_browser.status, 'not_requested');
    assert.equal(report.capabilities.local_diagnostics.status, 'available');
    assert.equal(existsSync(join(dataHome, 'chatgpt-shot', 'chrome-profile')), false);
    assert.equal(existsSync(join(cacheHome, 'chatgpt-shot', 'runtime.json')), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

test('doctor reads Notion when existing Service discovery is unhealthy', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-unhealthy-config-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-unhealthy-data-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-unhealthy-cache-'));
  const envNames = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'] as const;
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousExitCode = process.exitCode;
  const originalDatabase = NotionStore.prototype.database;
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_CACHE_HOME = cacheHome;
    const configDirectory = join(configHome, 'chatgpt-shot');
    const runtimeDirectory = join(cacheHome, 'chatgpt-shot');
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(configDirectory, '.env'), 'NOTION_TOKEN=test-token\nCHATGPT_SHOT_NOTION_DATABASE_URL=https://www.notion.so/workspace/0123456789abcdef0123456789abcdef\n');
    writeFileSync(join(runtimeDirectory, 'runtime.json'), JSON.stringify({ pid: 2_147_483_647, host: '127.0.0.1', port: 1, protocolVersion: 1, credential: 'stale-service' }));
    NotionStore.prototype.database = async function () {
      return { properties: {
        ID: { type: 'title' },
        State: { type: 'select', select: { options: [{ name: 'pending' }, { name: 'in_progress' }, { name: 'completed' }, { name: 'failed' }] } },
        Error: { type: 'rich_text' },
        'Created At': { type: 'created_time' },
        'Updated At': { type: 'last_edited_time' },
      } };
    };

    const report = await doctor(false);

    assert.equal(report.checks.service.status, 'unavailable');
    assert.equal(report.checks.notion.status, 'passed');
    assert.equal(report.capabilities.notion_read.status, 'available');
    assert.equal(existsSync(join(runtimeDirectory, 'runtime.json')), true);
    assert.equal(existsSync(join(dataHome, 'chatgpt-shot', 'chrome-profile')), false);
    assert.equal(process.exitCode, 1);
  } finally {
    NotionStore.prototype.database = originalDatabase;
    process.exitCode = previousExitCode;
    for (const name of envNames) {
      const value = previousEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(configHome, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

test('doctor and inspect retain Notion reads when Service fails after its health check', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-race-config-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-race-data-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-doctor-race-cache-'));
  const envNames = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'] as const;
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousExitCode = process.exitCode;
  const originalDatabase = NotionStore.prototype.database;
  const originalFindInvocation = NotionStore.prototype.findInvocation;
  const id = '01234567-89ab-4def-8123-456789abcdef';
  let databaseReads = 0;
  let invocationReads = 0;
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ pid: process.pid, protocolVersion: 1, accepting: true, state: 'ready' }));
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'SERVICE_STOPPING', message: 'service read failed after health' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_CACHE_HOME = cacheHome;
    const configDirectory = join(configHome, 'chatgpt-shot');
    const runtimeDirectory = join(cacheHome, 'chatgpt-shot');
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(configDirectory, '.env'), 'NOTION_TOKEN=test-token\nCHATGPT_SHOT_NOTION_DATABASE_URL=https://www.notion.so/workspace/0123456789abcdef0123456789abcdef\n');
    writeFileSync(join(runtimeDirectory, 'runtime.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'healthy-then-failing-service' }));
    NotionStore.prototype.database = async function () {
      databaseReads++;
      return { properties: {
        ID: { type: 'title' },
        State: { type: 'select', select: { options: [{ name: 'pending' }, { name: 'in_progress' }, { name: 'completed' }, { name: 'failed' }] } },
        Error: { type: 'rich_text' },
        'Created At': { type: 'created_time' },
        'Updated At': { type: 'last_edited_time' },
      } };
    };
    NotionStore.prototype.findInvocation = async function (_databaseId, invocationId) {
      invocationReads++;
      return { id: invocationId, pageId: 'remote-page', state: 'in_progress', error: '' };
    };

    const inspectReport = await inspectAttempt(id) as any;
    const doctorReport = await doctor(false) as any;

    assert.equal(inspectReport.remote.status, 'accepted');
    assert.equal(inspectReport.remote.job.state, 'in_progress');
    assert.equal(inspectReport.remote.service_read.status, 'failed');
    assert.equal(inspectReport.remote.service_read.code, 'SERVICE_STOPPING');
    assert.equal(invocationReads, 1);
    assert.equal(doctorReport.checks.service.status, 'ready');
    assert.equal(doctorReport.checks.service_read.status, 'failed');
    assert.equal(doctorReport.checks.service_read.code, 'SERVICE_STOPPING');
    assert.equal(doctorReport.checks.notion.status, 'passed');
    assert.equal(doctorReport.capabilities.notion_read.status, 'available');
    assert.equal(databaseReads, 1);
    assert.equal(process.exitCode, 1);
  } finally {
    NotionStore.prototype.database = originalDatabase;
    NotionStore.prototype.findInvocation = originalFindInvocation;
    process.exitCode = previousExitCode;
    for (const name of envNames) {
      const value = previousEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.close();
    await once(server, 'close');
    rmSync(configHome, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

test('inspect and doctor use an existing Service without caller-side Notion configuration', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-existing-service-configless-config-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-existing-service-configless-data-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-existing-service-configless-cache-'));
  const envNames = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'] as const;
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousExitCode = process.exitCode;
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const credential = 'existing-service-without-caller-config';
  let inspectReads = 0;
  let jobReads = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${credential}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'A current service credential is required.' }));
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ pid: process.pid, protocolVersion: 1, accepting: true, state: 'ready' }));
    } else if (request.url === `/attempts/${id}`) {
      inspectReads++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        schema_version: 1,
        attempt_id: id,
        local_attempt: { found: false, status: 'not_found', source: 'local_attempt_telemetry', authority: 'local_evidence' },
        remote: { status: 'accepted', source: 'notion', job: { id: 'remote-job', state: 'in_progress' } },
        retry_safety: { status: 'unsafe', automatic_retry: false, reason: 'An accepted remote Job was observed.' },
        next_actions: ['chatgpt-shot jobs remote-job'],
      }));
    } else if (request.url === '/jobs') {
      jobReads++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jobs: [{ id: 'remote-job', state: 'in_progress' }] }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ code: 'NOT_FOUND', message: 'No route.' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_CACHE_HOME = cacheHome;
    const runtimeDirectory = join(cacheHome, 'chatgpt-shot');
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(runtimeDirectory, 'runtime.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential }));

    const inspectReport = await inspectAttempt(id) as any;
    const doctorReport = await doctor(false) as any;

    assert.equal(inspectReport.remote.status, 'accepted');
    assert.equal(inspectReport.remote.job.id, 'remote-job');
    assert.equal(inspectReads, 1);
    assert.equal(doctorReport.checks.configuration.status, 'failed');
    assert.equal(doctorReport.checks.service.status, 'ready');
    assert.equal(doctorReport.checks.service_read.status, 'passed');
    assert.equal(doctorReport.checks.notion.status, 'passed');
    assert.equal(doctorReport.capabilities.notion_read.status, 'available');
    assert.equal(jobReads, 1);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    for (const name of envNames) {
      const value = previousEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.close();
    await once(server, 'close');
    rmSync(configHome, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(cacheHome, { recursive: true, force: true });
  }
});

test('non-interactive open requests human intervention without starting Chrome', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-open-config-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-open-data-'));
  const result = cli(['open'], configHome, { XDG_DATA_HOME: dataHome });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^USER_INTERVENTION_REQUIRED:/);
    assert.equal(existsSync(join(dataHome, 'chatgpt-shot', 'chrome-profile')), false);
  } finally { rmSync(configHome, { recursive: true, force: true }); rmSync(dataHome, { recursive: true, force: true }); }
});

test('inspect remains available without Notion configuration and reports remote capability as unavailable', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-config-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-cache-'));
  const id = '01234567-89ab-4def-8123-456789abcdef';
  try {
    const result = cli(['inspect', id], configHome, { XDG_CACHE_HOME: cacheHome });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.attempt_id, id);
    assert.equal(report.local_attempt.found, false);
    assert.equal(report.remote.status, 'unavailable');
    assert.equal(report.remote.reason, 'configuration_unavailable');
    assert.equal(report.retry_safety.status, 'unknown');
  } finally { rmSync(configHome, { recursive: true, force: true }); rmSync(cacheHome, { recursive: true, force: true }); }
});

test('inspect reconciles a local Attempt through the CLI when Notion configuration is unavailable', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-config-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-cache-'));
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const writer = new LocalJobTelemetryWriter(join(cacheHome, 'chatgpt-shot', 'jobs.jsonl'));
  const timestamp = new Date().toISOString();
  writer.record({ job_id: id, event: 'admission_started', timestamp, stage: 'authentication' });
  writer.record({ job_id: id, event: 'admission_failed', timestamp, stage: 'authentication', error: { code: 'CHATGPT_AUTH_REQUIRED' } });
  try {
    const result = cli(['inspect', id], configHome, { XDG_CACHE_HOME: cacheHome });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.local_attempt.found, true);
    assert.equal(report.local_attempt.delivery, 'not_submitted');
    assert.equal(report.local_attempt.error_code, 'CHATGPT_AUTH_REQUIRED');
    assert.equal(report.remote.status, 'unavailable');
    assert.equal(report.retry_safety.status, 'safe');
    assert.match(report.next_actions[0], /chatgpt-shot open/);
  } finally { rmSync(configHome, { recursive: true, force: true }); rmSync(cacheHome, { recursive: true, force: true }); }
});

test('inspect reads Notion directly when existing Service discovery is unhealthy', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-unhealthy-config-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-unhealthy-data-'));
  const cacheHome = mkdtempSync(join(tmpdir(), 'chatgpt-shot-inspect-unhealthy-cache-'));
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const envNames = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'] as const;
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const originalFindInvocation = NotionStore.prototype.findInvocation;
  let readAttemptId: string | undefined;
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_CACHE_HOME = cacheHome;
    const configDirectory = join(configHome, 'chatgpt-shot');
    const runtimeDirectory = join(cacheHome, 'chatgpt-shot');
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(configDirectory, '.env'), 'NOTION_TOKEN=test-token\nCHATGPT_SHOT_NOTION_DATABASE_URL=https://www.notion.so/workspace/0123456789abcdef0123456789abcdef\n');
    writeFileSync(join(runtimeDirectory, 'runtime.json'), JSON.stringify({ pid: 2_147_483_647, host: '127.0.0.1', port: 1, protocolVersion: 1, credential: 'stale-service' }));
    NotionStore.prototype.findInvocation = async function (_databaseId, invocationId) {
      readAttemptId = invocationId;
      return { id: invocationId, pageId: 'remote-page', state: 'in_progress', error: '' };
    };
    const report = await inspectAttempt(id);
    assert.equal(readAttemptId, id);
    assert.equal(report.remote.status, 'accepted');
    assert.equal(report.remote.job.state, 'in_progress');
    assert.equal(report.retry_safety.status, 'unsafe');
  } finally {
    NotionStore.prototype.findInvocation = originalFindInvocation;
    for (const name of envNames) {
      const value = previousEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(configHome, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(cacheHome, { recursive: true, force: true });
  }
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
