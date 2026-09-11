import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerSocket, chromeArguments, chromeEnvironment, privateDisplayArguments, privateDisplayFromOutput } from '../src/broker.js';

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

test('uses Xvfb display-fd allocation with the small private screen', () => {
  assert.deepEqual(privateDisplayArguments, ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp']);
  assert.equal(privateDisplayFromOutput('77\n'), ':77');
  assert.equal(privateDisplayFromOutput('invalid'), undefined);
  assert.equal(privateDisplayFromOutput('65536'), undefined);
});

test('keeps Chrome headful and passes a private display only to its child environment', () => {
  const arguments_ = chromeArguments('/tmp/chatgpt-shot-profile');
  assert.ok(arguments_.includes('--remote-debugging-pipe'));
  assert.ok(arguments_.includes('--no-startup-window'));
  assert.ok(!arguments_.includes('--start-minimized'));
  assert.ok(!arguments_.some(argument => argument.startsWith('--headless')));
  const environment = chromeEnvironment(':77');
  assert.equal(environment?.DISPLAY, ':77');
  assert.equal(chromeEnvironment(), undefined);
});
