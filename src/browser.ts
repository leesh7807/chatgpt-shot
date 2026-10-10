import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { brokerRequest, brokerSocket } from './broker.js';
import { paths } from './config.js';
import { fail, isStaleBrowserSessionError } from './errors.js';

export type Inspection = 'submitted' | 'not_submitted' | 'uncertain';
export type SubmitAttempt = { outcome: 'clicked'; method?: string } | { outcome: 'not_attempted'; reason: string };
export type SubmissionInspection = { inspection: Inspection; messageMarkerSeen?: boolean; composerMarkerPresent?: boolean; composerPresent?: boolean; sampleCount?: number; reason?: string };
export type InspectionOptions = { settleMs?: number };
export type BrowserDiagnosticEntry = { offset_ms: number; stage: string; [key: string]: unknown };
export interface BrowserTransport { withBrowser<T>(operation: () => Promise<T>): Promise<T>; ensureAvailable(): Promise<void>; ensureAuthenticated(): Promise<void>; openFreshContext(): Promise<void>; fillPrompt(prompt: string, submissionMarker: string): Promise<void>; submitPrompt(submissionMarker: string): Promise<SubmitAttempt>; inspectSubmission(submissionMarker: string, options?: InspectionOptions): Promise<SubmissionInspection | Inspection>; requestNotionApprovalAssist?(): Promise<unknown>; close(): Promise<void>; diagnosticReport?(): BrowserDiagnosticEntry[]; }

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pendingBrokerStarts = new Map<string, Promise<void>>();
const profilePath = (profile: string) => profile;
const systemChrome = () => [process.env.CHATGPT_SHOT_BROWSER, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path): path is string => Boolean(path && existsSync(path)));
async function request(root: string, operation: string, sessionId?: string, prompt?: string, submissionMarker?: string, send: typeof brokerRequest = brokerRequest, diagnostics = false, observeApproval = false, jobId?: string) { try { return await send(root, { operation, sessionId, prompt, submissionMarker, ...(diagnostics ? { diagnostics: true } : {}), ...(observeApproval && operation === 'notion-approval-assist' ? { observeApproval: true, jobId } : {}) }); } catch (error: any) { if (error.code) return fail(error.code, error.message, error); throw error; } }
export async function ensureBroker(profile: string) {
  const assertProfileAvailable = () => { if (existsSync(paths().manualOpenLockPath)) fail('SERVICE_BUSY', 'The retained browser profile is open for manual use.'); };
  const absent = (error: any) => error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED';
  assertProfileAvailable();
  try { await request(profile, 'ensure'); return; } catch (error: any) {
    if (!absent(error)) throw error;
    if (error.code === 'ECONNREFUSED') try { unlinkSync(brokerSocket(profile)); } catch {}
  }
  assertProfileAvailable();
  const socket = brokerSocket(profile);
  const existingStart = pendingBrokerStarts.get(socket);
  if (existingStart) {
    await existingStart;
    await request(profile, 'ensure');
    return;
  }
  if (!existsSync(process.argv[1])) fail('BROWSER_UNAVAILABLE', 'Cannot locate the chatgpt-shot broker entry point.');
  const starting = (async () => {
    // Development execution via tsx supplies the TypeScript loader through execArgv; retain it when
    // the detached broker is spawned so the broker has the same executable semantics as its caller.
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__broker'], { detached: true, stdio: 'ignore' }); child.unref();
    for (let attempt = 0; attempt < 50; attempt++) { try { assertProfileAvailable(); await request(profile, 'ensure'); return; } catch (error: any) { if (error?.code === 'SERVICE_BUSY') { await shutdownBroker(profile).catch(() => {}); throw error; } if (!absent(error)) throw error; await wait(100); } }
    fail('BROWSER_UNAVAILABLE', 'Could not start the local ChatGPT browser broker.');
  })();
  pendingBrokerStarts.set(socket, starting);
  try { await starting; } finally { if (pendingBrokerStarts.get(socket) === starting) pendingBrokerStarts.delete(socket); }
}
export async function openProfileBrowser(profile: string, onSpawn?: (pid: number) => void): Promise<void> {
  const executable = systemChrome(); if (!executable) fail('BROWSER_UNAVAILABLE', 'A supported system Chrome executable is required to open the retained profile.');
  const path = profilePath(profile); mkdirSync(path, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    let child: import('node:child_process').ChildProcess | undefined;
    try {
      child = spawn(executable!, [`--user-data-dir=${path}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com/'], { stdio: 'ignore' });
      if (onSpawn) { if (child.pid === undefined) throw new Error('Chrome did not expose its process ID.'); onSpawn(child.pid); }
    } catch (error) { child?.kill('SIGTERM'); reject(error); return; }
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}
export async function shutdownBroker(root: string): Promise<void> {
  try { await request(root, 'shutdown'); }
  catch (error: any) {
    // No broker is the normal initial-open and already-shut-down state. Do not conceal a live
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
  constructor(private readonly profile: string, private readonly send: typeof brokerRequest = brokerRequest, private readonly diagnosticsEnabled = false, private readonly observeApproval = false, private readonly jobId?: string) {}
  private async rpc(operation: string, sessionId?: string, prompt?: string, submissionMarker?: string) { return request(this.profile, operation, sessionId, prompt, submissionMarker, this.send, this.diagnosticsEnabled, this.observeApproval, this.jobId); }
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
    if (this.sessionId) await this.close();
  }
  private async openFreshContextOnce() { await this.close(); this.sessionId = await this.rpc('open'); }
  async withBrowser<T>(operation: () => Promise<T>) {
    let value!: T;
    let operationError: unknown;
    try { value = await operation(); } catch (error) { operationError = error; }
    try { await this.close(); }
    catch (closeError) {
      if (operationError && typeof operationError === 'object') (operationError as any).browserCloseError = closeError;
      else throw closeError;
    }
    if (operationError) throw operationError;
    return value;
  }
  async ensureAvailable() { await ensureBroker(this.profile); }
  async ensureAuthenticated() {
    let status: { authenticated?: boolean };
    try { status = await this.rpc('auth'); }
    catch (error) { if (isStaleBrowserSessionError(error)) fail('BROWSER_UNAVAILABLE', 'The retained browser session disappeared while checking authentication.'); throw error; }
    if (!status?.authenticated) fail('CHATGPT_AUTH_REQUIRED', 'ChatGPT authentication is required. Run `chatgpt-shot open`.');
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
  async submitPrompt(submissionMarker: string): Promise<SubmitAttempt> {
    const sessionId = this.sessionId;
    if (!sessionId) fail('BROWSER_UNAVAILABLE', 'Browser invocation page is unavailable.');
    try {
      const result = await this.rpc('submit', sessionId, undefined, submissionMarker) as { method?: string; reason?: string } | undefined;
      this.collectDiagnostic(result, 'submit');
      if (result?.method === 'not_ready') return { outcome: 'not_attempted', reason: safeReason(result?.reason) ?? 'send_control_not_ready' };
      if (result?.method !== 'click') fail('SUBMISSION_UNCERTAIN', 'The ChatGPT Send button action could not be confirmed.', result);
      if (this.diagnosticsEnabled) this.observationTask = this.sampleAfterSubmit(sessionId!, submissionMarker);
      return { outcome: 'clicked', method: 'click' };
    }
    catch (error: any) {
      if (isStaleBrowserSessionError(error)) { await this.invalidateSession(); fail('SUBMISSION_UNCERTAIN', 'The browser session disappeared while submitting; the submission outcome is uncertain.', error); }
      return fail('SUBMISSION_UNCERTAIN', 'The browser transport did not confirm the submission action.', error);
    }
  }
  async inspectSubmission(submissionMarker: string, options: InspectionOptions = {}): Promise<SubmissionInspection> {
    if (!this.sessionId) return { inspection: 'uncertain', reason: 'browser_session_missing', sampleCount: 0 };
    try {
      const settleMs = Math.max(0, options.settleMs ?? 0);
      const checkpoints = settleMs > 0 ? [...new Set([0, 500, 1_500, 3_000, settleMs].filter((time) => time <= settleMs))] : [0];
      const started = Date.now();
      let last: SubmissionInspection = { inspection: 'uncertain', reason: 'insufficient_ui_evidence' };
      let allNotSubmitted = true;
      let successfulSamples = 0;
      let lastError: unknown;
      for (const checkpoint of checkpoints) {
        if (checkpoint > 0) await wait(Math.max(0, started + checkpoint - Date.now()));
        try {
          const result = await this.rpc('inspect', this.sessionId, undefined, submissionMarker);
          let observed: SubmissionInspection;
          if (this.diagnosticsEnabled && result && typeof result === 'object') {
            this.collectDiagnostic(result, 'inspection');
            const value = result as { inspection?: unknown; messageMarkerSeen?: unknown; composerMarkerPresent?: unknown; composerPresent?: unknown; reason?: unknown };
            observed = {
              inspection: value.inspection === 'submitted' || value.inspection === 'not_submitted' ? value.inspection : 'uncertain',
              ...(typeof value.messageMarkerSeen === 'boolean' ? { messageMarkerSeen: value.messageMarkerSeen } : {}),
              ...(typeof value.composerMarkerPresent === 'boolean' ? { composerMarkerPresent: value.composerMarkerPresent } : {}),
              ...(typeof value.composerPresent === 'boolean' ? { composerPresent: value.composerPresent } : {}),
              ...(typeof value.reason === 'string' ? { reason: safeReason(value.reason) ?? 'insufficient_ui_evidence' } : {}),
            };
          } else if (result && typeof result === 'object') {
            const value = result as { inspection?: unknown; messageMarkerSeen?: unknown; composerMarkerPresent?: unknown; composerPresent?: unknown; reason?: unknown };
            observed = {
              inspection: value.inspection === 'submitted' || value.inspection === 'not_submitted' ? value.inspection : 'uncertain',
              ...(typeof value.messageMarkerSeen === 'boolean' ? { messageMarkerSeen: value.messageMarkerSeen } : {}),
              ...(typeof value.composerMarkerPresent === 'boolean' ? { composerMarkerPresent: value.composerMarkerPresent } : {}),
              ...(typeof value.composerPresent === 'boolean' ? { composerPresent: value.composerPresent } : {}),
              ...(typeof value.reason === 'string' ? { reason: safeReason(value.reason) ?? 'insufficient_ui_evidence' } : {}),
            };
          } else observed = { inspection: result === 'submitted' || result === 'not_submitted' ? result : 'uncertain' };
          successfulSamples++;
          last = observed;
          if (observed.inspection === 'submitted') return { ...observed, sampleCount: successfulSamples };
          if (observed.inspection !== 'not_submitted') allNotSubmitted = false;
        } catch (error) {
          if (isStaleBrowserSessionError(error)) { await this.invalidateSession(); return { inspection: 'uncertain', reason: 'stale_browser_session' }; }
          lastError = error;
          last = { inspection: 'uncertain', reason: 'insufficient_ui_evidence' };
          allNotSubmitted = false;
        }
      }
      if (!successfulSamples && lastError) throw lastError;
      return { ...last, inspection: last.inspection === 'not_submitted' && allNotSubmitted ? 'not_submitted' : 'uncertain', sampleCount: successfulSamples };
    } catch (error) { if (isStaleBrowserSessionError(error)) { await this.invalidateSession(); return { inspection: 'uncertain', reason: 'stale_browser_session' }; } throw error; }
  }
  async requestNotionApprovalAssist(): Promise<unknown> {
    if (!this.sessionId) {
      const error = new Error('Browser invocation page is unavailable.') as Error & { code: string };
      error.code = 'BROWSER_UNAVAILABLE';
      throw error;
    }
    return this.rpc('notion-approval-assist', this.sessionId);
  }
  diagnosticReport() { return this.diagnostics.map(entry => ({ ...entry })); }
  async close() {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.rpc('close', sessionId) as { closed?: unknown; verified?: unknown } | undefined;
        if (result?.closed !== true || result?.verified !== true) throw new Error('Broker did not confirm that the Chrome target was closed.');
        this.sessionId = undefined;
        return;
      }
      catch (error) { lastError = error; if (attempt === 0) await wait(100); }
    }
    fail('BROWSER_CONTEXT_CLOSE_FAILED', 'The submission browser tab could not be confirmed closed.', lastError);
  }
}

const safeReason = (value: unknown) => typeof value === 'string' && ['composer_marker_missing', 'send_button_not_found', 'send_button_disabled', 'composer_missing', 'marker_in_message', 'marker_in_composer', 'marker_seen_in_both', 'marker_seen_in_neither', 'browser_session_missing', 'stale_browser_session', 'insufficient_ui_evidence', 'marker_missing', 'send_control_not_ready'].includes(value) ? value : undefined;


export { brokerSocket };
