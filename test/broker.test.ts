import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerSocket } from '../src/broker.js';

test('uses a short hashed owner-runtime socket path for deep repositories', () => {
  const root = `/tmp/${'deep/'.repeat(80)}repository`;
  const socket = brokerSocket(root);
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.match(socket, /chatgpt-shot/);
  assert.doesNotMatch(socket, /deep/);
});

test('uses the same broker identity regardless of XDG_RUNTIME_DIR', () => {
  const prior = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.XDG_RUNTIME_DIR = '/run/user/example-session';
    const withXdg = brokerSocket('/tmp/repository');
    delete process.env.XDG_RUNTIME_DIR;
    assert.equal(brokerSocket('/tmp/repository'), withXdg);
  } finally {
    if (prior === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prior;
  }
});
