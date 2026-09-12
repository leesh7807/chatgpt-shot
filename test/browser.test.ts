import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTBrowser } from '../src/browser.js';
import { STALE_BROWSER_SESSION_MESSAGE, ShotError, isStaleBrowserSessionError } from '../src/errors.js';

type Operation = { operation: string; sessionId?: string; prompt?: string; invocationId?: string };

const stale = () => Object.assign(new Error(STALE_BROWSER_SESSION_MESSAGE), { code: 'INTERNAL_ERROR' });

test('recognizes only the browser stale-session message', () => {
  assert.equal(isStaleBrowserSessionError(new Error(STALE_BROWSER_SESSION_MESSAGE)), true);
  assert.equal(isStaleBrowserSessionError(new Error(`${STALE_BROWSER_SESSION_MESSAGE}.`)), true);
  assert.equal(isStaleBrowserSessionError(new Error('Session with given id not found: extra')), false);
  assert.equal(isStaleBrowserSessionError(new Error('Browser transport failed')), false);
});

test('reopens a fresh page when opening a page hits a stale browser session', async () => {
  const operations: Operation[] = [];
  let opens = 0;
  const browser = new ChatGPTBrowser('profile', async (_root, request) => {
    operations.push(request);
    if (request.operation === 'open' && opens++ === 0) throw stale();
    return request.operation === 'open' ? 'session-2' : undefined;
  });

  await browser.openFreshContext();

  assert.deepEqual(operations.map(({ operation }) => operation), ['open', 'open']);
});

test('recovers fill through a fresh page without submitting twice', async () => {
  const operations: Operation[] = [];
  let opens = 0;
  const browser = new ChatGPTBrowser('profile', async (_root, request) => {
    operations.push(request);
    if (request.operation === 'open') return opens++ === 0 ? 'session-1' : 'session-2';
    if (request.operation === 'fill' && request.sessionId === 'session-1') throw stale();
    return undefined;
  });

  await browser.openFreshContext();
  await browser.fillPrompt('wrapped prompt');

  assert.deepEqual(operations.map(({ operation }) => operation), ['open', 'fill', 'close', 'open', 'fill']);
  assert.deepEqual(operations.filter(({ operation }) => operation === 'fill').map(({ sessionId, prompt }) => ({ sessionId, prompt })), [
    { sessionId: 'session-1', prompt: 'wrapped prompt' },
    { sessionId: 'session-2', prompt: 'wrapped prompt' }
  ]);
});

test('invalidates a stale page during submit and preserves submission uncertainty', async () => {
  const operations: Operation[] = [];
  const browser = new ChatGPTBrowser('profile', async (_root, request) => {
    operations.push(request);
    if (request.operation === 'open') return 'session-1';
    if (request.operation === 'submit') throw stale();
    return undefined;
  });

  await browser.openFreshContext();
  await assert.rejects(() => browser.submitPrompt(), (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_UNCERTAIN');

  assert.deepEqual(operations.map(({ operation }) => operation), ['open', 'submit', 'close']);
});

test('invalidates a stale page during inspection and returns uncertain', async () => {
  const operations: Operation[] = [];
  const browser = new ChatGPTBrowser('profile', async (_root, request) => {
    operations.push(request);
    if (request.operation === 'open') return 'session-1';
    if (request.operation === 'inspect') throw stale();
    return undefined;
  });

  await browser.openFreshContext();
  assert.equal(await browser.inspectSubmission('invocation-1'), 'uncertain');
  assert.deepEqual(operations.map(({ operation }) => operation), ['open', 'inspect', 'close']);
});

test('does not retry unrelated fill failures', async () => {
  const operations: Operation[] = [];
  const browser = new ChatGPTBrowser('profile', async (_root, request) => {
    operations.push(request);
    if (request.operation === 'open') return 'session-1';
    if (request.operation === 'fill') throw new ShotError('BROWSER_UNAVAILABLE', 'composer disappeared');
    return undefined;
  });

  await browser.openFreshContext();
  await assert.rejects(() => browser.fillPrompt('wrapped prompt'), (error: unknown) => error instanceof ShotError && error.code === 'BROWSER_UNAVAILABLE' && error.message === 'composer disappeared');
  assert.deepEqual(operations.map(({ operation }) => operation), ['open', 'fill']);
});
