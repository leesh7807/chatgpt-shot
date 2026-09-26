import test from 'node:test';
import assert from 'node:assert/strict';
import { startJob, wrapPrompt } from '../src/service.js';
import { ShotError } from '../src/errors.js';
import type { JobTelemetryRecord, JobTelemetryWriter } from '../src/job-telemetry.js';

type State = 'pending' | 'in_progress' | 'completed' | 'failed';
type Snapshot = { id: string; pageId: string; state: State; error: string };

class Store {
  reads = 0;
  created = 0;
  deleted: Array<{ pageId: string; id: string }> = [];
  stateWrites = 0;
  constructor(readonly states: Snapshot[]) {}
  async createInvocation(_: string, id: string): Promise<Snapshot> { this.created++; return { id, pageId: 'page-1', state: 'pending', error: '' }; }
  async deleteInvocation(pageId: string, id: string) { this.deleted.push({ pageId, id }); }
  async readInvocation(pageId: string, id: string): Promise<Snapshot> { const next = this.states[Math.min(this.reads++, this.states.length - 1)]; return next ?? { pageId, id, state: 'pending', error: '' }; }
}

class DelayedStore extends Store {
  async createInvocation(database: string, id: string) { await new Promise(resolve => setTimeout(resolve, 15)); return super.createInvocation(database, id); }
}

class DelayedTerminalStore extends Store {
  async readInvocation(pageId: string, id: string) {
    if (this.reads > 0) await new Promise(resolve => setTimeout(resolve, 25));
    return super.readInvocation(pageId, id);
  }
}

class Browser {
  attempts = 0;
  opens = 0;
  inspections = 0;
  closes = 0;
  submissionMarkers: string[] = [];
  inspected: 'submitted' | 'not_submitted' | 'uncertain' = 'submitted';
  authenticated = true;
  openError?: Error;
  fillError?: Error;
  submitError?: Error;
  inspectError?: Error;
  async withBrowser<T>(operation: () => Promise<T>) { return operation(); }
  async ensureAvailable() {}
  async ensureAuthenticated() { if (!this.authenticated) throw new ShotError('CHATGPT_AUTH_REQUIRED', 'required'); }
  async openFreshContext() { this.opens++; if (this.openError) throw this.openError; }
  async fillPrompt(_prompt: string, submissionMarker: string) { this.submissionMarkers.push(submissionMarker); if (this.fillError) throw this.fillError; }
  async submitPrompt(submissionMarker: string) { this.submissionMarkers.push(submissionMarker); this.attempts++; if (this.submitError) throw this.submitError; }
  async inspectSubmission(submissionMarker: string) { this.submissionMarkers.push(submissionMarker); this.inspections++; if (this.inspectError) throw this.inspectError; return this.inspected; }
  async close() { this.closes++; }
}

class Telemetry implements JobTelemetryWriter {
  events: JobTelemetryRecord[] = [];
  record(event: JobTelemetryRecord) { this.events.push(event); }
}

const silentTelemetry: JobTelemetryWriter = { record() {} };

const job = (state: State, error = '') => ({ id: 'job-1', pageId: 'page-1', state, error });
const options = { acknowledgementMs: 20, pollMs: 1, telemetry: silentTelemetry };

test('records the normal local execution boundaries in order', async () => {
  const telemetry = new Telemetry();
  const store = new Store([job('in_progress'), job('completed')]);
  const browser = new Browser();
  const result = await startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry });
  await result.completion;

  assert.deepEqual(telemetry.events.map(event => event.event), [
    'admission_started', 'invocation_created', 'prompt_filled', 'submission_attempted',
    'submit_returned', 'accepted', 'terminal_observed'
  ]);
  assert.ok(telemetry.events.every(event => event.job_id === 'job-1' && event.timestamp));
  assert.deepEqual(browser.submissionMarkers, ['page1', 'page1']);
  assert.equal(telemetry.events.find(event => event.event === 'accepted')?.state, 'in_progress');
  assert.equal(telemetry.events.find(event => event.event === 'terminal_observed')?.state, 'completed');
});

