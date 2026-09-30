import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseIdFromUrl, INVOCATION_DATABASE_MARKER, NotionRequestQueue, NotionStore } from '../src/notion.js';
import { ShotError } from '../src/errors.js';
test('extracts database identity from a direct Notion database URL', () => {
  assert.equal(databaseIdFromUrl('https://app.notion.com/p/studyleesh/3d58a26586258008a4f1e10a6f50f4df?v=3d58a265862580369208000c5cb9e417'), '3d58a26586258008a4f1e10a6f50f4df');
});
test('rejects URLs without a Notion-style identity', () => {
  assert.throws(() => databaseIdFromUrl('https://app.notion.com/p/studyleesh/no-id'), (e: any) => e instanceof ShotError && e.code === 'CONFIG_INVALID');
});
test('never treats a drifted Invocation database as a pristine provisioning target', () => {
  const store = new NotionStore('test-token');
  assert.equal(store.isProvisionable({ properties: { Name: { type: 'title' } }, description: [] }), true);
  assert.equal(store.isProvisionable({ properties: { State: { type: 'select' } }, description: [] }), false);
  assert.equal(store.isProvisionable({ properties: { Name: { type: 'title' } }, description: [{ plain_text: INVOCATION_DATABASE_MARKER }] }), false);
});
test('resolves Job IDs through Notion and rejects duplicate durable identities', async () => {
  const store = new NotionStore('test-token');
  const page = { id: 'page-1', properties: { State: { select: { name: 'in_progress' } }, Error: { rich_text: [] } } };
  (store as any).client = { databases: { query: async () => ({ results: [page] }) } };
  assert.deepEqual(await store.findInvocation('db', 'job-1'), { id: 'job-1', pageId: 'page-1', state: 'in_progress', error: '' });
  (store as any).client = { databases: { query: async () => ({ results: [page, page] }) } };
  await assert.rejects(store.findInvocation('db', 'job-1'), (e: any) => e instanceof ShotError && e.code === 'INVALID_INVOCATION_STATE');
});
test('lists recent Job state without reading page bodies', async () => {
  const store = new NotionStore('test-token'); let query: any;
  (store as any).client = { databases: { query: async (value: any) => { query = value; return { results: [{ id: 'page-1', properties: { ID: { title: [{ plain_text: 'job-1' }] }, State: { select: { name: 'completed' } }, Error: { rich_text: [] } } }] }; } } };
  assert.deepEqual(await store.listInvocations('db'), [{ id: 'job-1', pageId: 'page-1', state: 'completed', error: '' }]);
  assert.deepEqual(query.sorts, [{ timestamp: 'created_time', direction: 'descending' }]);
});

test('cleans up a confirmed undelivered Invocation by archiving it', async () => {
  const store = new NotionStore('test-token'); let update: any;
  (store as any).client = { pages: { update: async (value: any) => { update = value; } } };
  await store.deleteInvocation('page-1', 'job-1');
  assert.deepEqual(update, { page_id: 'page-1', archived: true });
});

test('spaces concurrent Notion request starts through the shared request queue', async () => {
  const queue = new NotionRequestQueue(); const started: number[] = [];
  await Promise.all(Array.from({ length: 3 }, (_, index) => queue.run(`pages.retrieve`, 'GET', async () => { started.push(Date.now()); return index; }, undefined, true)));
  assert.equal(started.length, 3);
  assert.ok(started[1] - started[0] >= 300);
  assert.ok(started[2] - started[1] >= 300);
});

test('does not retry an ambiguous create but safely retries a rate-limited read', async () => {
  const queue = new NotionRequestQueue(); let createCalls = 0; let readCalls = 0; const outcomes: string[] = [];
  const ambiguous = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const throttled = Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limited', headers: { get: () => '0' } });
  await assert.rejects(() => queue.run('pages.create', 'POST', async () => { createCalls++; throw ambiguous; }));
  assert.equal(createCalls, 1);
  const result = await queue.run('pages.retrieve', 'GET', async () => { if (++readCalls === 1) throw throttled; return 'ok'; }, event => outcomes.push(event.outcome), true);
  assert.equal(result, 'ok');
  assert.equal(readCalls, 2);
  assert.deepEqual(outcomes, ['retry', 'success']);
});

test('cancels a queued Notion call before it starts while allowing the active request to finish', async () => {
  const queue = new NotionRequestQueue(); let releaseFirst!: () => void; let secondStarted = false;
  const first = queue.run('pages.retrieve', 'GET', async () => await new Promise<void>(resolve => { releaseFirst = resolve; }), undefined, true);
  while (!releaseFirst) await new Promise(resolve => setTimeout(resolve, 1));
  const controller = new AbortController();
  const second = queue.run('pages.retrieve', 'GET', async () => { secondStarted = true; }, undefined, true, controller.signal);
  controller.abort();
  await assert.rejects(second, (error: any) => error.code === 'ADMISSION_CANCELLED');
  releaseFirst();
  await first;
  assert.equal(secondStarted, false);
});
