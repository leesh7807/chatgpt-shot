#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConfig, openConfigInDefaultEditor, paths, readConfigValues, setConfigValue, type ConfigKey } from './config.js';
import { ShotError, fail } from './errors.js';
import { NotionStore, databaseIdFromUrl } from './notion.js';
import { ChatGPTBrowser } from './browser.js';
import { call, ensureService, healthy, openBrowser, runService, serviceStatus, stopService } from './http-service.js';
import { installCancellationHandler } from './cancellation.js';
import { readRecentJobTelemetry } from './job-telemetry.js';
import { buildAttemptRecoveryReport, type RemoteJobObservation } from './recovery.js';
const out = (value: string) => process.stdout.write(value + String.fromCharCode(10));
const commands = ['config', 'init', 'open', 'doctor', 'start', 'status', 'port', 'submit', 'jobs', 'attempts', 'inspect', 'stop'] as const;
type Command = typeof commands[number];
type HelpScope = 'global' | Command;
export type ParsedCli = { kind: 'help'; scope: HelpScope } | { kind: 'command'; command: Command; rest: string[]; prompt?: string; diagnostics?: boolean; observeApproval?: boolean; doctorBrowser?: boolean };
const submitUsage = 'Usage: chatgpt-shot submit [--diagnostics] [--observe-approval] "<prompt>"';
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const globalHelp = `Usage: chatgpt-shot <command> [arguments]

Commands:
  config  View or update user configuration
  init    Create or validate the Notion Invocation database
  open    Open the retained browser profile for manual interaction
  doctor  Passively check configuration, local state, Service, and Notion
  start   Start the local Service and print its port
  status  Report local Service health
  port    Print the healthy local Service port
  submit  Submit one prompt and print its accepted Job UUID
  jobs    List durable Jobs or read one Job
  attempts Analyze the latest 100 local submission attempts
  inspect Read-only local Attempt and remote Job recovery information
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
CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS.`,
  init: `Usage: chatgpt-shot init

Create or validate the configured Notion Invocation database.

Arguments: none.`,
  open: `Usage: chatgpt-shot open

Open the retained Chrome profile for manual sign-in or browser checks.
When the Service is running, it stays available but rejects new submissions until Chrome closes.
An admission still using the browser must finish first. Accepted Jobs can continue while the browser is open because their submission tabs are already closed.
Closing Chrome does not verify authentication or browser-check results.

Arguments: none.`,
  doctor: `Usage: chatgpt-shot doctor [--browser]

Passively check configuration, local diagnostics, the existing Service, and accessible Notion state without starting a Service or browser.
Add --browser to explicitly check the private browser runtime and authenticated session. It never opens visible Chrome.`,
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

Submit exactly one non-empty prompt and print its accepted Job UUID.
Add --diagnostics to include redacted browser observations on submission failure.
Add --observe-approval to save before/after screenshots when an approval button is clicked.

Arguments:
  <prompt>        One positional prompt argument; quote it when it contains spaces.
  --diagnostics   Return editor, send-control, and post-submit observations on failure.
  --observe-approval Save approval-card screenshots locally and attach their filenames to the click log.`,
  jobs: `Usage:
  chatgpt-shot jobs
  chatgpt-shot jobs <id>

