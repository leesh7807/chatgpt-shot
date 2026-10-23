import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserProfileBusyForOpen, call, discardDeadServiceDiscovery, JOB_TRANSPORT_TIMEOUT_MS, readDiscovery, removeDiscovery, REQUEST_BODY_TIMEOUT_MS, runService, stopService } from '../src/http-service.js';
import { ShotError } from '../src/errors.js';
import { paths } from '../src/config.js';
import { NotionStore } from '../src/notion.js';
import { LocalJobTelemetryWriter } from '../src/job-telemetry.js';

test('Job admission has no shorter client-side transport timeout', () => {
  assert.equal(JOB_TRANSPORT_TIMEOUT_MS, 0);
});

test('bounds incomplete request bodies independently of accepted Job draining', () => {
  assert.equal(REQUEST_BODY_TIMEOUT_MS, 30_000);
});

test('manual open waits for browser admission, not accepted remote work', () => {
  assert.equal(browserProfileBusyForOpen(false, 0), false);
  assert.equal(browserProfileBusyForOpen(false, 1), true);
  assert.equal(browserProfileBusyForOpen(true, 0), true);
});

test('restores a defined Service submission failure code at the HTTP client boundary', async () => {
  const server = createServer((_, response) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'SUBMISSION_UNCERTAIN', message: 'status unknown', diagnostics: [{ stage: 'after_fill', promptMatches: true }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' }), (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN' && JSON.stringify(error.diagnostics) === '[{"stage":"after_fill","promptMatches":true}]'); }
  finally { server.close(); await once(server, 'close'); }
});

test('restores Attempt correlation from structured HTTP submission failures', async () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const server = createServer((_, response) => {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'SUBMISSION_UNCERTAIN', message: 'status unknown', attempt_id: id, recovery: { inspect: `chatgpt-shot inspect ${id}`, automatic_retry: false } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(
      call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' }),
      (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN' && error.attemptId === id,
    );
  } finally { server.close(); await once(server, 'close'); }
});

test('caller cancellation retains Attempt correlation from an early HTTP hint', async () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const server = createServer((_, response) => {
    response.writeEarlyHints({ link: `</attempts/${id}>; rel=related`, 'x-chatgpt-shot-attempt-id': id });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  try {
    const pending = call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ShotError && error.code === 'ADMISSION_CANCELLED' && error.attemptId === id);
  } finally { server.close(); await once(server, 'close'); }
});

test('an unexpected transport failure retains Attempt correlation from an early HTTP hint', async () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const server = createServer((request, response) => {
    response.writeEarlyHints({ link: `</attempts/${id}>; rel=related`, 'x-chatgpt-shot-attempt-id': id });
    setTimeout(() => request.socket.destroy(), 25);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(
      call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' }),
      (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN' && error.attemptId === id,
    );
  } finally { server.close(); await once(server, 'close'); }
});

test('an incomplete response after an early Attempt hint rejects as uncertain', async () => {
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const server = createServer((_, response) => {
    response.writeEarlyHints({ link: `</attempts/${id}>; rel=related`, 'x-chatgpt-shot-attempt-id': id });
    response.writeHead(502, { 'content-type': 'application/json', 'content-length': '100' });
    response.write('{"code":"SUBMISSION_UNCERTAIN"');
    setTimeout(() => response.socket?.destroy(), 25);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const outcome = await Promise.race([
      call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' })
        .then((value) => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error })),
      new Promise<{ kind: 'pending' }>((resolve) => setTimeout(() => resolve({ kind: 'pending' }), 100)),
    ]);
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind === 'rejected') {
      assert.ok(outcome.error instanceof ShotError);
      assert.equal(outcome.error.code, 'SUBMISSION_UNCERTAIN');
      assert.equal(outcome.error.attemptId, id);
    }
  } finally { server.close(); await once(server, 'close'); }
});

