import test from 'node:test';
import assert from 'node:assert/strict';
import { startJob, wrapPrompt } from '../src/service.js';
import { ShotError } from '../src/errors.js';
import type { JobTelemetryRecord, JobTelemetryWriter } from '../src/job-telemetry.js';

type State = 'pending' | 'in_progress' | 'completed' | 'failed';
type Snapshot = { id: string; pageId: string; state: State; error: string };

class Store {
  reads = 0;
  created: Snapshot[] = [];
  deleted: Array<{ pageId: string; id: string }> = [];
  stateWrites = 0;
  private readCounts = new Map<string, number>();
  constructor(readonly states: State[] = ['in_progress', 'completed'], readonly readDelayMs = 0) {}
  async createInvocation(_: string, id: string): Promise<Snapshot> {
    const invocation = { id, pageId: `page-${id}`, state: 'pending' as const, error: '' };
    this.created.push(invocation);
    return invocation;
  }
  async deleteInvocation(pageId: string, id: string) { this.deleted.push({ pageId, id }); }
  async readInvocation(pageId: string, id: string): Promise<Snapshot> {
    if (this.readDelayMs) await new Promise(resolve => setTimeout(resolve, this.readDelayMs));
    this.reads++;
    const count = this.readCounts.get(pageId) ?? 0;
    this.readCounts.set(pageId, count + 1);
    return { id, pageId, state: this.states[Math.min(count, this.states.length - 1)] ?? 'pending', error: '' };
  }
}

class Browser {
  attempts = 0;
  opens = 0;
  inspections = 0;
  closes = 0;
  order: string[] = [];
  submissionMarkers: string[] = [];
  inspected: 'submitted' | 'not_submitted' | 'uncertain' = 'submitted';
  authenticated = true;
  openError?: Error;
  fillError?: Error;
  fillDelayMs = 0;
  submitError?: Error;
  notAttemptedReason?: string;
  inspectError?: Error;
  closeError?: Error;
  approvalChecks = 0;
  approvalError?: Error;
  async checkPendingNotionApproval() { this.approvalChecks++; if (this.approvalChecks === 1 && this.approvalError) throw this.approvalError; return { permissionChoice: 'always_allow' as const }; }
  async withBrowser<T>(operation: () => Promise<T>): Promise<T> {
    let value!: T; let operationError: unknown;
    try { value = await operation(); } catch (error) { operationError = error; }
    try { await this.close(); } catch (closeError) {
      if (operationError && typeof operationError === 'object') (operationError as any).browserCloseError = closeError;
      else throw closeError;
    }
    if (operationError) throw operationError;
    return value;
  }
  async ensureAvailable() { this.order.push('available'); }
  async ensureAuthenticated() { this.order.push('authenticated'); if (!this.authenticated) throw new ShotError('CHATGPT_AUTH_REQUIRED', 'required'); }
  async openFreshContext() { this.opens++; this.order.push('opened'); if (this.openError) throw this.openError; }
  async fillPrompt(_prompt: string, submissionMarker: string) {
    this.order.push('fill_started'); this.submissionMarkers.push(submissionMarker);
    if (this.fillDelayMs) await new Promise(resolve => setTimeout(resolve, this.fillDelayMs));
    if (this.fillError) throw this.fillError;
    this.order.push('filled');
  }
  async submitPrompt(submissionMarker: string) {
    this.submissionMarkers.push(submissionMarker); this.attempts++; this.order.push('submit');
    if (this.submitError) throw this.submitError;
    if (this.notAttemptedReason) return { outcome: 'not_attempted' as const, reason: this.notAttemptedReason };
    return { outcome: 'clicked' as const, method: 'click' };
  }
  async inspectSubmission(submissionMarker: string) {
    this.submissionMarkers.push(submissionMarker); this.inspections++;
    if (this.inspectError) throw this.inspectError;
    return this.inspected;
  }
  async close() { this.closes++; this.order.push('closed'); if (this.closeError) throw this.closeError; }
}

class Telemetry implements JobTelemetryWriter {
  events: JobTelemetryRecord[] = [];
  record(event: JobTelemetryRecord) { this.events.push(event); }
}

const silentTelemetry: JobTelemetryWriter = { record() {} };
const options = { acknowledgementMs: 200, pollMs: 5, telemetry: silentTelemetry };

test('returns the accepted Job only after closing its browser context', async () => {
  const telemetry = new Telemetry(); const browser = new Browser();
  const result = await startJob(new Store(['in_progress', 'completed']) as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry });
  assert.equal(result.job.state, 'in_progress');
  assert.ok(browser.order.indexOf('closed') > browser.order.indexOf('submit'));
  assert.deepEqual(telemetry.events.filter(event => ['accepted', 'browser_context_closed'].includes(event.event)).map(event => event.event), ['accepted', 'browser_context_closed']);
  await result.completion;
  assert.equal(telemetry.events.at(-1)?.state, 'completed');
});

