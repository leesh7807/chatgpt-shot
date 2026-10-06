import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokerSocket, chromeArguments, chromeEnvironment, classifySubmissionEvidence, closeTargetAndVerify, privateDisplayArguments, privateDisplayFromOutput, privateXAuthority, SEND_BUTTON_LABEL_PATTERN } from '../src/broker.js';

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

test('keeps the established socket path under short XDG cache locations', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cgs-'));
  const previous = process.env.XDG_CACHE_HOME;
  try {
    process.env.XDG_CACHE_HOME = parent;
    assert.equal(brokerSocket('profile'), join(parent, 'chatgpt-shot', 'broker.sock'));
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

test('shortens the broker socket path for deeply nested XDG cache locations', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cgs-'));
  const cache = join(parent, 'x'.repeat(70));
  mkdirSync(cache);
  const previous = process.env.XDG_CACHE_HOME;
  try {
    process.env.XDG_CACHE_HOME = cache;
    const primary = join(cache, 'chatgpt-shot', 'broker.sock');
    const compact = join(cache, '.chatgpt.sock');
    assert.ok(Buffer.byteLength(primary) >= 104);
    assert.ok(Buffer.byteLength(compact) < 104);
    assert.equal(brokerSocket('profile'), compact);
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

test('uses Xvfb display-fd allocation with the small private screen', () => {
  assert.deepEqual(privateDisplayArguments('/tmp/chatgpt-shot.Xauthority'), ['-auth', '/tmp/chatgpt-shot.Xauthority', '-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp']);
  assert.equal(privateDisplayFromOutput('77\n'), ':77');
  assert.equal(privateDisplayFromOutput('invalid'), undefined);
  assert.equal(privateDisplayFromOutput('65536'), undefined);
});

test('creates a wildcard MIT-MAGIC-COOKIE authority record for the dynamically allocated display', () => {
  const cookie = Buffer.from('0123456789abcdef');
  const authority = privateXAuthority(cookie);
  assert.equal(authority.readUInt16BE(0), 0xffff);
  assert.ok(authority.includes(Buffer.from('MIT-MAGIC-COOKIE-1')));
  assert.ok(authority.subarray(-cookie.length).equals(cookie));
});

test('keeps Linux Chrome headful and selects the private X11 display', () => {
  const arguments_ = chromeArguments('/tmp/chatgpt-shot-profile', 'linux');
  assert.ok(arguments_.includes('--remote-debugging-pipe'));
  assert.ok(arguments_.includes('--no-startup-window'));
  assert.ok(arguments_.includes('--ozone-platform=x11'));
  assert.ok(!arguments_.includes('--start-minimized'));
  assert.ok(!arguments_.some(argument => argument.startsWith('--headless')));
  const environment = chromeEnvironment(':77', '/tmp/chatgpt-shot.Xauthority', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(environment?.DISPLAY, ':77');
  assert.equal(environment?.XAUTHORITY, '/tmp/chatgpt-shot.Xauthority');
  assert.equal(environment?.WAYLAND_DISPLAY, undefined);
  assert.equal(chromeEnvironment(), undefined);
});

test('does not select the X11 backend for non-Linux Chrome', () => {
  assert.ok(!chromeArguments('/tmp/chatgpt-shot-profile', 'darwin').includes('--ozone-platform=x11'));
});

test('classifies browser delivery from observable prompt evidence and prioritizes a visible message marker', () => {
  const marker = '0123456789abcdef0123456789abcdef';
  const wrappedPrompt = `Invocation record: https://www.notion.so/${marker}`;
  assert.equal(classifySubmissionEvidence(marker, { seen: true, composerValue: '' }), 'submitted');
  assert.equal(classifySubmissionEvidence(marker, { seen: false, composerValue: wrappedPrompt }), 'not_submitted');
  assert.equal(classifySubmissionEvidence(marker, { seen: false, composerValue: '' }), 'uncertain');
  assert.equal(classifySubmissionEvidence(marker, { seen: true, composerValue: marker }), 'submitted');
});

test('recognizes the current Send button label without matching unrelated actions', () => {
  assert.equal(SEND_BUTTON_LABEL_PATTERN.test('Send'), true);
  assert.equal(SEND_BUTTON_LABEL_PATTERN.test('Send Message'), true);
  assert.equal(SEND_BUTTON_LABEL_PATTERN.test('Send Prompt'), true);
  assert.equal(SEND_BUTTON_LABEL_PATTERN.test('Stop generating'), false);
  assert.equal(SEND_BUTTON_LABEL_PATTERN.test('Resend'), false);
});

test('verifies a Chrome target is absent before declaring its tab closed', async () => {
  const targets = new Set(['target-1']); let closeCalls = 0;
  await closeTargetAndVerify(async () => { closeCalls++; targets.delete('target-1'); return { success: true }; }, async () => targets.has('target-1'), 2, 2, 0);
  assert.equal(closeCalls, 1);
  assert.equal(targets.has('target-1'), false);
});

test('retains a close failure when the Chrome target remains open', async () => {
  let closeCalls = 0;
  await assert.rejects(
    () => closeTargetAndVerify(async () => { closeCalls++; return { success: true }; }, async () => true, 3, 1, 0),
    (error: any) => error.code === 'BROWSER_CONTEXT_CLOSE_FAILED',
  );
  assert.equal(closeCalls, 3);
});