List recent durable Jobs, or read one Job's current State, Result, or Error.`,
  attempts: `Usage:
  chatgpt-shot attempts
  chatgpt-shot attempts <uuid>

Read the latest 100 local submission diagnostic trails without contacting Notion.`,
  inspect: `Usage: chatgpt-shot inspect <uuid>

Read local Attempt evidence and reconcile the matching remote Invocation when Notion access is available.
Returns JSON describing observed delivery, remote state, retry safety, and the next action. It never submits or starts a Service or browser.`,
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
  if (command === 'open' && rest.length) fail('CONFIG_INVALID', 'Usage: chatgpt-shot open');
  if (command === 'doctor') {
    const doctorBrowser = rest.length === 1 && rest[0] === '--browser';
    if (rest.length && !doctorBrowser) fail('CONFIG_INVALID', 'Usage: chatgpt-shot doctor [--browser]');
    return { kind: 'command', command, rest, ...(doctorBrowser ? { doctorBrowser: true } : {}) };
  }
  if (command === 'submit') {
    let offset = 0;
    let diagnostics = false;
    let observeApproval = false;
    while (rest[offset] === '--diagnostics' || rest[offset] === '--observe-approval') {
      if (rest[offset] === '--diagnostics') diagnostics = true;
      if (rest[offset] === '--observe-approval') observeApproval = true;
      offset++;
    }
    const promptArgs = rest.slice(offset);
    const prompt = promptArgs.length === 1 ? promptArgs[0] : undefined;
    if (!prompt?.trim() || prompt === '--wait') fail('CONFIG_INVALID', submitUsage);
    return { kind: 'command', command, rest, prompt, ...(diagnostics ? { diagnostics: true } : {}), ...(observeApproval ? { observeApproval: true } : {}) };
  }
  if (command === 'jobs' && rest.length > 1) fail('CONFIG_INVALID', 'Usage: chatgpt-shot jobs [id]');
  if (command === 'attempts' && (rest.length > 1 || (rest[0] !== undefined && !isUuid(rest[0])))) fail('CONFIG_INVALID', 'Usage: chatgpt-shot attempts [uuid]');
  if (command === 'inspect' && (rest.length !== 1 || !isUuid(rest[0]))) fail('CONFIG_INVALID', 'Usage: chatgpt-shot inspect <uuid>');
  return { kind: 'command', command, rest };
}

async function confirmVisibleBrowser(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('USER_INTERVENTION_REQUIRED', 'Opening visible Chrome requires a terminal and your confirmation. Run `chatgpt-shot open` in a terminal, review the prompt, and type yes to continue.');
  out('This will open visible Chrome with the retained chatgpt-shot profile for manual sign-in or browser checks. It will not automate sign-in or verify the result.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('Open visible Chrome now? [y/N] ');
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) fail('USER_INTERVENTION_REQUIRED', 'Visible Chrome was not opened. Rerun `chatgpt-shot open` and type yes if you want to continue.');
  } finally { prompt.close(); }
}

export async function inspectAttempt(attemptId: string): Promise<Record<string, unknown>> {
  const normalizedId = attemptId.toLowerCase();
  let attempt;
  let localErrorCode: string | undefined;
  try { attempt = readRecentJobTelemetry(undefined, normalizedId)[0]; }
  catch (error) { localErrorCode = error instanceof ShotError ? error.code : 'LOCAL_DIAGNOSTICS_UNAVAILABLE'; }
  let remote: RemoteJobObservation;
  let serviceReadError: unknown;
  // An existing authenticated Service is independent of caller-side Notion
  // configuration, so try its read-only recovery route first.
  let running: Awaited<ReturnType<typeof serviceStatus>>;
  try {
    const state = paths();
    running = await serviceStatus({ discoveryPath: state.discoveryPath });
  } catch {
    running = undefined;
  }
  if (running) {
    try {
      const report = await call<Record<string, unknown>>(running.record, `/attempts/${normalizedId}`);
      if (localErrorCode) report.local_attempt = { found: false, status: 'unavailable', code: localErrorCode, source: 'local_attempt_telemetry', authority: 'local_evidence' };
      return report;
    } catch (error) {
      // The Service may become unreachable after its health check. Keep the
      // independent read-only Notion reconciliation available in that race.
      serviceReadError = error;
    }
  }
  const serviceRead = serviceReadError
    ? { status: 'failed' as const, code: serviceReadError instanceof ShotError ? serviceReadError.code : 'SERVICE_READ_FAILED' }
    : undefined;
  try {
    const config = loadConfig();
    // Inspect is read-only. When an existing Service cannot be reached, keep
    // reconciliation available through the same configured Notion read used
    // when no Service is present; do not start or repair that Service here.
    const invocation = await new NotionStore(config.notionToken).findInvocation(databaseIdFromUrl(config.databaseUrl), normalizedId);
    remote = invocation
      ? { status: invocation.state === 'pending' ? 'pending' : 'accepted', source: 'notion', job: { id: invocation.id, state: invocation.state, ...(invocation.error ? { error: invocation.error } : {}) }, ...(serviceRead ? { service_read: serviceRead } : {}) }
      : { status: 'not_found', source: 'notion', ...(serviceRead ? { service_read: serviceRead } : {}) };
  } catch (error) {
    const code = error instanceof ShotError ? error.code : 'INTERNAL_ERROR';
    remote = {
      status: 'unavailable',
      source: 'notion',
      code,
      reason: code === 'CONFIG_INVALID' ? 'configuration_unavailable' : 'notion_lookup_failed',
      ...(serviceRead ? { service_read: serviceRead } : {}),
    };
  }
  return buildAttemptRecoveryReport(normalizedId, attempt, remote, localErrorCode);
}

