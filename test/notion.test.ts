import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseIdFromUrl, INVOCATION_DATABASE_MARKER, NotionStore } from '../src/notion.js';
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
