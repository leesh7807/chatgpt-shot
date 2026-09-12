#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, openConfigInDefaultEditor, paths, readConfigValues, setConfigValue, type ConfigKey } from './config.js';
import { ShotError, fail } from './errors.js';
import { NotionStore, databaseIdFromUrl } from './notion.js';
import { ChatGPTBrowser } from './browser.js';
import { call, ensureService, healthy, login, runService, stopService } from './http-service.js';
import { installCancellationHandler } from './cancellation.js';
const out = (value: string) => process.stdout.write(`${value}\n`);
const commands = ['config', 'init', 'login', 'doctor', 'start', 'status', 'port', 'submit', 'stop'] as const;
type Command = typeof commands[number];
type HelpScope = 'global' | Command;
export type ParsedCli = { kind: 'help'; scope: HelpScope } | { kind: 'command'; command: Command; rest: string[]; prompt?: string };
const submitUsage = 'Usage: chatgpt-shot submit "<prompt>"';

const globalHelp = `Usage: chatgpt-shot <command> [arguments]

Commands:
  config  View or update user configuration
  init    Create or validate the Notion Invocation database
  login   Open Chrome for manual ChatGPT authentication
  doctor  Check configuration, Notion, and browser readiness
  start   Start the local Service and print its port
  status  Report local Service health
  port    Print the healthy local Service port
  submit  Submit one prompt and wait for its completed Result
  stop    Stop the local Service after accepted work drains

Run "chatgpt-shot <command> --help" for command usage.`;
const commandHelp: Record<Command, string> = {
  config: `Usage:
  chatgpt-shot config
  chatgpt-shot config path
  chatgpt-shot config show
  chatgpt-shot config set KEY VALUE

Open or update the user configuration.

Forms:
  config                 Open the configuration file in the default editor.
  config path            Print the configuration-file path.
  config show            Show configured values without printing the token.
  config set KEY VALUE   Save one supported configuration value.

Supported keys: NOTION_TOKEN, CHATGPT_SHOT_NOTION_DATABASE_URL,
CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS, CHATGPT_SHOT_EXECUTION_TIMEOUT_MS.`,
  init: `Usage: chatgpt-shot init

Create or validate the configured Notion Invocation database.

Arguments: none.`,
  login: `Usage: chatgpt-shot login

Open the dedicated Chrome profile for manual ChatGPT authentication.

Arguments: none.`,
  doctor: `Usage: chatgpt-shot doctor

Check configuration, the Notion Invocation database, and browser readiness.

Arguments: none.`,
  start: `Usage: chatgpt-shot start

Start the local Service and print its port.

Arguments: none.`,
  status: `Usage: chatgpt-shot status

Report whether the local Service is healthy.

Arguments: none.`,
  port: `Usage: chatgpt-shot port

Print the port of the healthy local Service.

Arguments: none.`,
  submit: `${submitUsage}

Submit exactly one non-empty prompt and wait for its completed Result.

Arguments:
  <prompt>   One positional prompt argument; quote it when it contains spaces.`,
  stop: `Usage: chatgpt-shot stop

Stop the local Service after accepted work drains.

Arguments: none.`
};
const isHelp = (value: string) => value === '--help' || value === '-h';
const isCommand = (value: string): value is Command => (commands as readonly string[]).includes(value);

export function parseCli(args: string[]): ParsedCli {
  if (args.length === 1 && isHelp(args[0])) return { kind: 'help', scope: 'global' };
  const [candidate, ...rest] = args;
  if (!candidate || !isCommand(candidate)) fail('CONFIG_INVALID', `Usage: chatgpt-shot <command|--help>`);
  const command = candidate as Command;
  if (rest.length === 1 && isHelp(rest[0])) return { kind: 'help', scope: command };
  if (command === 'submit') {
    const prompt = rest.length === 1 ? rest[0] : undefined;
    if (!prompt?.trim()) fail('CONFIG_INVALID', submitUsage);
    return { kind: 'command', command, rest, prompt };
  }
  return { kind: 'command', command, rest };
}

