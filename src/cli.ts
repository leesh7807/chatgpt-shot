#!/usr/bin/env node
import { loadConfig, paths, readConfigValues, setConfigValue, type ConfigKey } from './config.js';
import { ShotError, fail } from './errors.js';
import { NotionStore, databaseIdFromUrl } from './notion.js';
import { ChatGPTBrowser } from './browser.js';
import { call, ensureService, healthy, login, runService, stopService } from './http-service.js';
const out = (value: string) => process.stdout.write(`${value}\n`);
async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'config') {
    const [action, key, ...valueParts] = rest; const state = paths();
    if (action === 'path' && !key) return out(state.envPath);
    if (action === 'show' && !key) { const values = readConfigValues(state); return out(`configuration: ${state.envPath}\nNOTION_TOKEN: ${values.NOTION_TOKEN ? 'set' : 'missing'}\nCHATGPT_SHOT_NOTION_DATABASE_URL: ${values.CHATGPT_SHOT_NOTION_DATABASE_URL ? 'set' : 'missing'}`); }
    if (action === 'set' && (key === 'NOTION_TOKEN' || key === 'CHATGPT_SHOT_NOTION_DATABASE_URL') && valueParts.length) { setConfigValue(key as ConfigKey, valueParts.join(' '), state); return out(`saved ${key}`); }
    return fail('CONFIG_INVALID', 'Usage: chatgpt-shot config <path|show|set NOTION_TOKEN <value>|set CHATGPT_SHOT_NOTION_DATABASE_URL <url>>');
  }
  const config = loadConfig(); const databaseId = databaseIdFromUrl(config.databaseUrl);
  if (command === '__service') return runService();
  if (command === '__broker') { const { runBroker } = await import('./broker.js'); return runBroker(config.browserProfilePath); }
  if (command === 'init') { if (rest.length) return fail('CONFIG_INVALID', 'Usage: chatgpt-shot init'); const store = new NotionStore(config.notionToken); const database = await store.database(databaseId); try { store.validateSchema(database); out(`already initialized: ${databaseId}`); } catch (error) { if (!(error instanceof ShotError) || error.code !== 'NOTION_SCHEMA_INVALID' || !store.isProvisionable(database)) throw error; await store.initializeSchema(database); store.validateSchema(await store.database(databaseId)); out(`initialized: ${databaseId}`); } return; }
  if (command === 'login') { out('Plain system Chrome opened with the dedicated chatgpt-shot profile. Authenticate manually, then close it to continue.'); await login(config); out('ChatGPT authentication is available in the retained service profile.'); return; }
  if (command === 'start') { out(String((await ensureService(config)).port)); return; }
  if (command === 'status') { const record = await healthy(config); out(record ? `healthy ${record.host}:${record.port} pid=${record.pid}` : 'absent'); return; }
  if (command === 'port') { const record = await healthy(config); if (!record) return fail('BROWSER_UNAVAILABLE', 'No healthy chatgpt-shot Service is running.'); out(String(record.port)); return; }
  if (command === 'stop') { await stopService(config); out('chatgpt-shot Service stopped.'); return; }
  if (command === 'doctor') { const store = new NotionStore(config.notionToken); store.validateSchema(await store.database(databaseId)); const browser = new ChatGPTBrowser(config.browserProfilePath); await browser.withBrowser(async () => { await browser.ensureAvailable(); await browser.ensureAuthenticated(); await browser.openFreshContext(); }); out('OK: user configuration, Invocation database, browser profile, authenticated ChatGPT session, and composer are available. ChatGPT-to-Notion write access is not verified; confirm it with a smoke submit.'); return; }
  if (command === 'submit') { const prompt = rest.length === 1 ? rest[0] : undefined; if (!prompt) return fail('CONFIG_INVALID', 'Usage: chatgpt-shot submit "<prompt>"'); const record = await ensureService(config); out((await call<{ result: string }>(record, '/submit', { prompt })).result); return; }
  fail('CONFIG_INVALID', 'Usage: chatgpt-shot <config|init|login|doctor|start|status|port|submit|stop>');
}
main(process.argv.slice(2)).catch(e => { if (e instanceof ShotError) { process.stderr.write(`${e.code}: ${e.message}\n`); process.exitCode = 1; } else { process.stderr.write(`INTERNAL_ERROR: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; } });