test('uses the wrapped Notion page marker for uncertain-delivery inspection', async () => {
  const browser = new Browser();
  browser.submitError = new Error('transport interrupted');
  browser.inspected = 'not_submitted';
  await assert.rejects(
    () => startJob(new Store([job('pending')]) as any, 'db', browser as any, 'task', 'job-1', options),
    (error: unknown) => error instanceof ShotError && error.code === 'SUBMISSION_FAILED'
  );
  assert.deepEqual(browser.submissionMarkers, ['page1', 'page1', 'page1']);
});

test('records fast terminal acceptance and terminal observation from the same readback', async () => {
  const telemetry = new Telemetry();
  const result = await startJob(new Store([job('failed', 'remote failure')]) as any, 'db', new Browser() as any, 'task', 'job-1', { ...options, telemetry });
  assert.equal(result.job.state, 'failed');
  assert.deepEqual(telemetry.events.map(event => event.event), [
    'admission_started', 'invocation_created', 'prompt_filled', 'submission_attempted',
    'submit_returned', 'accepted', 'terminal_observed'
  ]);
  assert.equal(telemetry.events.find(event => event.event === 'accepted')?.state, 'failed');
  assert.equal(telemetry.events.find(event => event.event === 'terminal_observed')?.state, 'failed');
});

test('remote in_progress is acceptance and startJob does not wait for terminal Result', async () => {
  const store = new DelayedTerminalStore([job('in_progress'), job('completed')]);
  const browser = new Browser();
  const result = await startJob(store as any, 'db', browser as any, 'task', 'job-1', options);
  assert.equal(result.job.state, 'in_progress');
  assert.equal(store.reads, 1);
  await result.completion;
  assert.equal(browser.closes, 1);
});

test('completed and failed are both acceptance even when observed first', async () => {
  for (const state of ['completed', 'failed'] as const) {
    const result = await startJob(new Store([job(state)]) as any, 'db', new Browser() as any, 'task', 'job-1', options);
    assert.equal(result.job.state, state);
  }
});

test('pending is observed until remote acceptance', async () => {
  const store = new Store([job('pending'), job('in_progress'), job('completed')]);
  const result = await startJob(store as any, 'db', new Browser() as any, 'task', 'job-1', options);
  assert.equal(result.job.state, 'in_progress');
  await result.completion;
  assert.ok(store.reads >= 2);
});

test('pre-submission failure is cleaned up and returned as SUBMISSION_FAILED', async () => {
  const browser = new Browser();
  browser.fillError = new ShotError('BROWSER_UNAVAILABLE', 'composer disappeared');
  const store = new Store([]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', options), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.equal(store.created, 1);
  assert.deepEqual(store.deleted, [{ pageId: 'page-1', id: 'job-1' }]);
  assert.equal(browser.attempts, 0);
});

test('records actual inspection and cleanup evidence without inventing later success events', async () => {
  const telemetry = new Telemetry();
  const browser = new Browser();
  browser.inspected = 'not_submitted';
  const store = new Store([job('pending')]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 0, telemetry }), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.deepEqual(telemetry.events.map(event => event.event), [
    'admission_started', 'invocation_created', 'prompt_filled', 'submission_attempted',
    'submit_returned', 'submission_inspected', 'cleanup', 'admission_failed'
  ]);
  assert.equal(telemetry.events.find(event => event.event === 'submission_inspected')?.inspection, 'not_submitted');
  assert.equal(telemetry.events.find(event => event.event === 'cleanup')?.outcome, 'succeeded');
  assert.equal(telemetry.events.at(-1)?.error?.code, 'SUBMISSION_FAILED');
});

