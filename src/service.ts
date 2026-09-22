import { fail, ShotError } from './errors.js';
import type { BrowserTransport, Inspection } from './browser.js';
import type { Invocation, NotionStore } from './notion.js';
import { LocalJobTelemetryWriter, type JobTelemetryError, type JobTelemetryWriter } from './job-telemetry.js';

export type SubmitOptions = { acknowledgementMs?: number; pollMs?: number; telemetry?: JobTelemetryWriter; signal?: AbortSignal };
export type JobExecution = { job: Invocation; completion: Promise<void> };
export const DEFAULT_ACKNOWLEDGEMENT_MS = 45_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const wrapPrompt = (prompt: string, pageId: string) => `<task>\n${prompt}\n</task>\n\n<chatgpt-shot>\nThis block is supplied by chatgpt-shot and defines how to return the result.\n\nInvocation record:\nhttps://www.notion.so/${pageId.replace(/-/g, '')}\n\n1. Before starting the task, set State to \`in_progress\`.\n2. Complete the task in <task>.\n3. Write the complete result to the invocation page body.\n4. As the final action:\n   - success → set State to \`completed\`\n   - failure → write the reason to Error and set State to \`failed\`\n</chatgpt-shot>`;

const accepted = (state: string) => state === 'in_progress' || state === 'completed' || state === 'failed';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const telemetryError = (error: unknown): JobTelemetryError => error instanceof ShotError
  ? { code: error.code, message: error.message }
  : { message: errorMessage(error) };

/**
 * Admit one Job and resolve only after the remote writer has recorded acceptance.
 *
 * The local writer creates the initial pending record, but it never writes a remote
 * lifecycle state. A confirmed non-delivery is the sole path that may archive that
 * initial record locally.
 */
