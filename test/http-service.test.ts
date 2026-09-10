import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { call, SUBMIT_TRANSPORT_TIMEOUT_MS } from '../src/http-service.js';
import { ShotError } from '../src/errors.js';

test('does not give submit a shorter client-side transport timeout', () => {
  assert.equal(SUBMIT_TRANSPORT_TIMEOUT_MS, 0);
});

test('restores a defined Service failure code at the HTTP client boundary', async () => {
  const server = createServer((_, response) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'SUBMISSION_UNCERTAIN', message: 'status unknown' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(call({ pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential: 'test' }, '/submit', { prompt: 'x' }), (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN'); }
  finally { server.close(); await once(server, 'close'); }
});
