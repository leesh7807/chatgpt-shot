import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, type Config } from './config.js';
import { databaseIdFromUrl, NotionStore } from './notion.js';
import { ChatGPTBrowser, manualLogin, shutdownBroker } from './browser.js';
import { startJob, type JobExecution } from './service.js';
import { isErrorCode, ShotError, fail } from './errors.js';

export type Discovery = { pid: number; host: '127.0.0.1'; port: number; protocolVersion: 1; credential: string };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const responseError = (error: unknown) => error instanceof ShotError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
const jobId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function readDiscovery(config: Pick<Config, 'discoveryPath'> = loadConfig()): Discovery | undefined { try { const record = JSON.parse(readFileSync(config.discoveryPath, 'utf8')); return record?.host === '127.0.0.1' && Number.isInteger(record.port) && typeof record.credential === 'string' ? record : undefined; } catch { return undefined; } }
function publish(config: Config, record: Discovery) { const temporary = `${config.discoveryPath}.${process.pid}.${randomBytes(4).toString('hex')}`; writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, config.discoveryPath); chmodSync(config.discoveryPath, 0o600); }
function removeDiscovery(config: Pick<Config, 'discoveryPath'>, credential?: string) { const current = readDiscovery(config); if (!credential || current?.credential === credential) try { unlinkSync(config.discoveryPath); } catch {} }
export const SUBMIT_TRANSPORT_TIMEOUT_MS = 0;
export const JOB_TRANSPORT_TIMEOUT_MS = 0;
export const REQUEST_BODY_TIMEOUT_MS = 30_000;
export async function call<T>(record: Discovery, path: string, body?: unknown, signal?: AbortSignal): Promise<T> { return await new Promise<T>((resolve, reject) => { const payload = body === undefined ? undefined : JSON.stringify(body); const timeout = path === '/submit' ? SUBMIT_TRANSPORT_TIMEOUT_MS : path === '/jobs' && body !== undefined ? JOB_TRANSPORT_TIMEOUT_MS : 10_000; const req = httpRequest({ host: record.host, port: record.port, path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${record.credential}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, ...(timeout ? { timeout } : {}) }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => { try { const parsed = JSON.parse(text) as { code?: unknown; message?: unknown }; if (res.statusCode !== 200) { if (isErrorCode(parsed.code)) reject(new ShotError(parsed.code, typeof parsed.message === 'string' ? parsed.message : 'Service request failed.')); else reject(new Error(typeof parsed.message === 'string' ? parsed.message : 'Service request failed.')); } else resolve(parsed as T); } catch (error) { reject(error); } }); }); const abort = () => req.destroy(new ShotError('INVOCATION_CANCELLED', 'The caller cancelled this invocation.')); if (signal?.aborted) return abort(); signal?.addEventListener('abort', abort, { once: true }); req.once('error', reject); if (timeout) req.once('timeout', () => req.destroy(new Error('Service request timed out.'))); if (payload) req.write(payload); req.end(); }); }
export async function healthy(config: Pick<Config, 'discoveryPath'> = loadConfig()): Promise<Discovery | undefined> { const record = readDiscovery(config); if (!record) return undefined; try { const status = await call<{ pid: number; protocolVersion: number }>(record, '/health'); return status.pid === record.pid && status.protocolVersion === 1 ? record : undefined; } catch { return undefined; } }
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
type StartupRecord = { pid: number; token: string };
type StartupLock = StartupRecord & { fd: number };
function readStartup(config: Config): StartupRecord | undefined { try { const record = JSON.parse(readFileSync(config.lockPath, 'utf8')); return Number.isInteger(record?.pid) && typeof record?.token === 'string' ? record : undefined; } catch { return undefined; } }
function lock(config: Config): StartupLock | undefined { try { const fd = openSync(config.lockPath, 'wx', 0o600); const record = { pid: process.pid, token: randomBytes(24).toString('base64url') }; writeFileSync(fd, JSON.stringify(record)); chmodSync(config.lockPath, 0o600); return { fd, ...record }; } catch { return undefined; } }
function releaseStartup(config: Config, token: string, fd?: number) { try { if (readStartup(config)?.token === token) unlinkSync(config.lockPath); } catch {} finally { if (fd !== undefined) try { closeSync(fd); } catch {} } }
function reclaimStaleStartup(config: Config): boolean { const owner = readStartup(config); if (owner && processAlive(owner.pid)) return false; try { unlinkSync(config.lockPath); return true; } catch { return false; } }
function claimStartup(config: Config, token: string): boolean { const owner = readStartup(config); if (owner?.token !== token) return false; writeFileSync(config.lockPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); chmodSync(config.lockPath, 0o600); return true; }
export async function ensureService(config = loadConfig()): Promise<Discovery> {
  for (let n = 0; n < 100; n++) {
    const existing = await healthy(config); if (existing) return existing;
    const stale = readDiscovery(config); if (stale && !processAlive(stale.pid)) removeDiscovery(config);
    const startup = lock(config);
    if (!startup) { reclaimStaleStartup(config); await delay(100); continue; }
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__service'], { detached: true, stdio: 'ignore', env: { ...process.env, CHATGPT_SHOT_STARTUP_TOKEN: startup.token } }); child.unref();
    try {
      for (let wait = 0; wait < 100; wait++) { const found = await healthy(config); if (found) return found; await delay(100); }
      if (child.exitCode === null) child.kill('SIGTERM');
    } finally { releaseStartup(config, startup.token, startup.fd); }
  }
  return fail('BROWSER_UNAVAILABLE', 'Could not start a healthy chatgpt-shot Service.') as never;
}
export async function stopService(config: Pick<Config, 'discoveryPath'> = loadConfig()): Promise<void> { const record = await healthy(config); if (!record) { removeDiscovery(config); return; } await call(record, '/stop', {}); while (await healthy(config)) await delay(100); }
export async function login(config = loadConfig()) { await stopService(config); await manualLogin(config.browserProfilePath); }
export async function runService(): Promise<void> {
  const config = loadConfig(); const startupToken = process.env.CHATGPT_SHOT_STARTUP_TOKEN;
  if (!startupToken || !claimStartup(config, startupToken)) return fail('BROWSER_UNAVAILABLE', 'Service startup ownership was superseded.') as never;
  const credential = randomBytes(32).toString('base64url'); let stopping = false; let active = 0; let server: ReturnType<typeof createServer>;
  const creating = new Map<string, Promise<JobExecution>>();
  const admissions = new Set<AbortController>();
  const json = (res: any, status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
  const durable = async (store: NotionStore, databaseId: string, id: string) => {
    const invocation = await store.findInvocation(databaseId, id);
    if (!invocation) return undefined;
    return { id: invocation.id, state: invocation.state, error: invocation.error || null, result: invocation.state === 'completed' ? await (await import('./serialize.js')).markdownResult(store, invocation.pageId) : null };
  };
  const stop = async () => { if (stopping) return; stopping = true; for (const admission of admissions) admission.abort(); if (active || admissions.size) await new Promise<void>(resolve => { const timer = setInterval(() => { if (!active && !admissions.size) { clearInterval(timer); resolve(); } }, 25); }); await shutdownBroker(config.browserProfilePath); await new Promise<void>(resolve => server.close(() => resolve())); removeDiscovery(config, credential); releaseStartup(config, startupToken); };
  server = createServer(async (req, res) => {
    const unauthorized = () => json(res, 401, { code: 'UNAUTHORIZED', message: 'A current service credential is required.' });
    if (req.headers.authorization !== `Bearer ${credential}`) return unauthorized();
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { pid: process.pid, protocolVersion: 1, accepting: !stopping });
    if (req.url === '/stop' && req.method === 'POST') { json(res, 200, { stopping: true }); void stop(); return; }
    const match = req.url?.match(/^\/jobs\/([0-9a-f-]+)$/i);
    if ((req.method === 'GET' && (req.url === '/jobs' || match))) {
      try { const current = loadConfig(); const store = new NotionStore(current.notionToken); const databaseId = databaseIdFromUrl(current.databaseUrl); store.validateSchema(await store.database(databaseId));
        if (match) { const value = await durable(store, databaseId, match[1]); return value ? json(res, 200, value) : json(res, 404, { code: 'NOT_FOUND', message: 'Job does not exist.' }); }
        const jobs = await store.listInvocations(databaseId); return json(res, 200, { jobs: jobs.map(job => ({ id: job.id, state: job.state, error: job.error || null })) });
      } catch (error) { return json(res, 500, responseError(error)); }
    }
    if ((req.url !== '/jobs' && req.url !== '/submit') || req.method !== 'POST' || stopping) return json(res, stopping ? 503 : 404, { code: stopping ? 'SERVICE_STOPPING' : 'NOT_FOUND', message: 'Service is not accepting this request.' });
    let body = ''; const bodyDeadline = setTimeout(() => req.destroy(), REQUEST_BODY_TIMEOUT_MS); bodyDeadline.unref();
    const clearBodyDeadline = () => clearTimeout(bodyDeadline);
    req.once('aborted', clearBodyDeadline); req.once('close', clearBodyDeadline); req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', async () => {
      clearBodyDeadline();
      try {
        const input = JSON.parse(body); const prompt = input.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) fail('CONFIG_INVALID', 'submit requires a non-empty prompt.');
        const id = req.url === '/jobs' ? input.id : randomUUID();
        if (!jobId(id)) fail('CONFIG_INVALID', 'jobs requires a UUID Job ID.');
        const current = loadConfig(); const store = new NotionStore(current.notionToken); const databaseId = databaseIdFromUrl(current.databaseUrl); store.validateSchema(await store.database(databaseId));
        if (stopping) return json(res, 503, { code: 'SERVICE_STOPPING', message: 'Service is not accepting this request.' });
        const admission = new AbortController(); admissions.add(admission);
        let execution = creating.get(id);
        if (!execution) {
          execution = startJob(store, databaseId, new ChatGPTBrowser(current.browserProfilePath), prompt, id, { acknowledgementMs: current.acknowledgementMs, executionMs: current.executionMs, signal: admission.signal }); creating.set(id, execution);
          void execution.then(run => { if (!run.created) return; active++; void run.completion.catch(() => {}).finally(() => { active--; }); }).catch(() => {}).finally(() => creating.delete(id));
        }
        let run: JobExecution;
        try { run = await execution; }
        finally { admissions.delete(admission); }
        if (req.url === '/jobs') { const value = await durable(store, databaseId, id); return json(res, 200, value ?? { id: run.job.id, state: run.job.state, error: run.job.error || null, result: null }); }
        try { const result = await run.completion; return json(res, 200, { result }); } catch (error) { return json(res, 500, responseError(error)); }
      } catch (error) { return json(res, stopping ? 503 : 500, stopping ? { code: 'SERVICE_STOPPING', message: 'Service is not accepting this request.' } : responseError(error)); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); }); const address = server.address(); if (!address || typeof address === 'string') return fail('INTERNAL_ERROR', 'Service did not obtain a TCP port.') as never; publish(config, { pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential }); process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
