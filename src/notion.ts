import { Client } from '@notionhq/client';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fail, ShotError, type ErrorCode } from './errors.js';

export const STATES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export const INVOCATION_DATABASE_MARKER = 'Managed by chatgpt-shot invocation protocol v1.';
export type State = typeof STATES[number];
export type Invocation = { id: string; pageId: string; state: State; error: string };
const text = (value: any) => Array.isArray(value) ? value.map((x: any) => x.plain_text ?? x.text?.content ?? '').join('') : '';
function responseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const value = headers as { get?: (key: string) => unknown } & Record<string, unknown>;
  if (typeof value.get === 'function') {
    const found = value.get(name);
    if (typeof found === 'string') return found;
  }
  const key = Object.keys(value).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const found = key ? value[key] : undefined;
  return typeof found === 'string' ? found : undefined;
}
function notionBody(error: any): any {
  if (error?.body && typeof error.body === 'object') return error.body;
  if (typeof error?.body !== 'string') return undefined;
  try { return JSON.parse(error.body); } catch { return undefined; }
}
function failNotion(error: unknown, fallbackCode: ErrorCode, fallbackMessage: string): never {
  if (error instanceof ShotError) throw error;
  const cause = error as any;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const status = typeof cause?.status === 'number' ? cause.status : undefined;
  if (status === 429 || status === 529 || code === 'rate_limited' || code === 'service_overload') {
    const body = notionBody(cause);
    const additional = body?.additional_data;
    const rawRetryAfter = responseHeader(cause?.headers, 'retry-after') ?? additional?.retry_after;
    const retryAfter = typeof rawRetryAfter === 'number' ? rawRetryAfter : typeof rawRetryAfter === 'string' ? Number(rawRetryAfter) : undefined;
    const reason = typeof additional?.rate_limit_reason === 'string' ? additional.rate_limit_reason : undefined;
    const details = [
      cause?.message,
      reason ? `Rate limit reason: ${reason}.` : undefined,
      Number.isSafeInteger(retryAfter) && retryAfter! >= 0 ? `Retry after ${retryAfter} seconds.` : undefined,
      reason === 'public_api_request_blocked' ? 'This connection is blocked; contact Notion support.' : undefined,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
    const rateLimited = new ShotError('NOTION_RATE_LIMITED', `Notion API request was throttled or overloaded (HTTP ${status ?? (code === 'service_overload' ? 529 : 429)}, ${code ?? 'rate_limited'}).${details ? ` ${details}` : ''}`, error);
    if (Number.isSafeInteger(retryAfter) && retryAfter! >= 0) rateLimited.retryAfterSeconds = retryAfter;
    rateLimited.retryable = reason !== 'public_api_request_blocked';
    rateLimited.httpStatus = status;
    throw rateLimited;
  }
  const wrapped = new ShotError(fallbackCode, fallbackMessage, error);
  wrapped.httpStatus = status;
  wrapped.retryable = status !== undefined
    ? [500, 502, 503, 504].includes(status)
    : ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'notionhq_client_request_timeout'].includes(code ?? '');
  throw wrapped;
}

export type NotionRequestTelemetry = {
  operation: string;
  outcome: 'success' | 'retry' | 'failed';
  duration_ms: number;
  error?: { code?: string; network_code?: string; status?: number; retry_after_seconds?: number };
  details?: { attempt?: number; queue_wait_ms?: number; retry_after_seconds?: number; http_status?: number; rate_limit_reason?: string };
};

type RequestParameters = Parameters<Client['request']>[0];
type ScheduledRequest = <T>(operation: string, method: string, request: () => Promise<T>, observer?: (event: NotionRequestTelemetry) => void, safeRead?: boolean, signal?: AbortSignal) => Promise<T>;
const REQUEST_SPACING_MS = 334;
const MAX_REQUEST_ATTEMPTS = 3;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const cancelledRequest = () => new ShotError('ADMISSION_CANCELLED', 'The Notion request was cancelled before it started.');
const abortableDelay = async (ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) throw cancelledRequest();
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      if (signal) {
        abortListener = () => { if (timer) clearTimeout(timer); reject(cancelledRequest()); };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }
    });
  } finally { if (timer) clearTimeout(timer); if (abortListener) signal?.removeEventListener('abort', abortListener); }
};
const abortableWaitFor = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) throw cancelledRequest();
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abortListener = () => reject(cancelledRequest());
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    })]);
  } finally { if (abortListener) signal.removeEventListener('abort', abortListener); }
};

function retryAfterSeconds(error: any): number | undefined {
  const body = notionBody(error);
  const raw = responseHeader(error?.headers, 'retry-after') ?? body?.additional_data?.retry_after;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined;
  return Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
}

