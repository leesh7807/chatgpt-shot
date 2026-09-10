import { Client } from '@notionhq/client';
import { fail, ShotError } from './errors.js';

export const STATES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export const INVOCATION_DATABASE_MARKER = 'Managed by chatgpt-shot invocation protocol v1.';
export type State = typeof STATES[number];
export type Invocation = { id: string; pageId: string; state: State; error: string };
const text = (value: any) => Array.isArray(value) ? value.map((x: any) => x.plain_text ?? x.text?.content ?? '').join('') : '';
export function databaseIdFromUrl(value: string): string {
  const matched = value.match(/[0-9a-f]{32}(?:[?#].*)?$/i)?.[0]?.slice(0, 32) ?? value.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (!matched) fail('CONFIG_INVALID', 'The Notion database URL does not contain a database ID.');
  return matched!.replace(/-/g, '');
}
export class NotionStore {
  readonly client: Client;
  constructor(token: string) { this.client = new Client({ auth: token }); }
  async database(id: string): Promise<any> { try { return await this.client.databases.retrieve({ database_id: id }); } catch (e) { return fail('NOTION_UNAVAILABLE', 'Configured Invocation database is inaccessible.', e); } }
  validateSchema(database: any): void {
    for (const [name, type] of [['ID','title'],['State','select'],['Error','rich_text'],['Created At','created_time'],['Updated At','last_edited_time']] as const) if (database.properties?.[name]?.type !== type) fail('NOTION_SCHEMA_INVALID', `Required ${name} property is missing or incompatible.`);
    const options = database.properties.State.select.options.map((x: any) => x.name);
    if (!STATES.every(state => options.includes(state))) fail('NOTION_SCHEMA_INVALID', 'State is missing one or more required options.');
  }
  isProvisionable(database: any): boolean {
    const properties = database.properties ?? {};
    // A configured database that has ever exposed part of the Invocation contract is not a blank
    // target. Schema drift must fail validation rather than being silently repaired.
    return !text(database.description).includes(INVOCATION_DATABASE_MARKER)
      && !['ID', 'State', 'Error', 'Created At', 'Updated At'].some((name) => properties[name] !== undefined);
  }
  async initializeSchema(database: any): Promise<any> {
    try {
      if (!this.isProvisionable(database)) fail('NOTION_SCHEMA_INVALID', 'Configured Invocation database is already provisioned or has an incompatible schema.');
      const existing: any = await this.client.databases.query({ database_id: database.id, page_size: 1 });
      if (existing.results.length) fail('NOTION_INIT_FAILED', 'The supplied Invocation database is not empty; refusing to alter its schema.');
      const props = database.properties ?? {}; const byType = (type: string) => Object.values(props).find((p: any) => p.type === type) as any;
      const title = byType('title'); if (!title) fail('NOTION_SCHEMA_INVALID', 'The supplied database has no title property.');
      for (const [name, type] of [['ID','title'],['State','select'],['Error','rich_text'],['Created At','created_time'],['Updated At','last_edited_time']] as const) if (props[name] && props[name].type !== type) fail('NOTION_SCHEMA_INVALID', `Existing ${name} property is incompatible.`);
      const update: Record<string, any> = { [title.id]: { title: {}, name: 'ID' } };
      const created = byType('created_time'), updated = byType('last_edited_time');
      update[created?.id ?? 'Created At'] = { created_time: {}, name: 'Created At' };
      update[updated?.id ?? 'Updated At'] = { last_edited_time: {}, name: 'Updated At' };
      update.State = { select: { options: STATES.map(name => ({ name })) }, name: 'State' };
      update.Error = { rich_text: {}, name: 'Error' };
      const description = text(database.description);
      return await this.client.databases.update({ database_id: database.id, properties: update, description: [{ type: 'text', text: { content: [description, INVOCATION_DATABASE_MARKER].filter(Boolean).join('\n') } }] });
    } catch (e) { if (e instanceof ShotError) throw e; return fail('NOTION_INIT_FAILED', 'Could not configure the supplied Invocation database.', e); }
  }
  async createInvocation(databaseId: string, id: string): Promise<Invocation> { try { const page: any = await this.client.pages.create({ parent: { database_id: databaseId }, properties: { ID: { title: [{ text: { content: id } }] }, State: { select: { name: 'pending' } }, Error: { rich_text: [] } } }); return { id, pageId: page.id, state: 'pending', error: '' }; } catch (e) { return fail('INVOCATION_CREATE_FAILED', 'Could not create pending invocation.', e); } }
  async failUndeliveredInvocation(pageId: string, id: string, reason: string): Promise<void> { try { await this.client.pages.update({ page_id: pageId, properties: { State: { select: { name: 'failed' } }, Error: { rich_text: [{ text: { content: reason.slice(0, 2_000) } }] } } }); } catch (e) { return fail('NOTION_UNAVAILABLE', `Could not terminalize undelivered invocation ${id}.`, e); } }
  async readInvocation(pageId: string, id: string): Promise<Invocation> { try { const page: any = await this.client.pages.retrieve({ page_id: pageId }); const state = page.properties?.State?.select?.name; if (!STATES.includes(state)) return fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State.`); return { id, pageId, state, error: text(page.properties?.Error?.rich_text) }; } catch (e) { if (e instanceof ShotError) throw e; return fail('NOTION_UNAVAILABLE', `Could not read invocation ${id}.`, e); } }
  async children(pageId: string): Promise<any[]> { try { let cursor: string | undefined; const all: any[] = []; do { const r: any = await this.client.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }); all.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined; } while(cursor); return all; } catch (e) { return fail('RESULT_READ_FAILED', 'Could not read invocation Result.', e); } }
}