export async function startJob(store: NotionStore, databaseId: string, browser: BrowserTransport, prompt: string, id: string, options: SubmitOptions = {}): Promise<JobExecution> {
  const acknowledgementMs = options.acknowledgementMs ?? DEFAULT_ACKNOWLEDGEMENT_MS;
  const pollMs = options.pollMs ?? 2_000;
  const telemetryWriter = options.telemetry ?? new LocalJobTelemetryWriter();
  const record = (event: Parameters<JobTelemetryWriter['record']>[0]) => {
    try { telemetryWriter.record(event); } catch { /* diagnostic side effect only */ }
  };
  const event = (name: Parameters<JobTelemetryWriter['record']>[0]['event'], fields: Omit<Parameters<JobTelemetryWriter['record']>[0], 'job_id' | 'event' | 'timestamp'> = {}) => {
    record({ job_id: id, event: name, timestamp: new Date().toISOString(), ...fields });
  };
  let invocation: Invocation | undefined;
  let acceptedRemotely = false;
  let delivery: Inspection = 'not_submitted';
  let cleanedUp = false;
  let stage = 'admission';
  let cancellationRecorded = false;

  event('admission_started');

  const cancelled = () => {
    if (!options.signal?.aborted) return;
    if (!cancellationRecorded) {
      cancellationRecorded = true;
      event('caller_cancelled', { stage });
    }
    fail('ADMISSION_CANCELLED', `Job admission was cancelled for ${id}.`);
  };
  const inspect = async (): Promise<Inspection> => {
    try {
      const result = await browser.inspectSubmission(id);
      event('submission_inspected', { inspection: result });
      return result;
    } catch (error) {
      event('submission_inspected', { inspection: 'uncertain', error: telemetryError(error) });
      return 'uncertain';
    }
  };
  const cleanup = async () => {
    if (!invocation || cleanedUp) return;
    cleanedUp = true;
    try {
      await store.deleteInvocation(invocation.pageId, id);
      event('cleanup', { outcome: 'succeeded' });
    } catch (error) {
      stage = 'cleanup';
      event('cleanup', { outcome: 'failed', error: telemetryError(error) });
      throw error;
    }
  };
  const failUndelivered = async (reason: string): Promise<never> => {
    await cleanup();
    return fail('SUBMISSION_FAILED', `Job ${id} was not submitted: ${reason}`);
  };
  let resolveAcceptance!: (job: Invocation) => void;
  let rejectAcceptance!: (error: unknown) => void;
  const acceptance = new Promise<Invocation>((resolve, reject) => { resolveAcceptance = resolve; rejectAcceptance = reject; });
  const admission = browser.withBrowser(async () => {
    try {
      cancelled();
      stage = 'browser_availability';
      await browser.ensureAvailable();
      cancelled();
      stage = 'authentication';
      await browser.ensureAuthenticated();
      cancelled();
      stage = 'browser_context';
      await browser.openFreshContext();
      cancelled();

      stage = 'invocation_creation';
      invocation = await store.createInvocation(databaseId, id);
      event('invocation_created');

      try {
        stage = 'prompt_filling';
        await browser.fillPrompt(wrapPrompt(prompt, invocation.pageId));
        event('prompt_filled');
        cancelled();
      } catch (error) {
        return await failUndelivered(errorMessage(error));
      }

      // Once the submit operation starts, delivery is no longer safely inferable from
      // local control flow. Keep that ownership conservative until evidence or remote
      // acceptance is observed.
      delivery = 'uncertain';
      stage = 'submission';
      event('submission_attempted');
      let acknowledgementStarted: number;
      try {
        await browser.submitPrompt();
        acknowledgementStarted = Date.now();
        event('submit_returned');
        cancelled();
      } catch (error) {
        // If the submit operation interrupted, the evidence probe is part of the
        // post-submission admission window and must not extend that budget.
        acknowledgementStarted = Date.now();
        delivery = await inspect();
          if (delivery === 'not_submitted') return await failUndelivered(errorMessage(error));
        if (delivery === 'uncertain') fail('SUBMISSION_UNCERTAIN', `Submission status for ${id} is uncertain; the Job was not retried.`);
      }

      while (true) {
        cancelled();
        stage = 'acceptance_observation';
        const current = await store.readInvocation(invocation.pageId, id);
        if (accepted(current.state)) {
          acceptedRemotely = true;
          event('accepted', { state: current.state });
          resolveAcceptance(current);
          if (current.state === 'completed' || current.state === 'failed') {
            event('terminal_observed', { state: current.state });
            return current;
          }
          while (true) {
            await sleep(pollMs);
            stage = 'terminal_observation';
            const terminal = await store.readInvocation(invocation.pageId, id);
            if (terminal.state === 'completed' || terminal.state === 'failed') {
              event('terminal_observed', { state: terminal.state });
              return terminal;
            }
            if (terminal.state !== 'in_progress') fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${terminal.state}.`);
          }
        }
        if (current.state !== 'pending') fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${current.state}.`);
        if (Date.now() - acknowledgementStarted >= acknowledgementMs) {
          delivery = await inspect();
          if (delivery === 'not_submitted') return await failUndelivered('delivery evidence confirmed that the prompt did not reach ChatGPT');
          if (delivery === 'submitted') fail('ADMISSION_TIMEOUT', `Job ${id} was submitted but remote acceptance was not observed before the acknowledgement deadline.`);
          fail('SUBMISSION_UNCERTAIN', `Submission status for ${id} is uncertain; the Job was not retried.`);
        }
        await sleep(pollMs);
      }
    } catch (error) {
      // This guard is intentionally based on delivery evidence, never on the error
      // category. Exceptions and interruptions after submit remain uncertain.
      if (!acceptedRemotely && delivery === 'not_submitted') await cleanup();
      if (!acceptedRemotely) {
        event('admission_failed', { stage, error: telemetryError(error) });
        rejectAcceptance(error);
      } else {
        event('observer_failed', { stage, error: telemetryError(error) });
      }
      if (error instanceof ShotError) throw error;
      throw error;
    }
  }).finally(() => browser.close().catch(() => {}));

  void admission.catch(() => {});
  const job = await acceptance;
  const completion = admission.then(() => undefined);
  void completion.catch(() => {});
  return { job, completion };
}