async function readJobs(attemptId?: string) {
  const state = paths();
  const running = await serviceStatus({ discoveryPath: state.discoveryPath });
  if (running && running.state !== 'stopping') {
    return call(running.record, attemptId ? `/jobs/${attemptId}` : '/jobs');
  }
  const config = loadConfig();
  return call(await ensureService(config), attemptId ? `/jobs/${attemptId}` : '/jobs');
}

export async function doctor(browser: boolean): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {};
  const capabilities: Record<string, unknown> = {};
  let config: ReturnType<typeof loadConfig> | undefined;
  let existingService: Awaited<ReturnType<typeof serviceStatus>> | undefined;
  let discoveryPresent = false;
  let state: ReturnType<typeof paths> | undefined;
  let failed = false;
  try {
    config = loadConfig();
    checks.configuration = { status: 'passed', source: config.envPath };
  } catch (error) {
    const code = error instanceof ShotError ? error.code : 'INTERNAL_ERROR';
    checks.configuration = { status: 'failed', code };
    failed = true;
  }
  try { state = paths(); checks.local_state = { status: 'checked' }; }
  catch (error) {
    const code = error instanceof ShotError ? error.code : 'LOCAL_STATE_UNAVAILABLE';
    checks.local_state = { status: 'failed', code };
    failed = true;
  }
  try {
    const attempts = readRecentJobTelemetry().length;
    checks.local_attempts = { status: 'checked', count: attempts, source: 'local_attempt_telemetry' };
    capabilities.local_diagnostics = { status: 'available' };
  } catch (error) {
    const code = error instanceof ShotError ? error.code : 'LOCAL_DIAGNOSTICS_UNAVAILABLE';
    checks.local_attempts = { status: 'failed', code };
    capabilities.local_diagnostics = { status: 'unavailable', code };
    failed = true;
  }
  try {
    const discoveryPath = state?.discoveryPath ?? config?.discoveryPath;
    if (!discoveryPath) throw new Error('Service discovery path is unavailable.');
    existingService = await serviceStatus({ discoveryPath });
    discoveryPresent = existsSync(discoveryPath);
    checks.service = existingService
      ? { status: existingService.state, accepting: existingService.accepting, pid: existingService.record.pid }
      : { status: discoveryPresent ? 'unavailable' : 'absent', started_by_doctor: false };
    if (discoveryPresent && !existingService) failed = true;
  } catch (error) {
    const code = error instanceof ShotError ? error.code : 'SERVICE_HEALTH_UNAVAILABLE';
    checks.service = { status: 'unavailable', code, started_by_doctor: false };
    failed = true;
  }
  let serviceReadFailed = false;
  if (existingService) {
    try {
      const jobs = await call<{ jobs?: unknown[] }>(existingService.record, '/jobs');
      checks.service_read = { status: 'passed', check: 'authenticated Service Job read' };
      checks.notion = { status: 'passed', check: 'authenticated Service Job read', visible_jobs: jobs.jobs?.length ?? null };
      capabilities.notion_read = { status: 'available', verified_by: 'existing_service_read' };
    } catch (error) {
      const code = error instanceof ShotError ? error.code : 'SERVICE_READ_FAILED';
      checks.service_read = { status: 'failed', code, check: 'authenticated Service Job read' };
      serviceReadFailed = true;
      failed = true;
      // A Service health response can race with a later Service read failure.
      // Recheck health without relying on caller-side Notion configuration.
      const discoveryPath = state?.discoveryPath ?? config?.discoveryPath;
      existingService = discoveryPath ? await serviceStatus({ discoveryPath }) : undefined;
      checks.service = existingService
        ? { status: existingService.state, accepting: existingService.accepting, pid: existingService.record.pid }
        : { status: 'unavailable', started_by_doctor: false };
      if (!existingService) failed = true;
    }
  } else {
    checks.service_read = { status: 'not_checked', reason: config ? 'service_unavailable' : 'configuration_unavailable' };
  }
  if (config && (!existingService || serviceReadFailed)) {
    try {
      const store = new NotionStore(config.notionToken);
      store.validateSchema(await store.database(databaseIdFromUrl(config.databaseUrl)));
      checks.notion = { status: 'passed', check: serviceReadFailed ? 'Invocation database schema after Service read failure' : 'Invocation database schema' };
      capabilities.notion_read = { status: 'available', verified_by: serviceReadFailed ? 'schema_read_after_service_read_failure' : 'schema_read' };
    } catch (error) {
      const code = error instanceof ShotError ? error.code : 'INTERNAL_ERROR';
      checks.notion = { status: 'failed', code };
      capabilities.notion_read = { status: 'unavailable', code };
      failed = true;
    }
  } else {
    if (!config && (serviceReadFailed || !existingService)) {
      checks.notion = { status: 'not_checked', reason: 'configuration_unavailable' };
      capabilities.notion_read = { status: serviceReadFailed ? 'not_checked' : 'unavailable', reason: 'configuration_unavailable' };
    }
  }
  if (browser && state) {
    try {
      const runtime = new ChatGPTBrowser(state.browserProfilePath);
      await runtime.withBrowser(async () => {
        await runtime.ensureAvailable();
        await runtime.ensureAuthenticated();
        await runtime.openFreshContext();
      });
      checks.private_browser = { status: 'passed', check: 'private browser and authenticated session' };
      capabilities.private_browser = { status: 'available', authorization: 'not_submission_authorization' };
    } catch (error) {
      const code = error instanceof ShotError ? error.code : 'INTERNAL_ERROR';
      const needsHuman = code === 'CHATGPT_AUTH_REQUIRED' || code === 'USER_INTERVENTION_REQUIRED';
      checks.private_browser = needsHuman
        ? { status: 'human_intervention_required', code, next_action: 'Run chatgpt-shot open in a terminal, confirm visible Chrome, and complete sign-in or the browser check yourself.' }
        : { status: 'failed', code };
      capabilities.private_browser = { status: needsHuman ? 'requires_human_intervention' : 'unavailable', code };
      failed = true;
    }
  } else {
    const reason = browser ? 'local_state_unavailable' : 'passive_diagnosis';
    checks.private_browser = { status: 'not_checked', reason };
    capabilities.private_browser = browser
      ? { status: 'unavailable', reason }
      : { status: 'not_checked', requires: 'doctor --browser' };
  }
  checks.visible_browser = { status: 'not_requested', action: 'chatgpt-shot open requires interactive confirmation' };
  capabilities.visible_browser_intervention = { status: 'not_requested', authorization: 'not_granted' };
  const report = { schema_version: 1, mode: browser ? 'active_browser' : 'passive', checks, capabilities };
  if (failed) process.exitCode = 1;
  return report;
}