test('confirmed not_submitted evidence permits cleanup but never writes remote failed state', async () => {
  const browser = new Browser();
  browser.inspected = 'not_submitted';
  const store = new Store([job('pending')]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 0 }), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.equal(browser.inspections, 1);
  assert.equal(store.deleted.length, 1);
  assert.equal(store.stateWrites, 0);
});

test('submitted evidence after acknowledgement timeout is an admission failure without cleanup', async () => {
  const browser = new Browser();
  browser.inspected = 'submitted';
  const store = new Store([job('pending')]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 0 }), (error: any) => error.code === 'ADMISSION_TIMEOUT');
  assert.equal(store.deleted.length, 0);
});

test('uncertain evidence after acknowledgement timeout is a caller failure without cleanup', async () => {
  const browser = new Browser();
  browser.inspected = 'uncertain';
  const store = new Store([job('pending')]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 0 }), (error: any) => error.code === 'SUBMISSION_UNCERTAIN');
  assert.equal(store.deleted.length, 0);
});

test('returns one-shot browser diagnostics only when explicitly requested', async () => {
  const browser = new Browser() as Browser & { diagnosticReport(): Array<Record<string, unknown>> };
  browser.inspected = 'uncertain';
  browser.diagnosticReport = () => [{ offset_ms: 12, stage: 'after_fill', composerMatchesFilledPrompt: true }];
  await assert.rejects(
    () => startJob(new Store([job('pending')]) as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 0, diagnostics: true }),
    (error: any) => error.code === 'SUBMISSION_UNCERTAIN' && error.diagnostics?.[0]?.stage === 'after_fill'
  );
});

test('submit exception is classified from delivery evidence, not exception type', async () => {
  const browser = new Browser();
  browser.submitError = new ShotError('SUBMISSION_UNCERTAIN', 'transport lost');
  browser.inspected = 'not_submitted';
  const store = new Store([]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', options), (error: any) => error.code === 'SUBMISSION_FAILED');
  assert.equal(store.deleted.length, 1);

  const uncertainBrowser = new Browser();
  uncertainBrowser.submitError = new ShotError('SUBMISSION_UNCERTAIN', 'transport lost');
  uncertainBrowser.inspected = 'uncertain';
  const uncertainStore = new Store([]);
  await assert.rejects(() => startJob(uncertainStore as any, 'db', uncertainBrowser as any, 'task', 'job-1', options), (error: any) => error.code === 'SUBMISSION_UNCERTAIN');
  assert.equal(uncertainStore.deleted.length, 0);
});

test('submitted evidence after a submit exception can still be accepted remotely', async () => {
  const browser = new Browser();
  browser.submitError = new ShotError('SUBMISSION_UNCERTAIN', 'transport lost');
  browser.inspected = 'submitted';
  const store = new Store([job('in_progress'), job('completed')]);
  const result = await startJob(store as any, 'db', browser as any, 'task', 'job-1', options);
  assert.equal(result.job.state, 'in_progress');
  assert.equal(store.deleted.length, 0);
  await result.completion;
});

test('delivery uncertainty is preserved across inspection failure', async () => {
  const browser = new Browser();
  browser.inspectError = new ShotError('BROWSER_UNAVAILABLE', 'page gone');
  const store = new Store([job('pending')]);
  await assert.rejects(() => startJob(store as any, 'db', browser as any, 'task', 'job-1', { ...options, acknowledgementMs: 0 }), (error: any) => error.code === 'SUBMISSION_UNCERTAIN');
  assert.equal(store.deleted.length, 0);
});

test('records caller-facing admission failures with their existing error', async () => {
  const telemetry = new Telemetry();
  const browser = new Browser();
  browser.authenticated = false;
  await assert.rejects(() => startJob(new Store([]) as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry }), (error: any) => error.code === 'CHATGPT_AUTH_REQUIRED');
  assert.deepEqual(telemetry.events.map(event => event.event), ['admission_started', 'admission_failed']);
  assert.equal(telemetry.events[1].stage, 'authentication');
  assert.deepEqual(telemetry.events[1].error, { code: 'CHATGPT_AUTH_REQUIRED', message: 'required' });
});