test('an uncertain browser result still waits for Notion acceptance', async () => {
  const browser = new Browser(); browser.submitError = new Error('transport interrupted'); browser.inspected = 'uncertain';
  const store = new Store(['in_progress', 'completed']);
  const result = await startJob(store as any, 'db', browser as any, 'task', 'job-1', options);
  assert.equal(result.job.state, 'in_progress');
  assert.equal(store.deleted.length, 0);
  assert.ok(browser.inspections >= 1);
  await result.completion;
});

test('a confirmed non-attempted Send action fails immediately and cleans up the Invocation', async () => {
  const browser = new Browser(); browser.notAttemptedReason = 'composer_marker_missing';
  const store = new Store(['pending']); const telemetry = new Telemetry();
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry }), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.equal(browser.inspections, 0);
  assert.equal(store.reads, 0);
  assert.equal(store.deleted.length, 1);
  assert.equal(telemetry.events.find(event => event.event === 'admission_failed')?.error?.code, 'SUBMISSION_FAILED');
});

test('pending remains pending through the configured window and is not cleaned up when delivery is uncertain', async () => {
  const browser = new Browser(); browser.inspected = 'uncertain';
  const store = new Store(['pending']);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 80 }), (error: any) => error.code === 'SUBMISSION_UNCERTAIN');
  assert.ok(store.reads > 1);
  assert.equal(store.deleted.length, 0);
});

test('pending approval assist runs only while Notion remains pending and never controls acceptance', async () => {
  const browser = new Browser(); browser.approvalError = new Error('temporary broker failure');
  const store = new Store(['pending', 'pending', 'in_progress', 'completed']);
  const telemetry = new Telemetry();
  const result = await startJob(store as any, 'db', browser as any, 'task', 'job-approval', { ...options, telemetry });
  assert.equal(result.job.state, 'in_progress');
  assert.equal(browser.approvalChecks, 2);
  const recoveries = telemetry.events.filter(item => item.event === 'notion_write_access_recovery');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].outcome, 'approval_button_disappeared');
  assert.deepEqual(recoveries[0].details, { permission_choice: 'always_allow' });
  await result.completion;

  const noRecoveryBrowser = new Browser();
  noRecoveryBrowser.checkPendingNotionApproval = async () => { noRecoveryBrowser.approvalChecks++; return undefined; };
  const noRecoveryTelemetry = new Telemetry();
  const noRecovery = await startJob(new Store(['pending', 'in_progress', 'completed']) as any, 'db', noRecoveryBrowser as any, 'task', 'job-no-recovery', { ...options, telemetry: noRecoveryTelemetry });
  assert.equal(noRecoveryBrowser.approvalChecks, 1);
  assert.equal(noRecoveryTelemetry.events.some(item => item.event === 'notion_write_access_recovery'), false);
  await noRecovery.completion;
});

test('only confirmed non-delivery permits Invocation cleanup', async () => {
  const browser = new Browser(); browser.inspected = 'not_submitted';
  const store = new Store(['pending']);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 80 }), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.equal(store.deleted.length, 1);
  assert.equal(store.stateWrites, 0);
});

test('confirmed prompt delivery without acceptance returns ADMISSION_TIMEOUT and preserves the Invocation', async () => {
  const browser = new Browser(); browser.inspected = 'submitted';
  const store = new Store(['pending']);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 80 }), (error: any) => error.code === 'ADMISSION_TIMEOUT');
  assert.equal(store.deleted.length, 0);
});

test('the deadline includes a stalled prompt fill and no Send action starts afterward', async () => {
  const browser = new Browser(); browser.fillDelayMs = 80;
  const store = new Store(['in_progress']);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 20 }), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.equal(browser.attempts, 0);
  assert.equal(store.reads, 0);
  assert.equal(store.deleted.length, 1);
});

test('a Notion read that resolves after the deadline cannot retroactively accept submission', async () => {
  const store = new Store(['in_progress'], 60); const telemetry = new Telemetry();
  await assert.rejects(() => startJob(store as any, 'db', new Browser() as any, 'task', 'job-1', { ...options, acknowledgementMs: 20, telemetry }), (error: any) => error.code === 'ADMISSION_TIMEOUT');
  assert.equal(store.deleted.length, 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(telemetry.events.some(event => event.event === 'accepted'), false);
  assert.equal(telemetry.events.some(event => event.event === 'notion_observation' && event.outcome === 'late_acceptance'), true);
});

test('an unresolved Notion read prevents cleanup even if UI evidence says the prompt stayed in the composer', async () => {
  const store = new Store(['in_progress'], 60); const browser = new Browser(); browser.inspected = 'not_submitted';
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 20 }), (error: any) => error.code === 'SUBMISSION_UNCERTAIN');
  assert.equal(store.deleted.length, 0);
});