test('authenticated HTTP Attempt inspection returns the same read-only recovery report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chatgpt-shot-http-inspect-'));
  const previousEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    CHATGPT_SHOT_STARTUP_TOKEN: process.env.CHATGPT_SHOT_STARTUP_TOKEN,
  };
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  const startupToken = 'test-startup-token';
  process.env.CHATGPT_SHOT_STARTUP_TOKEN = startupToken;
  const config = paths();
  const id = '01234567-89ab-4def-8123-456789abcdef';
  const writer = new LocalJobTelemetryWriter(join(config.runtimeDirectory, 'jobs.jsonl'));
  const timestamp = new Date().toISOString();
  writer.record({ job_id: id, event: 'admission_started', timestamp, stage: 'authentication' });
  writer.record({ job_id: id, event: 'admission_failed', timestamp, stage: 'authentication', error: { code: 'CHATGPT_AUTH_REQUIRED' } });
  writeFileSync(config.envPath, 'NOTION_TOKEN=test-token\nCHATGPT_SHOT_NOTION_DATABASE_URL=https://www.notion.so/0123456789abcdef0123456789abcdef\n');
  writeFileSync(config.lockPath, JSON.stringify({ pid: process.pid, token: startupToken }));
  const originalFindInvocation = NotionStore.prototype.findInvocation;
  NotionStore.prototype.findInvocation = async function () { return undefined; };
  let serviceStarted = false;
  try {
    await runService();
    serviceStarted = true;
    const record = readDiscovery(config);
    assert.ok(record);
    const report = await call<any>(record, `/attempts/${id}`);
    assert.equal(report.schema_version, 1);
    assert.equal(report.local_attempt.found, true);
    assert.equal(report.local_attempt.delivery, 'not_submitted');
    assert.equal(report.remote.status, 'not_found');
    assert.equal(report.retry_safety.status, 'safe');

    const anonymousStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: record.host, port: record.port, path: `/attempts/${id}`, method: 'GET' }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(anonymousStatus, 401);
  } finally {
    try { if (serviceStarted) await stopService(config); }
    finally {
      NotionStore.prototype.findInvocation = originalFindInvocation;
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('preserves Job lookup and shutdown failure codes at the HTTP client boundary', async () => {
  const server = createServer((request, response) => { const code = request.url === '/jobs/missing' ? 'NOT_FOUND' : 'SERVICE_STOPPING'; response.writeHead(request.url === '/jobs/missing' ? 404 : 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code, message: code })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const record = { pid: process.pid, host: '127.0.0.1' as const, port: address.port, protocolVersion: 1 as const, credential: 'test' };
  try {
    await assert.rejects(call(record, '/jobs/missing'), (error: unknown) => error instanceof ShotError && error.code === 'NOT_FOUND');
    await assert.rejects(call(record, '/stop', {}), (error: unknown) => error instanceof ShotError && error.code === 'SERVICE_STOPPING');
  } finally { server.close(); await once(server, 'close'); }
});

test('caller cancellation is distinct from remote Job failure', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  try {
    const request = call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' }, controller.signal);
    controller.abort();
    await assert.rejects(request, (error: unknown) => error instanceof ShotError && error.code === 'ADMISSION_CANCELLED');
  } finally { server.close(); await once(server, 'close'); }
});

test('discovery cleanup preserves a replacement owned by another Service generation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-discovery-'));
  const config = { discoveryPath: join(directory, 'runtime.json') };
  try {
    writeFileSync(config.discoveryPath, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 12345, protocolVersion: 1, credential: 'generation-b' }));
    removeDiscovery(config, 'generation-a');
    assert.equal(readDiscovery(config)?.credential, 'generation-b');
    removeDiscovery(config, 'generation-b');
    assert.equal(existsSync(config.discoveryPath), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('manual open can reclaim discovery only after the Service process is dead', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-open-stale-'));
  const config = { discoveryPath: join(directory, 'runtime.json') };
  try {
    writeFileSync(config.discoveryPath, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 12345, protocolVersion: 1, credential: 'live-generation' }));
    assert.equal(discardDeadServiceDiscovery(config), false);
    assert.equal(readDiscovery(config)?.credential, 'live-generation');

    writeFileSync(config.discoveryPath, JSON.stringify({ pid: 2_147_483_647, host: '127.0.0.1', port: 12345, protocolVersion: 1, credential: 'dead-generation' }));
    assert.equal(discardDeadServiceDiscovery(config), true);
    assert.equal(readDiscovery(config), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('stopService preserves discovery and reports failure when health cannot be confirmed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-stop-'));
  const config = { discoveryPath: join(directory, 'runtime.json') };
  const server = createServer((_, response) => { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'SERVICE_STOPPING', message: 'temporarily unavailable' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    writeFileSync(config.discoveryPath, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'current-generation' }));
    await assert.rejects(stopService(config), (error: unknown) => error instanceof ShotError && error.code === 'BROWSER_UNAVAILABLE');
    assert.equal(readDiscovery(config)?.credential, 'current-generation');
  } finally {
    server.close(); await once(server, 'close');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stopService does not wait on a replacement discovery generation', { timeout: 1_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-stop-generation-'));
  const config = { discoveryPath: join(directory, 'runtime.json') };
  let port = 0;
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ pid: process.pid, protocolVersion: 1 })); return; }
    writeFileSync(config.discoveryPath, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port, protocolVersion: 1, credential: 'generation-b' }));
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stopping: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); port = address.port;
  try {
    writeFileSync(config.discoveryPath, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'generation-a' }));
    await stopService(config);
    assert.equal(readDiscovery(config)?.credential, 'generation-b');
  } finally {
    server.close(); await once(server, 'close');
    rmSync(directory, { recursive: true, force: true });
  }
});