function notionOperation(parameters: RequestParameters): string {
  const path = parameters.path.split('?')[0].replace(/^\/+|\/+$/g, '').split('/');
  const method = parameters.method.toUpperCase();
  if (path[0] === 'databases') return path[1] === 'query' || path[2] === 'query' ? 'databases.query' : method === 'GET' ? 'databases.retrieve' : method === 'PATCH' ? 'databases.update' : 'databases.request';
  if (path[0] === 'pages') return path.length === 1 ? 'pages.create' : method === 'GET' ? 'pages.retrieve' : method === 'PATCH' ? 'pages.update' : 'pages.request';
  if (path[0] === 'blocks' && path[2] === 'children') return method === 'GET' ? 'blocks.children.list' : 'blocks.children.append';
  if (path[0] === 'blocks') return method === 'GET' ? 'blocks.retrieve' : method === 'PATCH' ? 'blocks.update' : 'blocks.delete';
  return `${path[0] ?? 'unknown'}.request`;
}

export class NotionRequestQueue {
  private reservation: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private cooldownUntil = 0;

  private async reserveStart(signal?: AbortSignal): Promise<number> {
    const previous = this.reservation;
    let release!: () => void;
    this.reservation = new Promise<void>((resolve) => { release = resolve; });
    try {
      await abortableWaitFor(previous, signal);
      const waitMs = Math.max(0, this.nextStartAt - Date.now(), this.cooldownUntil - Date.now());
      if (waitMs) await abortableDelay(waitMs, signal);
      this.nextStartAt = Date.now() + REQUEST_SPACING_MS;
      return waitMs;
    } finally { release(); }
  }

  private defer(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
  }

  async run<T>(operation: string, method: string, request: () => Promise<T>, observer?: (event: NotionRequestTelemetry) => void, safeRead = false, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
      let queueWaitMs: number;
      try { queueWaitMs = await this.reserveStart(signal); }
      catch (error) {
        try { observer?.({ operation, outcome: 'failed', duration_ms: 0, error: { code: error instanceof ShotError ? error.code : 'QUEUE_CANCELLED' }, details: { attempt } }); } catch { /* telemetry is best effort */ }
        throw error;
      }
      if (signal?.aborted) throw cancelledRequest();
      const started = performance.now();
      try {
        const result = await request();
        try { observer?.({ operation, outcome: 'success', duration_ms: performance.now() - started, details: { attempt, queue_wait_ms: queueWaitMs } }); } catch { /* telemetry is best effort */ }
        return result;
      } catch (error: any) {
        const status = typeof error?.status === 'number' ? error.status : undefined;
        const code = typeof error?.code === 'string' ? error.code : undefined;
        const retryAfter = retryAfterSeconds(error);
        const body = notionBody(error);
        const reason = typeof body?.additional_data?.rate_limit_reason === 'string' ? body.additional_data.rate_limit_reason : undefined;
        const rateLimited = status === 429 || status === 529 || code === 'rate_limited' || code === 'service_overload';
        const serverReadFailure = safeRead && [500, 502, 503, 504].includes(status ?? 0);
        const retryable = rateLimited ? reason !== 'public_api_request_blocked' : serverReadFailure;
        const exponentialDelayMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
        const nextWaitMs = Math.max(retryAfter !== undefined ? retryAfter * 1_000 : 0, exponentialDelayMs);
        if (rateLimited && retryable) this.defer(nextWaitMs);
        const errorDetails = {
          ...(code && /^[A-Za-z0-9_.:-]{1,96}$/.test(code) ? { code } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
          ...(typeof error?.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code) ? { network_code: error.code } : {}),
        };
        if (retryable && attempt < MAX_REQUEST_ATTEMPTS) {
          try { observer?.({ operation, outcome: 'retry', duration_ms: performance.now() - started, error: errorDetails, details: { attempt, queue_wait_ms: queueWaitMs, retry_after_seconds: retryAfter, http_status: status, rate_limit_reason: reason } }); } catch { /* telemetry is best effort */ }
          try { await abortableDelay(nextWaitMs + Math.floor(Math.random() * 251), signal); }
          catch (cancelError) {
            try { observer?.({ operation, outcome: 'failed', duration_ms: 0, error: { code: cancelError instanceof ShotError ? cancelError.code : 'QUEUE_CANCELLED' }, details: { attempt } }); } catch { /* telemetry is best effort */ }
            throw cancelError;
          }
          continue;
        }
        try { observer?.({ operation, outcome: 'failed', duration_ms: performance.now() - started, error: errorDetails, details: { attempt, queue_wait_ms: queueWaitMs, retry_after_seconds: retryAfter, http_status: status, rate_limit_reason: reason } }); } catch { /* telemetry is best effort */ }
        throw error;
      }
    }
    throw new Error('Notion request retry loop ended unexpectedly.');
  }
}

const queuesByConnection = new Map<string, NotionRequestQueue>();
function requestQueue(token: string): NotionRequestQueue {
  const key = createHash('sha256').update(token).digest('hex');
  let queue = queuesByConnection.get(key);
  if (!queue) { queue = new NotionRequestQueue(); queuesByConnection.set(key, queue); }
  return queue;
}

