import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, JOB_TRANSPORT_TIMEOUT_MS, readDiscovery, removeDiscovery, REQUEST_BODY_TIMEOUT_MS, stopService } from '../src/http-service.js';
import { ShotError } from '../src/errors.js';

test('Job admission has no shorter client-side transport timeout', () => {
  assert.equal(JOB_TRANSPORT_TIMEOUT_MS, 0);
});

test('bounds incomplete request bodies independently of accepted Job draining', () => {
  assert.equal(REQUEST_BODY_TIMEOUT_MS, 30_000);
});

test('restores a defined Service submission failure code at the HTTP client boundary', async () => {
  const server = createServer((_, response) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'SUBMISSION_UNCERTAIN', message: 'status unknown', diagnostics: [{ stage: 'after_fill', promptMatches: true }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/jobs', { prompt: 'x' }), (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN' && JSON.stringify(error.diagnostics) === '[{"stage":"after_fill","promptMatches":true}]'); }
  finally { server.close(); await once(server, 'close'); }
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