export async function main(args: string[]) {
  // These are private detached-process entry points, never public CLI commands.
  if (args[0] === '__service') return runService();
  if (args[0] === '__broker') { const config = loadConfig(); const { runBroker } = await import('./broker.js'); return runBroker(config.browserProfilePath); }
  const parsed = parseCli(args);
  if (parsed.kind === 'help') return out(parsed.scope === 'global' ? globalHelp : commandHelp[parsed.scope]);
  const { command, rest } = parsed;
  if (command === 'attempts') return out(JSON.stringify({ attempts: readRecentJobTelemetry(undefined, rest[0]) }, null, 2));
  if (command === 'inspect') return out(JSON.stringify(await inspectAttempt(rest[0]), null, 2));
  if (command === 'jobs') return out(JSON.stringify(await readJobs(rest[0])));
  if (command === 'open') { await confirmVisibleBrowser(); await openBrowser(paths()); out('Manual browser session closed. Authentication and browser-check results were not verified.'); return; }
  if (command === 'config') {
    const [action, key, ...valueParts] = rest; const state = paths();
    if (!action) { await openConfigInDefaultEditor(state); return out(`opened configuration: ${state.envPath}`); }
    if (action === 'path' && !key) return out(state.envPath);
    if (action === 'show' && !key) { const values = readConfigValues(state); return out(`configuration: ${state.envPath}\nNOTION_TOKEN: ${values.NOTION_TOKEN ? 'set' : 'missing'}\nCHATGPT_SHOT_NOTION_DATABASE_URL: ${values.CHATGPT_SHOT_NOTION_DATABASE_URL ? 'set' : 'missing'}\nCHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS: ${values.CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS ?? '180000 (3 minutes default)'}`); }
    if (action === 'set' && (key === 'NOTION_TOKEN' || key === 'CHATGPT_SHOT_NOTION_DATABASE_URL' || key === 'CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS') && valueParts.length) { setConfigValue(key as ConfigKey, valueParts.join(' '), state); return out(`saved ${key}`); }
    return fail('CONFIG_INVALID', 'Usage: chatgpt-shot config [path|show|set KEY VALUE]');
  }
  if (command === 'doctor') return out(JSON.stringify(await doctor(parsed.doctorBrowser === true), null, 2));
  const config = loadConfig(); const databaseId = databaseIdFromUrl(config.databaseUrl);
  if (command === 'init') { if (rest.length) return fail('CONFIG_INVALID', 'Usage: chatgpt-shot init'); const store = new NotionStore(config.notionToken); const database = await store.database(databaseId); try { store.validateSchema(database); out(`already initialized: ${databaseId}`); } catch (error) { if (!(error instanceof ShotError) || error.code !== 'NOTION_SCHEMA_INVALID' || !store.isProvisionable(database)) throw error; await store.initializeSchema(database); store.validateSchema(await store.database(databaseId)); out(`initialized: ${databaseId}`); } return; }
  if (command === 'start') { out(String((await ensureService(config)).port)); return; }
  if (command === 'status') { const status = await serviceStatus(config); out(!status ? 'absent' : `${status.state === 'ready' ? 'healthy' : status.state} ${status.record.host}:${status.record.port} pid=${status.record.pid}`); return; }
  if (command === 'port') { const record = await healthy(config); if (!record) return fail('BROWSER_UNAVAILABLE', 'No healthy chatgpt-shot Service is running.'); out(String(record.port)); return; }
  if (command === 'stop') { await stopService(config); out('chatgpt-shot Service stopped.'); return; }
  if (command === 'submit') {
    const record = await ensureService(config); const controller = new AbortController();
    const remove = installCancellationHandler(async () => { controller.abort(); });
    try {
      const accepted = await call<{ id: string }>(record, '/jobs', { prompt: parsed.prompt!, ...(parsed.diagnostics ? { diagnostics: true } : {}), ...(parsed.observeApproval ? { observeApproval: true } : {}) }, controller.signal);
      if (!isUuid(accepted.id)) throw new ShotError('INTERNAL_ERROR', 'Service returned an invalid Job ID.');
      out(accepted.id);
    } finally { remove(); }
    return;
  }
  fail('CONFIG_INVALID', 'Usage: chatgpt-shot <config|init|open|doctor|start|status|port|submit|jobs|attempts|inspect|stop>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const newline = String.fromCharCode(10);
    if (error instanceof ShotError) {
      process.stderr.write(error.code + ': ' + error.message + newline);
      if (error.diagnostics !== undefined) process.stderr.write('BROWSER_DIAGNOSTICS: ' + JSON.stringify(error.diagnostics, null, 2) + newline);
      if (error.attemptId) process.stderr.write('RECOVERY_JSON: ' + JSON.stringify({ schema_version: 1, attempt_id: error.attemptId, inspect_command: 'chatgpt-shot inspect ' + error.attemptId, automatic_retry: false }) + newline);
    } else {
      process.stderr.write('INTERNAL_ERROR: ' + (error instanceof Error ? error.message : String(error)) + newline);
    }
    process.exitCode = 1;
  });
}