test('records acceptance-after observer failures without changing caller acceptance', async () => {
  class ObserverFailureStore extends Store {
    async readInvocation(pageId: string, id: string): Promise<Snapshot> {
      if (this.reads > 0) throw new ShotError('NOTION_UNAVAILABLE', 'terminal read failed');
      return super.readInvocation(pageId, id);
    }
  }
  const telemetry = new Telemetry();
  const result = await startJob(new ObserverFailureStore([job('in_progress')]) as any, 'db', new Browser() as any, 'task', 'job-1', { ...options, telemetry });
  assert.equal(result.job.state, 'in_progress');
  await assert.rejects(result.completion, (error: any) => error.code === 'NOTION_UNAVAILABLE');
  assert.equal(telemetry.events.at(-1)?.event, 'observer_failed');
  assert.equal(telemetry.events.at(-1)?.stage, 'terminal_observation');
  assert.deepEqual(telemetry.events.at(-1)?.error, { code: 'NOTION_UNAVAILABLE', message: 'terminal read failed' });
});

test('telemetry writer failure does not change the normal Job flow', async () => {
  const failingTelemetry: JobTelemetryWriter = { record() { throw new Error('telemetry unavailable'); } };
  const result = await startJob(new Store([job('completed')]) as any, 'db', new Browser() as any, 'task', 'job-1', { ...options, telemetry: failingTelemetry });
  assert.equal(result.job.state, 'completed');
  await result.completion;
});

test('acknowledgement budget starts after prompt submission, not before it', async () => {
  const store = new DelayedStore([job('in_progress'), job('completed')]);
  const result = await startJob(store as any, 'db', new Browser() as any, 'task', 'job-1', { acknowledgementMs: 1, pollMs: 1 });
  assert.equal(result.job.state, 'in_progress');
  await result.completion;
});

test('authentication and fresh-context failures happen before Invocation creation', async () => {
  const authBrowser = new Browser();
  authBrowser.authenticated = false;
  const authStore = new Store([]);
  await assert.rejects(() => startJob(authStore as any, 'db', authBrowser as any, 'task', 'job-1', options), (error: any) => error.code === 'CHATGPT_AUTH_REQUIRED');
  assert.equal(authStore.created, 0);

  const contextBrowser = new Browser();
  contextBrowser.openError = new ShotError('BROWSER_UNAVAILABLE', 'fresh page unavailable');
  const contextStore = new Store([]);
  await assert.rejects(() => startJob(contextStore as any, 'db', contextBrowser as any, 'task', 'job-1', options), (error: any) => error.code === 'BROWSER_UNAVAILABLE');
  assert.equal(contextStore.created, 0);
});

test('caller cancellation is ADMISSION_CANCELLED and closes its browser context', async () => {
  const browser = new Browser();
  const telemetry = new Telemetry();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => startJob(new Store([]) as any, 'db', browser as any, 'task', 'job-1', { ...options, telemetry, signal: controller.signal }), (error: any) => error.code === 'ADMISSION_CANCELLED');
  assert.equal(browser.closes, 1);
  assert.deepEqual(telemetry.events.map(event => event.event), ['admission_started', 'caller_cancelled', 'admission_failed']);
});

test('wrapped prompt separates the caller task from the Notion delivery contract', () => {
  assert.equal(wrapPrompt('caller task', 'page-1'), `<task>\ncaller task\n</task>\n\n<chatgpt-shot>\nThis block is supplied by chatgpt-shot and defines how to return the result.\n\nInvocation record:\nhttps://www.notion.so/page1\n\n1. Before starting the task, set State to \`in_progress\`.\n2. Complete the task in <task>.\n3. Write the complete result to the invocation page body.\n4. As the final action:\n   - success → set State to \`completed\`\n   - failure → write the reason to Error and set State to \`failed\`\n</chatgpt-shot>`);
});
