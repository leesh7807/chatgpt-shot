import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { call, SUBMIT_TRANSPORT_TIMEOUT_MS } from '../src/http-service.js';
import { DEFAULT_ACKNOWLEDGEMENT_MS, DEFAULT_EXECUTION_MS } from '../src/service.js';
import { ShotError } from '../src/errors.js';

test('keeps submit transport open beyond the defined invocation lifecycle', () => {
  assert.ok(SUBMIT_TRANSPORT_TIMEOUT_MS >= DEFAULT_ACKNOWLEDGEMENT_MS + DEFAULT_EXECUTION_MS);
});

test('restores a defined Service failure code at the HTTP client boundary', async () => {
  const server = createServer((_, response) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'SUBMISSION_UNCERTAIN', message: 'status unknown' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/submit', { prompt: 'x' }), (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN'); }
  finally { server.close(); await once(server, 'close'); }
});
