import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { brokerRequest, brokerSocket } from './broker.js';
import { fail, isStaleBrowserSessionError } from './errors.js';

export type Inspection = 'submitted' | 'not_submitted' | 'uncertain';
export type BrowserDiagnosticEntry = { offset_ms: number; stage: string; [key: string]: unknown };
export interface BrowserTransport { withBrowser<T>(operation: () => Promise<T>): Promise<T>; ensureAvailable(): Promise<void>; ensureAuthenticated(): Promise<void>; openFreshContext(): Promise<void>; fillPrompt(prompt: string, submissionMarker: string): Promise<void>; submitPrompt(submissionMarker: string): Promise<void>; inspectSubmission(submissionMarker: string): Promise<Inspection>; close(): Promise<void>; diagnosticReport?(): BrowserDiagnosticEntry[]; }

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const profilePath = (profile: string) => profile;
const systemChrome = () => [process.env.CHATGPT_SHOT_BROWSER, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path): path is string => Boolean(path && existsSync(path)));
async function request(root: string, operation: string, sessionId?: string, prompt?: string, submissionMarker?: string, send: typeof brokerRequest = brokerRequest, diagnostics = false) { try { return await send(root, { operation, sessionId, prompt, submissionMarker, ...(diagnostics ? { diagnostics: true } : {}) }); } catch (error: any) { if (error.code) return fail(error.code, error.message); throw error; } }
export async function ensureBroker(profile: string) {
  const absent = (error: any) => error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED';
  try { await request(profile, 'ensure'); return; } catch (error: any) {
    if (!absent(error)) throw error;
    if (error.code === 'ECONNREFUSED') try { unlinkSync(brokerSocket(profile)); } catch {}
  }
  if (!existsSync(process.argv[1])) fail('BROWSER_UNAVAILABLE', 'Cannot locate the chatgpt-shot broker entry point.');
  // Development execution via tsx supplies the TypeScript loader through execArgv; retain it when
  // the detached broker is spawned so the broker has the same executable semantics as its caller.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__broker'], { detached: true, stdio: 'ignore' }); child.unref();
  for (let attempt = 0; attempt < 50; attempt++) { try { await request(profile, 'ensure'); return; } catch (error: any) { if (!absent(error)) throw error; await wait(100); } }
  fail('BROWSER_UNAVAILABLE', 'Could not start the local ChatGPT browser broker.');
}
export async function manualLogin(profile: string): Promise<void> {
  await shutdownBroker(profile);
  const executable = systemChrome(); if (!executable) fail('BROWSER_UNAVAILABLE', 'A supported system Chrome executable is required for manual login.');
  const path = profilePath(profile); mkdirSync(path, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => { const child: import('node:child_process').ChildProcess = spawn(executable!, [`--user-data-dir=${path}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com/'], { stdio: 'ignore' }); child.once('error', reject); child.once('close', () => resolve()); });
}
export async function shutdownBroker(root: string): Promise<void> {
  try { await request(root, 'shutdown'); }
  catch (error: any) {
    // No broker is the normal first-login and already-shut-down state. Do not conceal a live
    // broker's shutdown failure, which has a different error category.
    if (error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED') return;
    throw error;
  }
}

export class ChatGPTBrowser implements BrowserTransport {
  private sessionId?: string;
  private readonly diagnostics: BrowserDiagnosticEntry[] = [];
  private diagnosticStartedAt?: number;
  private observationTask?: Promise<void>;
  constructor(private readonly profile: string, private readonly send: typeof brokerRequest = brokerRequest, private readonly diagnosticsEnabled = false) {}
  private async rpc(operation: string, sessionId?: string, prompt?: string, submissionMarker?: string) { return request(this.profile, operation, sessionId, prompt, submissionMarker, this.send, this.diagnosticsEnabled); }
  private recordDiagnostic(stage: string, value: Record<string, unknown>) {
    if (!this.diagnosticsEnabled) return;
    this.diagnosticStartedAt ??= Date.now();
    this.diagnostics.push({ offset_ms: Date.now() - this.diagnosticStartedAt, stage, ...value });
  }
  private collectDiagnostic(value: unknown, fallbackStage: string) {
    if (!this.diagnosticsEnabled || !value || typeof value !== 'object') return;
    const result = value as Record<string, any>;
    if (result.before || result.after || result.method) {
      this.recordDiagnostic('submit_action', { method: result.method, selectedButton: result.button ?? result.selectedButton ?? null, ...(result.reason ? { reason: result.reason } : {}) });
      if (result.before && typeof result.before === 'object') this.collectDiagnostic(result.before, 'before_submit');
      if (result.after && typeof result.after === 'object') this.collectDiagnostic(result.after, 'after_submit_immediate');
      return;
    }
    if (result.snapshot && typeof result.snapshot === 'object') {
      if (typeof result.inspection === 'string') this.recordDiagnostic('submission_classification', { inspection: result.inspection });
      this.collectDiagnostic(result.snapshot, 'snapshot');
      return;
    }
    if (Array.isArray(result.snapshots)) {
      for (const snapshot of result.snapshots) this.collectDiagnostic(snapshot, 'snapshot');
      return;
    }
    const { stage, ...details } = result;
    this.recordDiagnostic(typeof stage === 'string' && stage !== 'snapshot' ? stage : fallbackStage, details);
  }
  private async sampleAfterSubmit(sessionId: string, submissionMarker: string) {
    const started = Date.now();
    for (const deadline of [500, 2_000, 5_000]) {
      await wait(Math.max(0, started + deadline - Date.now()));
      try { this.collectDiagnostic(await this.rpc('snapshot', sessionId, undefined, submissionMarker), `after_submit_${deadline}ms`); }
      catch (error: any) { this.recordDiagnostic(`after_submit_${deadline}ms`, { sampleError: error?.code ?? error?.message ?? String(error) }); }
    }
  }
  private async invalidateSession() {
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (sessionId) await this.rpc('close', sessionId).catch(() => {});
  }
  private async openFreshContextOnce() { await this.close(); this.sessionId = await this.rpc('open'); }
  async withBrowser<T>(operation: () => Promise<T>) { try { return await operation(); } finally { await this.close(); } }
  async ensureAvailable() { await ensureBroker(this.profile); }
  async ensureAuthenticated() {
    let status: { authenticated?: boolean };
    try { status = await this.rpc('auth'); }
    catch (error) { if (isStaleBrowserSessionError(error)) fail('BROWSER_UNAVAILABLE', 'The retained browser session disappeared while checking authentication.'); throw error; }
    if (!status?.authenticated) fail('CHATGPT_AUTH_REQUIRED', 'ChatGPT authentication is required. Run `chatgpt-shot login`.');
  }
  async openFreshContext() {
    try { await this.openFreshContextOnce(); }
    catch (error) {
      if (!isStaleBrowserSessionError(error)) throw error;
      await this.invalidateSession();
      try { await this.openFreshContextOnce(); }
      catch (retryError) {
        if (isStaleBrowserSessionError(retryError)) { await this.invalidateSession(); fail('BROWSER_UNAVAILABLE', 'The browser session disappeared while opening an invocation page.'); }
        throw retryError;
      }
    }
  }
  async fillPrompt(prompt: string, submissionMarker: string) {
    if (!this.sessionId) fail('BROWSER_UNAVAILABLE', 'Browser invocation page is unavailable.');
    try { this.collectDiagnostic(await this.rpc('fill', this.sessionId, prompt, submissionMarker), 'after_fill'); }
    catch (error) {
      if (!isStaleBrowserSessionError(error)) throw error;
      await this.invalidateSession();
      await this.openFreshContext();
      try { this.collectDiagnostic(await this.rpc('fill', this.sessionId, prompt, submissionMarker), 'after_fill'); }
      catch (retryError) {
        if (isStaleBrowserSessionError(retryError)) { await this.invalidateSession(); fail('BROWSER_UNAVAILABLE', 'The browser session disappeared before the prompt was submitted.'); }
        throw retryError;
      }
    }
  }
  async submitPrompt(submissionMarker: string) {
    const sessionId = this.sessionId;
    if (!sessionId) fail('BROWSER_UNAVAILABLE', 'Browser invocation page is unavailable.');
    try {
      const result = await this.rpc('submit', sessionId, undefined, submissionMarker) as { method?: string } | undefined;
      this.collectDiagnostic(result, 'submit');
      if (result?.method === 'not_ready') fail('SUBMISSION_UNCERTAIN', 'The ChatGPT Send button was not ready; no click was attempted.');
      if (result?.method !== 'click') fail('SUBMISSION_UNCERTAIN', 'The ChatGPT Send button action could not be confirmed.');
      if (this.diagnosticsEnabled) this.observationTask = this.sampleAfterSubmit(sessionId!, submissionMarker);
    }
    catch (error: any) {
      if (isStaleBrowserSessionError(error)) { await this.invalidateSession(); fail('SUBMISSION_UNCERTAIN', 'The browser session disappeared while submitting; the submission outcome is uncertain.'); }
      fail('SUBMISSION_UNCERTAIN', `Browser transport failed while submitting: ${error?.message ?? String(error)}`);
    }
  }
  async inspectSubmission(submissionMarker: string): Promise<Inspection> {
    if (!this.sessionId) return 'uncertain';
    try {
      if (this.observationTask) await this.observationTask;
      const result = await this.rpc('inspect', this.sessionId, undefined, submissionMarker);
      if (this.diagnosticsEnabled && result && typeof result === 'object') {
        this.collectDiagnostic(result, 'inspection');
        return (result as { inspection: Inspection }).inspection;
      }
      return result as Inspection;
    }
    catch (error) { if (isStaleBrowserSessionError(error)) { await this.invalidateSession(); return 'uncertain'; } throw error; }
  }
  diagnosticReport() { return this.diagnostics.map(entry => ({ ...entry })); }
  async close() { if (this.sessionId) await this.rpc('close', this.sessionId).catch(() => {}); this.sessionId = undefined; }
}

export { brokerSocket };
