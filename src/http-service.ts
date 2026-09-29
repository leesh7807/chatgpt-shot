import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, type Config } from './config.js';
import { databaseIdFromUrl, NotionStore } from './notion.js';
import { ChatGPTBrowser, openProfileBrowser, shutdownBroker } from './browser.js';
import { startJob } from './service.js';
import { isErrorCode, ShotError, fail } from './errors.js';

export type Discovery = { pid: number; host: '127.0.0.1'; port: number; protocolVersion: 1; credential: string };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const responseError = (error: unknown) => error instanceof ShotError ? { code: error.code, message: error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) } : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
export function readDiscovery(config: Pick<Config, 'discoveryPath'> = loadConfig()): Discovery | undefined { try { const record = JSON.parse(readFileSync(config.discoveryPath, 'utf8')); return record?.host === '127.0.0.1' && Number.isInteger(record.port) && typeof record.credential === 'string' ? record : undefined; } catch { return undefined; } }
function publish(config: Config, record: Discovery) { const temporary = `${config.discoveryPath}.${process.pid}.${randomBytes(4).toString('hex')}`; writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, config.discoveryPath); chmodSync(config.discoveryPath, 0o600); }
export function removeDiscovery(config: Pick<Config, 'discoveryPath'>, expectedCredential: string) { const current = readDiscovery(config); if (current?.credential !== expectedCredential) return; try { unlinkSync(config.discoveryPath); } catch {} }
export const JOB_TRANSPORT_TIMEOUT_MS = 0;
export const REQUEST_BODY_TIMEOUT_MS = 30_000;
export async function call<T>(record: Discovery, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const timeout = (path === '/jobs' && body !== undefined) || path === '/prepare-open' ? 0 : 10_000;
    const req = httpRequest({ host: record.host, port: record.port, path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${record.credential}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, ...(timeout ? { timeout } : {}) }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => {
        try {
          const parsed = JSON.parse(text) as { code?: unknown; message?: unknown; diagnostics?: unknown };
          if (res.statusCode !== 200) {
            if (isErrorCode(parsed.code)) { const error = new ShotError(parsed.code, typeof parsed.message === 'string' ? parsed.message : 'Service request failed.'); if (parsed.diagnostics !== undefined) error.diagnostics = parsed.diagnostics; reject(error); }
            else reject(new Error(typeof parsed.message === 'string' ? parsed.message : 'Service request failed.'));
          } else resolve(parsed as T);
        } catch (error) { reject(error); }
      });
    });
    const abort = () => req.destroy(new ShotError('ADMISSION_CANCELLED', 'The caller cancelled Job admission.'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true }); req.once('error', reject);
    if (timeout) req.once('timeout', () => req.destroy(new Error('Service request timed out.')));
    if (payload) req.write(payload); req.end();
  });
}
export type ServiceStatus = { record: Discovery; accepting: boolean; state: 'ready' | 'browser-open' | 'stopping' };
export async function serviceStatus(config: Pick<Config, 'discoveryPath'> = loadConfig()): Promise<ServiceStatus | undefined> {
  const record = readDiscovery(config); if (!record) return undefined;
  try {
    const status = await call<{ pid: number; protocolVersion: number; accepting?: boolean; state?: string }>(record, '/health');
    const state = status.state === 'ready' || status.state === 'browser-open' || status.state === 'stopping' ? status.state : status.accepting === false ? 'stopping' : 'ready';
    return status.pid === record.pid && status.protocolVersion === 1 ? { record, accepting: status.accepting !== false, state } : undefined;
  } catch { return undefined; }
}
export async function healthy(config: Pick<Config, 'discoveryPath'> = loadConfig()): Promise<Discovery | undefined> { return (await serviceStatus(config))?.record; }
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }
type StartupRecord = { pid: number; token: string };
type StartupLock = StartupRecord & { fd: number };
type ManualOpenRecord = { pid: number; token: string; browserPid?: number };
type ManualOpenLock = ManualOpenRecord & { fd: number };
function readStartup(config: Config): StartupRecord | undefined { try { const record = JSON.parse(readFileSync(config.lockPath, 'utf8')); return Number.isInteger(record?.pid) && typeof record?.token === 'string' ? record : undefined; } catch { return undefined; } }
function lock(config: Config): StartupLock | undefined { try { const fd = openSync(config.lockPath, 'wx', 0o600); const record = { pid: process.pid, token: randomBytes(24).toString('base64url') }; writeFileSync(fd, JSON.stringify(record)); chmodSync(config.lockPath, 0o600); return { fd, ...record }; } catch { return undefined; } }
function releaseStartup(config: Config, token: string, fd?: number) { try { if (readStartup(config)?.token === token) unlinkSync(config.lockPath); } catch {} finally { if (fd !== undefined) try { closeSync(fd); } catch {} } }
function reclaimStaleStartup(config: Config): boolean { const owner = readStartup(config); if (owner && processAlive(owner.pid)) return false; if (readStartup(config)?.token !== owner?.token) return false; try { unlinkSync(config.lockPath); return true; } catch { return false; } }
function claimStartup(config: Config, token: string): boolean { const owner = readStartup(config); if (owner?.token !== token) return false; writeFileSync(config.lockPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); chmodSync(config.lockPath, 0o600); return true; }
function readManualOpen(config: Config): ManualOpenRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(config.manualOpenLockPath, 'utf8'));
    return Number.isInteger(record?.pid) && record.pid > 0 && typeof record?.token === 'string' && (record.browserPid === undefined || (Number.isInteger(record.browserPid) && record.browserPid > 0)) ? record : undefined;
  } catch { return undefined; }
}
function publishManualOpen(config: Config, record: ManualOpenRecord) {
  const temporary = `${config.manualOpenLockPath}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, config.manualOpenLockPath); chmodSync(config.manualOpenLockPath, 0o600);
}
function lockManualOpen(config: Config): ManualOpenLock | undefined {
  const record = { pid: process.pid, token: randomBytes(24).toString('base64url') };
  const temporary = `${config.manualOpenLockPath}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); chmodSync(temporary, 0o600);
    linkSync(temporary, config.manualOpenLockPath);
    const fd = openSync(config.manualOpenLockPath, 'r');
    try { unlinkSync(temporary); } catch {}
    return { fd, ...record };
  } catch {
    try { if (readManualOpen(config)?.token === record.token) unlinkSync(config.manualOpenLockPath); } catch {}
    try { unlinkSync(temporary); } catch {}
    return undefined;
  }
}
function updateManualOpen(config: Config, token: string, browserPid: number) {
  const current = readManualOpen(config); if (current?.token === token) publishManualOpen(config, { ...current, browserPid });
}
function releaseManualOpen(config: Config, token: string, fd?: number) {
  try { if (readManualOpen(config)?.token === token) unlinkSync(config.manualOpenLockPath); }
  catch {} finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
function reclaimStaleManualOpen(config: Config): boolean {
  const owner = readManualOpen(config); if (!owner) return false;
  if (processAlive(owner.pid) || (owner.browserPid !== undefined && processAlive(owner.browserPid))) return false;
  if (readManualOpen(config)?.token !== owner.token) return false;
  try { unlinkSync(config.manualOpenLockPath); return true; } catch { return false; }
}
export async function ensureService(config = loadConfig()): Promise<Discovery> {
  for (let n = 0; n < 100; n++) {
    const status = await serviceStatus(config);
    if (status && status.state !== 'stopping') return status.record;
    if (status?.state === 'stopping') { await delay(100); continue; }
    if (existsSync(config.manualOpenLockPath)) {
      if (reclaimStaleManualOpen(config)) continue;
      return fail('SERVICE_BUSY', 'The retained browser profile is open for manual use. Close Chrome and retry.') as never;
    }
    const startup = lock(config);
    if (!startup) { reclaimStaleStartup(config); await delay(100); continue; }
    let child: ReturnType<typeof spawn> | undefined; let serviceOwnsStartup = false;
    try {
      if (existsSync(config.manualOpenLockPath)) return fail('SERVICE_BUSY', 'The retained browser profile is open for manual use. Close Chrome and retry.') as never;
      const stale = readDiscovery(config); if (stale && !processAlive(stale.pid)) removeDiscovery(config, stale.credential);
      child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__service'], { detached: true, stdio: 'ignore', env: { ...process.env, CHATGPT_SHOT_STARTUP_TOKEN: startup.token } }); child.unref();
      for (let wait = 0; wait < 100; wait++) {
        const found = await healthy(config);
        if (found) {
          if (found.pid === child.pid) serviceOwnsStartup = true;
          else child.kill('SIGTERM');
          return found;
        }
        await delay(100);
      }
      if (child.exitCode === null) child.kill('SIGTERM');
    } finally {
      // The Service keeps the startup token for its lifetime; only close the
      // parent's descriptor after the child has claimed that ownership.
      if (serviceOwnsStartup) { try { closeSync(startup.fd); } catch {} }
      else releaseStartup(config, startup.token, startup.fd);
    }
  }
  return fail('BROWSER_UNAVAILABLE', 'Could not start a healthy chatgpt-shot Service.') as never;
}
export async function openBrowser(config = loadConfig()): Promise<void> {
  let record = await healthy(config);
  if (!record && readDiscovery(config)) return fail('BROWSER_UNAVAILABLE', 'Service health could not be confirmed; discovery was preserved and the browser profile was not opened.') as never;
  if (!record && existsSync(config.lockPath) && !reclaimStaleStartup(config)) return fail('SERVICE_BUSY', 'Service startup or shutdown is in progress. Retry opening the profile shortly.') as never;
  if (existsSync(config.manualOpenLockPath) && !reclaimStaleManualOpen(config)) return fail('SERVICE_BUSY', 'The retained browser profile is already open for manual use.') as never;
  const owner = lockManualOpen(config);
  if (!owner) return fail('SERVICE_BUSY', 'The retained browser profile is already open or Service startup is in progress.') as never;
  try {
    record = await healthy(config);
    if (record) await call(record, '/prepare-open', { token: owner.token });
    else {
      if (readDiscovery(config)) return fail('BROWSER_UNAVAILABLE', 'Service health could not be confirmed; discovery was preserved and the browser profile was not opened.') as never;
      if (existsSync(config.lockPath)) return fail('SERVICE_BUSY', 'Service startup or shutdown is in progress. Retry opening the profile shortly.') as never;
      await shutdownBroker(config.browserProfilePath);
    }
    await openProfileBrowser(config.browserProfilePath, browserPid => updateManualOpen(config, owner.token, browserPid));
  } finally { releaseManualOpen(config, owner.token, owner.fd); }
}
export async function stopService(config: Pick<Config, 'discoveryPath'> = loadConfig()): Promise<void> {
  const record = await healthy(config);
  if (!record) {
    if (existsSync(config.discoveryPath)) return fail('BROWSER_UNAVAILABLE', 'Service health could not be confirmed; discovery was preserved and no stop request was sent.') as never;
    return;
  }
  await call(record, '/stop', {});
  while ((await healthy(config))?.credential === record.credential) await delay(100);
}
export async function runService(): Promise<void> {
  const config = loadConfig(); const startupToken = process.env.CHATGPT_SHOT_STARTUP_TOKEN;
  if (!startupToken || !claimStartup(config, startupToken)) return fail('BROWSER_UNAVAILABLE', 'Service startup ownership was superseded.') as never;
  const credential = randomBytes(32).toString('base64url'); let stopping = false; let openingBrowser = false; let active = 0; let server: ReturnType<typeof createServer>;
  const admissions = new Set<AbortController>();
  const json = (res: any, status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
  const jsonError = (res: any, error: unknown) => {
    if (error instanceof ShotError && error.code === 'NOTION_RATE_LIMITED') {
      if (error.retryAfterSeconds !== undefined) res.setHeader('retry-after', String(error.retryAfterSeconds));
      return json(res, 429, responseError(error));
    }
    return json(res, 500, responseError(error));
  };
  const durable = async (store: NotionStore, databaseId: string, id: string) => {
    const invocation = await store.findInvocation(databaseId, id);
    if (!invocation) return undefined;
    return { id: invocation.id, state: invocation.state, error: invocation.error || null, result: invocation.state === 'completed' ? await (await import('./serialize.js')).markdownResult(store, invocation.pageId) : null };
  };
  const stop = async () => { if (stopping) return; stopping = true; for (const admission of admissions) admission.abort(); if (active || admissions.size) await new Promise<void>(resolve => { const timer = setInterval(() => { if (!active && !admissions.size) { clearInterval(timer); resolve(); } }, 25); }); await shutdownBroker(config.browserProfilePath); await new Promise<void>(resolve => server.close(() => resolve())); removeDiscovery(config, credential); releaseStartup(config, startupToken); };
  server = createServer(async (req, res) => {
    const unauthorized = () => json(res, 401, { code: 'UNAUTHORIZED', message: 'A current service credential is required.' });
    if (req.headers.authorization !== `Bearer ${credential}`) return unauthorized();
    if (req.url === '/health' && req.method === 'GET') {
      if (existsSync(config.manualOpenLockPath)) reclaimStaleManualOpen(config);
      const manualOpen = existsSync(config.manualOpenLockPath);
      return json(res, 200, { pid: process.pid, protocolVersion: 1, accepting: !stopping && !openingBrowser && !manualOpen, state: stopping ? 'stopping' : openingBrowser || manualOpen ? 'browser-open' : 'ready' });
    }
    if (req.url === '/stop' && req.method === 'POST') { json(res, 200, { stopping: true }); void stop(); return; }
    if (req.url === '/prepare-open' && req.method === 'POST') {
      let token: unknown;
      try {
        let body = ''; req.setEncoding('utf8');
        for await (const chunk of req) body += chunk;
        token = JSON.parse(body)?.token;
      } catch { return json(res, 400, { code: 'CONFIG_INVALID', message: 'prepare-open requires its current profile reservation token.' }); }
      if (stopping) return json(res, 503, { code: 'SERVICE_STOPPING', message: 'Service is stopping and cannot open the browser profile.' });
      if (existsSync(config.manualOpenLockPath)) reclaimStaleManualOpen(config);
      const owner = readManualOpen(config);
      if (!owner || owner.token !== token || owner.browserPid !== undefined || !processAlive(owner.pid)) return json(res, 409, { code: 'SERVICE_BUSY', message: 'The browser profile reservation is missing, stale, or already open; retry opening the profile.' });
      if (openingBrowser || active || admissions.size) return json(res, 409, { code: 'SERVICE_BUSY', message: 'The browser profile is busy with admitted work or another manual browser session. Retry when it is idle.' });
      openingBrowser = true;
      try { await shutdownBroker(config.browserProfilePath); return json(res, 200, { ready: true }); }
      catch (error) { return json(res, 500, responseError(error)); }
      finally { openingBrowser = false; }
    }
    const match = req.url?.match(/^\/jobs\/([0-9a-f-]+)$/i);
    if ((req.method === 'GET' && (req.url === '/jobs' || match))) {
      try { const current = loadConfig(); const store = new NotionStore(current.notionToken); const databaseId = databaseIdFromUrl(current.databaseUrl); store.validateSchema(await store.database(databaseId));
        if (match) { const value = await durable(store, databaseId, match[1]); return value ? json(res, 200, value) : json(res, 404, { code: 'NOT_FOUND', message: 'Job does not exist.' }); }
        const jobs = await store.listInvocations(databaseId); return json(res, 200, { jobs: jobs.map(job => ({ id: job.id, state: job.state, error: job.error || null })) });
      } catch (error) { return jsonError(res, error); }
    }
    if (req.url !== '/jobs' || req.method !== 'POST') { req.resume(); return json(res, 404, { code: 'NOT_FOUND', message: 'Service is not accepting this request.' }); }
    if (stopping || openingBrowser || existsSync(config.manualOpenLockPath)) { if (existsSync(config.manualOpenLockPath)) reclaimStaleManualOpen(config); const manualOpen = existsSync(config.manualOpenLockPath); req.resume(); return json(res, 503, stopping ? { code: 'SERVICE_STOPPING', message: 'Service is not accepting this request.' } : { code: 'SERVICE_BUSY', message: manualOpen ? 'The browser profile is open for manual use. Retry after the browser window closes.' : 'Service is preparing the browser profile.' }); }
    let body = ''; const bodyDeadline = setTimeout(() => req.destroy(), REQUEST_BODY_TIMEOUT_MS); bodyDeadline.unref();
    const clearBodyDeadline = () => clearTimeout(bodyDeadline);
    req.once('aborted', clearBodyDeadline); req.once('close', clearBodyDeadline); req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', async () => {
      clearBodyDeadline();
      try {
        const input = JSON.parse(body); const prompt = input?.prompt; const diagnostics = input?.diagnostics === true; const fields = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof prompt !== 'string' || !prompt.trim() || fields.some(field => field !== 'prompt' && field !== 'diagnostics') || (input.diagnostics !== undefined && typeof input.diagnostics !== 'boolean')) fail('CONFIG_INVALID', 'jobs requires a non-empty prompt and an optional diagnostics boolean.');
        const current = loadConfig(); const store = new NotionStore(current.notionToken); const databaseId = databaseIdFromUrl(current.databaseUrl); store.validateSchema(await store.database(databaseId));
        if (stopping || openingBrowser || existsSync(config.manualOpenLockPath)) { if (existsSync(config.manualOpenLockPath)) reclaimStaleManualOpen(config); const manualOpen = existsSync(config.manualOpenLockPath); return json(res, 503, stopping ? { code: 'SERVICE_STOPPING', message: 'Service is not accepting this request.' } : { code: 'SERVICE_BUSY', message: manualOpen ? 'The browser profile is open for manual use. Retry after the browser window closes.' : 'Service is preparing the browser profile.' }); }
        const id = randomUUID();
        const admission = new AbortController(); admissions.add(admission);
        try { const run = await startJob(store, databaseId, new ChatGPTBrowser(current.browserProfilePath, undefined, diagnostics), prompt, id, { acknowledgementMs: current.acknowledgementMs, signal: admission.signal, diagnostics }); active++; void run.completion.catch(() => {}).finally(() => { active--; }); return json(res, 200, { id }); }
        finally { admissions.delete(admission); }
      } catch (error) {
        const manualOpen = existsSync(config.manualOpenLockPath);
        if (manualOpen) reclaimStaleManualOpen(config);
        if (stopping) return json(res, 503, { code: 'SERVICE_STOPPING', message: 'Service is not accepting this request.' });
        if (openingBrowser || manualOpen) return json(res, 503, { code: 'SERVICE_BUSY', message: 'The browser profile is reserved for manual use. Retry after the browser window closes.' });
        return jsonError(res, error);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); }); const address = server.address(); if (!address || typeof address === 'string') return fail('INTERNAL_ERROR', 'Service did not obtain a TCP port.') as never; publish(config, { pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential }); process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