test('caller cancellation during prompt fill closes the tab and cleans up only the known-undelivered Invocation', async () => {
  const browser = new Browser(); browser.fillDelayMs = 100;
  const store = new Store(['pending']); const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, signal: controller.signal }), (error: any) => error.code === 'ADMISSION_CANCELLED');
  assert.equal(browser.attempts, 0);
  assert.equal(browser.closes, 1);
  assert.equal(store.deleted.length, 1);
});

test('caller cancellation during an unresolved Notion read preserves the Invocation', async () => {
  const store = new Store(['pending'], 100); const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => startJob(store as any, 'db', new Browser() as any, 'task', 'job-1', { ...options, acknowledgementMs: 500, signal: controller.signal }), (error: any) => error.code === 'ADMISSION_CANCELLED');
  assert.equal(store.deleted.length, 0);
});

test('confirmed remote acceptance with an uncloseable tab fails admission and preserves remote ownership', async () => {
  const browser = new Browser(); browser.closeError = new ShotError('BROWSER_CONTEXT_CLOSE_FAILED', 'target remained open');
  const store = new Store(['in_progress', 'completed']); const telemetry = new Telemetry();
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry }), (error: any) => error.code === 'BROWSER_CONTEXT_CLOSE_FAILED');
  assert.equal(store.deleted.length, 0);
  assert.equal(telemetry.events.find(event => event.event === 'browser_context_closed')?.outcome, 'failed');
  assert.equal(telemetry.events.at(-1)?.event, 'admission_failed');
  assert.equal(telemetry.events.at(-1)?.error?.code, 'BROWSER_CONTEXT_CLOSE_FAILED');
});

test('concurrent admissions retain per-Job Notion and browser-session correlation', async () => {
  const store = new Store(['in_progress', 'completed']);
  const leftBrowser = new Browser(); const rightBrowser = new Browser();
  const [left, right] = await Promise.all([
    startJob(store as any, 'db', leftBrowser as any, 'left task', 'job-left', options),
    startJob(store as any, 'db', rightBrowser as any, 'right task', 'job-right', options),
  ]);
  assert.deepEqual(new Set([left.job.id, right.job.id]), new Set(['job-left', 'job-right']));
  assert.deepEqual(new Set([left.job.pageId, right.job.pageId]), new Set(['page-job-left', 'page-job-right']));
  assert.equal(leftBrowser.closes, 1); assert.equal(rightBrowser.closes, 1);
  await Promise.all([left.completion, right.completion]);
});

test('fast terminal state still proves acceptance without waiting for another read', async () => {
  const store = new Store(['failed']);
  const result = await startJob(store as any, 'db', new Browser() as any, 'task', 'job-1', options);
  assert.equal(result.job.state, 'failed');
  assert.equal(store.reads, 1);
});

test('terminal polling does not grow the bounded submission diagnostic trail', async () => {
  const telemetry = new Telemetry();
  const result = await startJob(new Store(['in_progress', 'in_progress', 'in_progress', 'completed']) as any, 'db', new Browser() as any, 'task', 'job-1', { ...options, telemetry, pollMs: 1 });
  await result.completion;
  assert.equal(telemetry.events.filter(event => event.event === 'notion_observation').length, 1);
  assert.equal(telemetry.events.filter(event => event.event === 'terminal_observed').length, 1);
});

test('telemetry retains the caller error and isolates writer failures', async () => {
  const telemetry = new Telemetry(); const browser = new Browser(); browser.authenticated = false;
  await assert.rejects(() => startJob(new Store() as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry }), (error: any) => error.code === 'CHATGPT_AUTH_REQUIRED');
  assert.equal(telemetry.events.at(-1)?.error?.code, 'CHATGPT_AUTH_REQUIRED');
  const result = await startJob(new Store(['in_progress', 'completed']) as any, 'db', new Browser() as any, 'task', 'job-2', { ...options, telemetry: { record() { throw new Error('disk full'); } } });
  assert.equal(result.job.state, 'in_progress');
});

test('wrapped prompt keeps caller task separate from the Notion writer contract', () => {
  const prompt = wrapPrompt('caller text', 'abc-def');
  assert.ok(prompt.includes('<task>\ncaller text\n</task>'));
  assert.ok(prompt.includes('https://www.notion.so/abcdef'));
  assert.ok(prompt.includes('set State to `in_progress`'));
  assert.ok(prompt.includes('success → set State to `completed`'));
});
