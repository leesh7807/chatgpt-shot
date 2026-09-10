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
