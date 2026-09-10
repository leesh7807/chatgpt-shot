import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, type Config } from './config.js';
import { databaseIdFromUrl, NotionStore } from './notion.js';
import { ChatGPTBrowser, manualLogin, shutdownBroker } from './browser.js';
import { submit } from './service.js';
import { ShotError, fail } from './errors.js';

export type Discovery = { pid: number; host: '127.0.0.1'; port: number; protocolVersion: 1; credential: string };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const responseError = (error: unknown) => error instanceof ShotError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
export function readDiscovery(config = loadConfig()): Discovery | undefined { try { const record = JSON.parse(readFileSync(config.discoveryPath, 'utf8')); return record?.host === '127.0.0.1' && Number.isInteger(record.port) && typeof record.credential === 'string' ? record : undefined; } catch { return undefined; } }
function publish(config: Config, record: Discovery) { const temporary = `${config.discoveryPath}.${process.pid}.${randomBytes(4).toString('hex')}`; writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, config.discoveryPath); chmodSync(config.discoveryPath, 0o600); }
function removeDiscovery(config: Config, credential?: string) { const current = readDiscovery(config); if (!credential || current?.credential === credential) try { unlinkSync(config.discoveryPath); } catch {} }
export async function call<T>(record: Discovery, path: string, body?: unknown): Promise<T> { return await new Promise<T>((resolve, reject) => { const payload = body === undefined ? undefined : JSON.stringify(body); const req = httpRequest({ host: record.host, port: record.port, path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${record.credential}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, timeout: 10_000 }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => { try { const parsed = JSON.parse(text); if (res.statusCode !== 200) { const error: any = new Error(parsed.message); error.code = parsed.code; reject(error); } else resolve(parsed as T); } catch (error) { reject(error); } }); }); req.once('error', reject); req.once('timeout', () => req.destroy(new Error('Service request timed out.'))); if (payload) req.write(payload); req.end(); }); }
export async function healthy(config = loadConfig()): Promise<Discovery | undefined> { const record = readDiscovery(config); if (!record) return undefined; try { const status = await call<{ pid: number; protocolVersion: number }>(record, '/health'); return status.pid === record.pid && status.protocolVersion === 1 ? record : undefined; } catch { return undefined; } }
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function lock(config: Config): number | undefined { try { return openSync(config.lockPath, 'wx', 0o600); } catch { return undefined; } }
export async function ensureService(config = loadConfig()): Promise<Discovery> {
  const existing = await healthy(config); if (existing) return existing;
  const fd = lock(config);
  if (fd !== undefined) {
    try { removeDiscovery(config); const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__service'], { detached: true, stdio: 'ignore', env: process.env }); child.unref(); }
    finally { closeSync(fd); try { unlinkSync(config.lockPath); } catch {} }
  }
  for (let n = 0; n < 100; n++) { const found = await healthy(config); if (found) return found; const stale = readDiscovery(config); if (stale && !processAlive(stale.pid)) removeDiscovery(config); await delay(100); }
  return fail('BROWSER_UNAVAILABLE', 'Could not start a healthy chatgpt-shot Service.') as never;
}
export async function stopService(config = loadConfig()): Promise<void> { const record = await healthy(config); if (!record) { removeDiscovery(config); return; } await call(record, '/stop', {}); for (let n = 0; n < 100; n++) { if (!await healthy(config)) return; await delay(100); } fail('BROWSER_UNAVAILABLE', 'Service did not stop cleanly.'); }
export async function login(config = loadConfig()) { await stopService(config); await manualLogin(config.browserProfilePath); }
export async function runService(): Promise<void> {
  const config = loadConfig(); const credential = randomBytes(32).toString('base64url'); let stopping = false; let active = 0; let server: ReturnType<typeof createServer>;
  const stop = async () => { if (stopping) return; stopping = true; if (active) await new Promise<void>(resolve => { const timer = setInterval(() => { if (!active) { clearInterval(timer); resolve(); } }, 25); }); await shutdownBroker(config.browserProfilePath); await new Promise<void>(resolve => server.close(() => resolve())); removeDiscovery(config, credential); };
  server = createServer(async (req, res) => { const unauthorized = () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'A current service credential is required.' })); };
    if (req.headers.authorization !== `Bearer ${credential}`) return unauthorized();
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ pid: process.pid, protocolVersion: 1, accepting: !stopping })); }
    if (req.url === '/stop' && req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stopping: true })); void stop(); return; }
    if (req.url !== '/submit' || req.method !== 'POST' || stopping) { res.writeHead(stopping ? 503 : 404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: stopping ? 'SERVICE_STOPPING' : 'NOT_FOUND', message: 'Service is not accepting this request.' })); }
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', async () => { active++; try { const prompt = JSON.parse(body).prompt; if (typeof prompt !== 'string' || !prompt) fail('CONFIG_INVALID', 'submit requires a non-empty prompt.'); const store = new NotionStore(config.notionToken); store.validateSchema(await store.database(databaseIdFromUrl(config.databaseUrl))); const result = await submit(store, databaseIdFromUrl(config.databaseUrl), new ChatGPTBrowser(config.browserProfilePath), prompt); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result })); } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify(responseError(error))); } finally { active--; } }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); }); const address = server.address(); if (!address || typeof address === 'string') return fail('INTERNAL_ERROR', 'Service did not obtain a TCP port.') as never; publish(config, { pid: process.pid, host: '127.0.0.1', port: address.port, protocolVersion: 1, credential }); process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
