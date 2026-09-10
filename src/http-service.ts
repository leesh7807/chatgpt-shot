import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, type Config } from './config.js';
import { databaseIdFromUrl, NotionStore } from './notion.js';
import { ChatGPTBrowser, manualLogin, shutdownBroker } from './browser.js';
import { submit } from './service.js';
import { isErrorCode, ShotError, fail } from './errors.js';

export type Discovery = { pid: number; host: '127.0.0.1'; port: number; protocolVersion: 1; credential: string };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const responseError = (error: unknown) => error instanceof ShotError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
export function readDiscovery(config: Pick<Config, 'discoveryPath'> = loadConfig()): Discovery | undefined { try { const record = JSON.parse(readFileSync(config.discoveryPath, 'utf8')); return record?.host === '127.0.0.1' && Number.isInteger(record.port) && typeof record.credential === 'string' ? record : undefined; } catch { return undefined; } }
function publish(config: Config, record: Discovery) { const temporary = `${config.discoveryPath}.${process.pid}.${randomBytes(4).toString('hex')}`; writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, config.discoveryPath); chmodSync(config.discoveryPath, 0o600); }
function removeDiscovery(config: Pick<Config, 'discoveryPath'>, credential?: string) { const current = readDiscovery(config); if (!credential || current?.credential === credential) try { unlinkSync(config.discoveryPath); } catch {} }
export const SUBMIT_TRANSPORT_TIMEOUT_MS = 0;
export async function call<T>(record: Discovery, path: string, body?: unknown, signal?: AbortSignal): Promise<T> { return await new Promise<T>((resolve, reject) => { const payload = body === undefined ? undefined : JSON.stringify(body); const timeout = path === '/submit' ? SUBMIT_TRANSPORT_TIMEOUT_MS : 10_000; const req = httpRequest({ host: record.host, port: record.port, path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${record.credential}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, ...(timeout ? { timeout } : {}) }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => { try { const parsed = JSON.parse(text) as { code?: unknown; message?: unknown }; if (res.statusCode !== 200) { if (isErrorCode(parsed.code)) reject(new ShotError(parsed.code, typeof parsed.message === 'string' ? parsed.message : 'Service request failed.')); else reject(new Error(typeof parsed.message === 'string' ? parsed.message : 'Service request failed.')); } else resolve(parsed as T); } catch (error) { reject(error); } }); }); const abort = () => req.destroy(new ShotError('INVOCATION_CANCELLED', 'The caller cancelled this invocation.')); if (signal?.aborted) return abort(); signal?.addEventListener('abort', abort, { once: true }); req.once('error', reject); if (timeout) req.once('timeout', () => req.destroy(new Error('Service request timed out.'))); if (payload) req.write(payload); req.end(); }); }
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
export async function stopService(config: Pick<Config, 'discoveryPath'> = loadConfig()): Promise<void> { const record = await healthy(config); if (!record) { removeDiscovery(config); return; } await call(record, '/stop', {}); for (let n = 0; n < 100; n++) { if (!await healthy(config)) return; await delay(100); } fail('BROWSER_UNAVAILABLE', 'Service did not stop cleanly.'); }
export async function login(config = loadConfig()) { await stopService(config); await manualLogin(config.browserProfilePath); }
export async function runService(): Promise<void> {
  const config = loadConfig(); const startupToken = process.env.CHATGPT_SHOT_STARTUP_TOKEN; if (!startupToken || !claimStartup(config, startupToken)) return fail('BROWSER_UNAVAILABLE', 'Service startup ownership was superseded.') as never; const credential = randomBytes(32).toString('base64url'); let stopping = false; let active = 0; let server: ReturnType<typeof createServer>;
  const stop = async () => { if (stopping) return; stopping = true; if (active) await new Promise<void>(resolve => { const timer = setInterval(() => { if (!active) { clearInterval(timer); resolve(); } }, 25); }); await shutdownBroker(config.browserProfilePath); await new Promise<void>(resolve => server.close(() => resolve())); removeDiscovery(config, credential); releaseStartup(config, startupToken); };
  server = createServer(async (req, res) => { const unauthorized = () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'A current service credential is required.' })); };
    if (req.headers.authorization !== `Bearer ${credential}`) return unauthorized();
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ pid: process.pid, protocolVersion: 1, accepting: !stopping })); }
    if (req.url === '/stop' && req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stopping: true })); void stop(); return; }
    if (req.url !== '/submit' || req.method !== 'POST' || stopping) { res.writeHead(stopping ? 503 : 404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: stopping ? 'SERVICE_STOPPING' : 'NOT_FOUND', message: 'Service is not accepting this request.' })); }
    active++; let released = false; const release = () => { if (!released) { released = true; active--; } }; let body = ''; const controller = new AbortController(); let browser: ChatGPTBrowser | undefined; const cancel = () => { if (!res.writableEnded) { controller.abort(); void browser?.close(); } }; req.on('aborted', () => { cancel(); release(); }); res.on('close', cancel); req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', async () => { try { const prompt = JSON.parse(body).prompt; if (typeof prompt !== 'string' || !prompt) fail('CONFIG_INVALID', 'submit requires a non-empty prompt.'); const invocationConfig = loadConfig(); const store = new NotionStore(invocationConfig.notionToken); store.validateSchema(await store.database(databaseIdFromUrl(invocationConfig.databaseUrl))); browser = new ChatGPTBrowser(invocationConfig.browserProfilePath); const result = await submit(store, databaseIdFromUrl(invocationConfig.databaseUrl), browser, prompt, { acknowledgementMs: invocationConfig.acknowledgementMs, executionMs: invocationConfig.executionMs, signal: controller.signal }); if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result })); } } catch (error) { if (!res.destroyed) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify(responseError(error))); } } finally { release(); } }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); }); const address = server.address(); if (!address || typeof address === 'string') return fail('INTERNAL_ERROR', 'Service did not obtain a TCP port.') as never; publish(config, { pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential }); process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