function scheduledClient(token: string, observer?: (event: NotionRequestTelemetry) => void, signal: () => AbortSignal | undefined = () => undefined): Client {
  const client = new Client({ auth: token });
  const original = client.request.bind(client);
  const queue = requestQueue(token);
  client.request = ((parameters: RequestParameters) => {
    const operation = notionOperation(parameters);
    const method = parameters.method.toUpperCase();
    const safeRead = ['GET', 'HEAD'].includes(method) || /\.query$|\.list$|\.retrieve$/.test(operation);
    return queue.run(operation, method, () => original(parameters), observer, safeRead, signal());
  }) as typeof client.request;
  return client;
}

export type NotionRequestObserver = (event: NotionRequestTelemetry) => void;
export function databaseIdFromUrl(value: string): string {
  const matched = value.match(/[0-9a-f]{32}(?:[?#].*)?$/i)?.[0]?.slice(0, 32) ?? value.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (!matched) fail('CONFIG_INVALID', 'The Notion database URL does not contain a database ID.');
  return matched!.replace(/-/g, '');
}
export class NotionStore {
  readonly client: Client;
  private requestSignal?: AbortSignal;
  private requestTelemetryEnabled = true;
  constructor(token: string, requestObserver?: NotionRequestObserver) {
    this.client = scheduledClient(token, event => { if (this.requestTelemetryEnabled) requestObserver?.(event); }, () => this.requestSignal);
  }
  setRequestSignal(signal?: AbortSignal): void { this.requestSignal = signal; }
  setRequestTelemetryEnabled(enabled: boolean): void { this.requestTelemetryEnabled = enabled; }
  async database(id: string): Promise<any> { try { return await this.client.databases.retrieve({ database_id: id }); } catch (e) { return failNotion(e, 'NOTION_UNAVAILABLE', 'Configured Invocation database is inaccessible.'); } }
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
    } catch (e) { return failNotion(e, 'NOTION_INIT_FAILED', 'Could not configure the supplied Invocation database.'); }
  }
  async createInvocation(databaseId: string, id: string): Promise<Invocation> { try { const page: any = await this.client.pages.create({ parent: { database_id: databaseId }, properties: { ID: { title: [{ text: { content: id } }] }, State: { select: { name: 'pending' } }, Error: { rich_text: [] } } }); return { id, pageId: page.id, state: 'pending', error: '' }; } catch (e) { return failNotion(e, 'INVOCATION_CREATE_FAILED', 'Could not create pending invocation.'); } }
  private invocation(page: any, id: string): Invocation {
    const state = page.properties?.State?.select?.name;
    if (!STATES.includes(state)) fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State.`);
    return { id, pageId: page.id, state, error: text(page.properties?.Error?.rich_text) };
  }
  // The Notion title is the durable, public Job identity.  Never retain a separate page-ID map.
  async findInvocation(databaseId: string, id: string): Promise<Invocation | undefined> { try {
    const found: any = await this.client.databases.query({ database_id: databaseId, filter: { property: 'ID', title: { equals: id } }, page_size: 100 });
    if (found.results.length > 1) fail('INVALID_INVOCATION_STATE', `Job ${id} has duplicate Notion records.`);
    return found.results[0] ? this.invocation(found.results[0], id) : undefined;
  } catch (e) { return failNotion(e, 'NOTION_UNAVAILABLE', `Could not resolve Job ${id}.`); } }
  async listInvocations(databaseId: string): Promise<Invocation[]> { try {
    const found: any = await this.client.databases.query({ database_id: databaseId, sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 });
    return found.results.map((page: any) => {
      const id = text(page.properties?.ID?.title);
      if (!id) fail('INVALID_INVOCATION_STATE', 'Invocation record has no ID.');
      return this.invocation(page, id);
    });
  } catch (e) { return failNotion(e, 'NOTION_UNAVAILABLE', 'Could not list Jobs.'); } }
  async deleteInvocation(pageId: string, id: string): Promise<void> { try { await this.client.pages.update({ page_id: pageId, archived: true }); } catch (e) { return failNotion(e, 'NOTION_UNAVAILABLE', `Could not clean up undelivered invocation ${id}.`); } }
  async readInvocation(pageId: string, id: string): Promise<Invocation> { try { return this.invocation(await this.client.pages.retrieve({ page_id: pageId }), id); } catch (e) { return failNotion(e, 'NOTION_UNAVAILABLE', `Could not read invocation ${id}.`); } }
  async children(pageId: string): Promise<any[]> { try { let cursor: string | undefined; const all: any[] = []; do { const r: any = await this.client.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }); all.push(...r.results); cursor = r.has_more ? r.next_cursor : undefined; } while(cursor); return all; } catch (e) { return failNotion(e, 'RESULT_READ_FAILED', 'Could not read invocation Result.'); } }
}