export async function main(args: string[]) {
  // These are private detached-process entry points, never public CLI commands.
  if (args[0] === '__service') return runService();
  if (args[0] === '__broker') { const config = loadConfig(); const { runBroker } = await import('./broker.js'); return runBroker(config.browserProfilePath); }
  const parsed = parseCli(args);
  if (parsed.kind === 'help') return out(parsed.scope === 'global' ? globalHelp : commandHelp[parsed.scope]);
  const { command, rest } = parsed;
  if (command === 'config') {
    const [action, key, ...valueParts] = rest; const state = paths();
    if (!action) { await openConfigInDefaultEditor(state); return out(`opened configuration: ${state.envPath}`); }
    if (action === 'path' && !key) return out(state.envPath);
    if (action === 'show' && !key) { const values = readConfigValues(state); return out(`configuration: ${state.envPath}\nNOTION_TOKEN: ${values.NOTION_TOKEN ? 'set' : 'missing'}\nCHATGPT_SHOT_NOTION_DATABASE_URL: ${values.CHATGPT_SHOT_NOTION_DATABASE_URL ? 'set' : 'missing'}\nCHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS: ${values.CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS ?? '45000 (default)'}\nCHATGPT_SHOT_EXECUTION_TIMEOUT_MS: ${values.CHATGPT_SHOT_EXECUTION_TIMEOUT_MS ?? '1800000 (default)'}`); }
    if (action === 'set' && (key === 'NOTION_TOKEN' || key === 'CHATGPT_SHOT_NOTION_DATABASE_URL' || key === 'CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS' || key === 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS') && valueParts.length) { setConfigValue(key as ConfigKey, valueParts.join(' '), state); return out(`saved ${key}`); }
    return fail('CONFIG_INVALID', 'Usage: chatgpt-shot config [path|show|set KEY VALUE]');
  }
  const config = loadConfig(); const databaseId = databaseIdFromUrl(config.databaseUrl);
  if (command === 'init') { if (rest.length) return fail('CONFIG_INVALID', 'Usage: chatgpt-shot init'); const store = new NotionStore(config.notionToken); const database = await store.database(databaseId); try { store.validateSchema(database); out(`already initialized: ${databaseId}`); } catch (error) { if (!(error instanceof ShotError) || error.code !== 'NOTION_SCHEMA_INVALID' || !store.isProvisionable(database)) throw error; await store.initializeSchema(database); store.validateSchema(await store.database(databaseId)); out(`initialized: ${databaseId}`); } return; }
  if (command === 'login') { out('Plain system Chrome opened with the dedicated chatgpt-shot profile. Authenticate manually, then close it to continue.'); await login(config); out('ChatGPT authentication is available in the retained service profile.'); return; }
  if (command === 'start') { out(String((await ensureService(config)).port)); return; }
  if (command === 'status') { const record = await healthy(config); out(record ? `healthy ${record.host}:${record.port} pid=${record.pid}` : 'absent'); return; }
  if (command === 'port') { const record = await healthy(config); if (!record) return fail('BROWSER_UNAVAILABLE', 'No healthy chatgpt-shot Service is running.'); out(String(record.port)); return; }
  if (command === 'stop') { await stopService(config); out('chatgpt-shot Service stopped.'); return; }
  if (command === 'doctor') { const store = new NotionStore(config.notionToken); store.validateSchema(await store.database(databaseId)); const browser = new ChatGPTBrowser(config.browserProfilePath); await browser.withBrowser(async () => { await browser.ensureAvailable(); await browser.ensureAuthenticated(); await browser.openFreshContext(); }); out('OK: user configuration, Invocation database, browser profile, authenticated ChatGPT session, and composer are available. ChatGPT-to-Notion write access is not verified; confirm it with a smoke submit.'); return; }
  if (command === 'submit') { const record = await ensureService(config); const controller = new AbortController(); const remove = installCancellationHandler(async () => controller.abort()); try { out((await call<{ result: string }>(record, '/submit', { prompt: parsed.prompt! }, controller.signal)).result); } finally { remove(); } return; }
  fail('CONFIG_INVALID', 'Usage: chatgpt-shot <config|init|login|doctor|start|status|port|submit|stop>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).catch(e => { if (e instanceof ShotError) { process.stderr.write(`${e.code}: ${e.message}\n`); process.exitCode = 1; } else { process.stderr.write(`INTERNAL_ERROR: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; } });
