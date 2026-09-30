import { performance } from 'node:perf_hooks';
import { fail, ShotError } from './errors.js';
import type { BrowserTransport, Inspection, SubmissionInspection, SubmitAttempt } from './browser.js';
import type { Invocation, NotionStore } from './notion.js';
import { JobTelemetrySession, LocalJobTelemetryWriter, type JobTelemetryInput, type JobTelemetryWriter } from './job-telemetry.js';

export type SubmitOptions = { acknowledgementMs?: number; pollMs?: number; telemetry?: JobTelemetryWriter; telemetrySession?: JobTelemetrySession; signal?: AbortSignal; diagnostics?: boolean };
export type JobExecution = { job: Invocation; completion: Promise<void> };
export const DEFAULT_ACKNOWLEDGEMENT_MS = 180_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const raceAdmission = async <T>(operation: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> => {
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail('ADMISSION_TIMEOUT', 'The admission deadline elapsed before the browser operation completed.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const cancelled = signal ? new Promise<never>((_, reject) => {
      abortListener = () => reject(new ShotError('ADMISSION_CANCELLED', 'The caller cancelled Job admission.'));
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }) : new Promise<never>(() => {});
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ShotError('ADMISSION_TIMEOUT', 'The admission deadline elapsed before the browser operation completed.')), Math.max(1, remaining)); }),
      cancelled,
    ]);
    return result;
  } finally { if (timer) clearTimeout(timer); if (abortListener) signal?.removeEventListener('abort', abortListener); }
};
const accepted = (state: string) => state === 'in_progress' || state === 'completed' || state === 'failed';
const errorCode = (error: unknown): string | undefined => error && typeof error === 'object' && typeof (error as any).code === 'string' ? (error as any).code : undefined;
const telemetryError = (error: unknown) => {
  const value = error as any;
  const cause = value instanceof ShotError ? value.cause as any : undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : undefined;
  const name = value instanceof Error ? value.name : undefined;
  return {
    ...(errorCode(error) ? { code: errorCode(error) } : {}),
    ...(causeCode ? { cause_code: causeCode } : {}),
    ...(name && /^[A-Za-z0-9_.:-]{1,96}$/.test(name) ? { category: name } : {}),
    ...(typeof value?.status === 'number' ? { status: value.status } : typeof cause?.status === 'number' ? { status: cause.status } : {}),
    ...(typeof value?.retryAfterSeconds === 'number' ? { retry_after_seconds: value.retryAfterSeconds } : {}),
    ...(typeof causeCode === 'string' && /^[A-Z0-9_]{1,96}$/.test(causeCode) ? { network_code: causeCode } : {}),
  };
};
const inspectionResult = (value: Inspection | SubmissionInspection): SubmissionInspection => typeof value === 'string' ? { inspection: value } : value;

export const wrapPrompt = (prompt: string, pageId: string) => `<task>\n${prompt}\n</task>\n\n<chatgpt-shot>\nThis block is supplied by chatgpt-shot and defines how to return the result.\n\nInvocation record:\nhttps://www.notion.so/${pageId.replace(/-/g, '')}\n\n1. Before starting the task, set State to \`in_progress\`.\n2. Complete the task in <task>.\n3. Write the complete result to the invocation page body.\n4. As the final action:\n   - success → set State to \`completed\`\n   - failure → write the reason to Error and set State to \`failed\`\n</chatgpt-shot>`;

/**
 * Admit one Job and resolve only after the remote writer has recorded acceptance.
 * The acknowledgement clock begins immediately before prompt filling. A returned
 * Job has had its submission tab closed; terminal observation is Notion-only.
 */
export async function startJob(store: NotionStore, databaseId: string, browser: BrowserTransport, prompt: string, id: string, options: SubmitOptions = {}): Promise<JobExecution> {
  const acknowledgementMs = options.acknowledgementMs ?? DEFAULT_ACKNOWLEDGEMENT_MS;
  const pollMs = options.pollMs ?? 2_000;
  const telemetry = options.telemetrySession ?? new JobTelemetrySession(id, options.telemetry ?? new LocalJobTelemetryWriter());
  const event = (name: JobTelemetryInput['event'], fields: Omit<JobTelemetryInput, 'event'> = {}) => telemetry.record({ event: name, ...fields });
  const admissionRequests = new AbortController();
  const relayCancellation = () => admissionRequests.abort();
  if (options.signal?.aborted) admissionRequests.abort();
  else options.signal?.addEventListener('abort', relayCancellation, { once: true });
  let invocation: Invocation | undefined;
  let observedAcceptance: Invocation | undefined;
  let acceptedRemotely = false;
  let lateAcceptanceObserved = false;
  let readUnresolved = false;
  let delivery: Inspection = 'uncertain';
  let cleanedUp = false;
  let stage = 'admission';
  let cancellationRecorded = false;
  store.setRequestSignal?.(admissionRequests.signal);

  if (!options.telemetrySession) event('admission_started', { stage: 'invocation_creation' });

  const cancelled = (): void => {
    if (!options.signal?.aborted) return;
    if (!cancellationRecorded) {
      cancellationRecorded = true;
      event('caller_cancelled', { stage });
    }
    fail('ADMISSION_CANCELLED', 'Job admission was cancelled before remote acceptance was confirmed.');
  };
  const inspect = async (inspectionStage: 'post_submit' | 'deadline', deadline: number): Promise<Inspection> => {
    const started = performance.now();
    try {
      if (!invocation) return 'uncertain';
      const result = inspectionResult(await raceAdmission(browser.inspectSubmission(invocation.pageId.replace(/-/g, ''), { settleMs: 0 }), deadline, options.signal));
      delivery = result.inspection;
      event('submission_inspected', {
        stage: inspectionStage,
        inspection: result.inspection,
        duration_ms: performance.now() - started,
        ...(result.sampleCount !== undefined || result.messageMarkerSeen !== undefined || result.composerMarkerPresent !== undefined || result.composerPresent !== undefined ? {
          details: {
            ...(result.sampleCount !== undefined ? { sample_count: result.sampleCount } : {}),
            ...(result.messageMarkerSeen !== undefined ? { message_marker_seen: result.messageMarkerSeen } : {}),
            ...(result.composerMarkerPresent !== undefined ? { composer_marker_present: result.composerMarkerPresent } : {}),
            ...(result.composerPresent !== undefined ? { composer_present: result.composerPresent } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          },
        } : {}),
      });
      return result.inspection;
    } catch (error) {
      event('submission_inspected', { stage: inspectionStage, inspection: 'uncertain', duration_ms: performance.now() - started, error: telemetryError(error) });
      return 'uncertain';
    }
  };
  const cleanup = async (): Promise<void> => {
    if (!invocation || cleanedUp) return;
    cleanedUp = true;
    store.setRequestSignal?.(undefined);
    try {
      await store.deleteInvocation(invocation.pageId, id);
      event('cleanup', { outcome: 'succeeded' });
    } catch (error) {
      stage = 'cleanup';
      event('cleanup', { outcome: 'failed', error: telemetryError(error) });
      throw error;
    } finally { store.setRequestSignal?.(admissionRequests.signal); }
  };
  const failUndelivered = async (reason: string): Promise<never> => {
    stage = reason;
    await cleanup();
    return fail('SUBMISSION_FAILED', 'The prompt was not sent to ChatGPT; it is safe to submit a new attempt.');
  };

  let resolveAcceptance!: (job: Invocation) => void;
  let rejectAcceptance!: (error: unknown) => void;
  const acceptance = new Promise<Invocation>((resolve, reject) => { resolveAcceptance = resolve; rejectAcceptance = reject; });

  const admission = browser.withBrowser(async () => {
    try {
      cancelled();
      stage = 'browser_availability';
      const ensureStarted = performance.now();
      await browser.ensureAvailable();
      event('browser_stage', { stage, outcome: 'broker_available', duration_ms: performance.now() - ensureStarted });
      cancelled();

      stage = 'authentication';
      const authStarted = performance.now();
      await browser.ensureAuthenticated();
      event('browser_stage', { stage, outcome: 'authenticated', duration_ms: performance.now() - authStarted });
      cancelled();

      stage = 'browser_context_open';
      const openStarted = performance.now();
      await browser.openFreshContext();
      event('browser_context_opened', { stage, outcome: 'opened', duration_ms: performance.now() - openStarted });
      cancelled();

      stage = 'invocation_creation';
      const createStarted = performance.now();
      invocation = await store.createInvocation(databaseId, id);
      event('invocation_created', { stage: 'notion', duration_ms: performance.now() - createStarted });

      stage = 'prompt_filling';
      const acknowledgementStarted = performance.now();
      const acknowledgementDeadline = acknowledgementStarted + acknowledgementMs;
      event('prompt_fill_started', { stage, details: { deadline_ms: acknowledgementMs } });
      try {
        await raceAdmission(browser.fillPrompt(wrapPrompt(prompt, invocation.pageId), invocation.pageId.replace(/-/g, '')), acknowledgementDeadline, options.signal);
        event('prompt_filled', { stage, duration_ms: performance.now() - acknowledgementStarted });
        cancelled();
      } catch (error) {
        event('prompt_fill_failed', { stage, duration_ms: performance.now() - acknowledgementStarted, error: telemetryError(error) });
        delivery = 'not_submitted';
        if (error instanceof ShotError && error.code === 'ADMISSION_CANCELLED') {
          if (!cancellationRecorded) { cancellationRecorded = true; event('caller_cancelled', { stage }); }
          await cleanup();
          throw error;
        }
        return await failUndelivered('prompt_fill_failed');
      }

      if (performance.now() >= acknowledgementDeadline) {
        stage = 'prompt_filling';
        event('admission_deadline_reached', { stage, outcome: 'expired_before_send', details: { deadline_ms: acknowledgementMs } });
        delivery = 'not_submitted';
        return await failUndelivered('deadline_before_send');
      }

      stage = 'submission';
      delivery = 'uncertain';
      event('submission_attempted', { stage, details: { deadline_ms: acknowledgementMs } });
      try {
        const result = await raceAdmission(browser.submitPrompt(invocation.pageId.replace(/-/g, '')), acknowledgementDeadline, options.signal);
        if (result.outcome === 'not_attempted') {
          delivery = 'not_submitted';
          event('submit_action_returned', { stage, outcome: result.outcome, details: { reason: result.reason } });
          return await failUndelivered(result.reason);
        }
        event('submit_action_returned', { stage, outcome: result.outcome, details: { method: result.method ?? 'click' } });
      } catch (error) {
        event('submit_action_failed', { stage, error: telemetryError(error) });
      }

      // UI evidence is diagnostic. Remote Notion state owns admission and is polled
      // even when the browser call or its evidence probe is uncertain.
      void inspect('post_submit', acknowledgementDeadline);
      let lastObservationError: unknown;
      let transientReadFailures = 0;
      while (true) {
        cancelled();
        const remainingMs = acknowledgementDeadline - performance.now();
        if (remainingMs <= 0) break;
        stage = 'acceptance_observation';
        const readStarted = performance.now();
        const timeoutMarker = Symbol('deadline');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;
        const aborted = options.signal ? new Promise<typeof timeoutMarker>((resolve) => {
          abortListener = () => resolve(timeoutMarker);
          options.signal!.addEventListener('abort', abortListener, { once: true });
        }) : new Promise<never>(() => {});
        const read = store.readInvocation(invocation.pageId, id).then(
          (value) => ({ kind: 'read' as const, value, observedAt: performance.now() }),
          (error: unknown) => ({ kind: 'error' as const, error, observedAt: performance.now() }),
        );
        const timed = new Promise<typeof timeoutMarker>((resolve) => { timer = setTimeout(() => resolve(timeoutMarker), Math.max(1, remainingMs)); });
        const result = await Promise.race([read, timed, aborted]);
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
        if (result === timeoutMarker) {
          void read.then((lateResult) => {
            const pastDeadline = lateResult.observedAt > acknowledgementDeadline;
            if (!pastDeadline && !options.signal?.aborted) return;
            event('notion_observation', {
              stage: 'late_response',
              ...(lateResult.kind === 'read' ? { state: lateResult.value.state } : {}),
              outcome: !pastDeadline ? 'cancelled_response' : lateResult.kind === 'error' ? 'late_read_failed' : accepted(lateResult.value.state) ? 'late_acceptance' : 'late_pending',
              duration_ms: lateResult.observedAt - readStarted,
              ...(lateResult.kind === 'error' ? { error: telemetryError(lateResult.error) } : {}),
              details: { deadline_ms: acknowledgementMs },
            });
            if (lateResult.kind === 'read' && accepted(lateResult.value.state)) lateAcceptanceObserved = true;
          });
          readUnresolved = true;
          cancelled();
          break;
        }
        if (result.kind === 'error') {
          if (result.observedAt > acknowledgementDeadline) { lastObservationError = undefined; break; }
          lastObservationError = result.error;
          const error = result.error;
          event('notion_observation', { stage, outcome: 'read_failed', duration_ms: performance.now() - readStarted, error: telemetryError(error) });
          const retryable = error instanceof ShotError && error.retryable === true && ['NOTION_UNAVAILABLE', 'NOTION_RATE_LIMITED'].includes(error.code);
          if (!retryable) throw error;
          transientReadFailures++;
          const retryAfter = error instanceof ShotError ? error.retryAfterSeconds : undefined;
          const backoffMs = retryAfter !== undefined ? retryAfter * 1_000 : Math.min(5_000, 500 * 2 ** Math.min(4, transientReadFailures - 1));
          const pause = Math.min(backoffMs, Math.max(0, acknowledgementDeadline - performance.now()));
          if (pause > 0) await sleep(pause);
          continue;
        }
        const current = result.value;
        if (accepted(current.state) && result.observedAt > acknowledgementDeadline) lateAcceptanceObserved = true;
        lastObservationError = undefined;
        transientReadFailures = 0;
        const observedInTime = result.observedAt <= acknowledgementDeadline;
        event('notion_observation', { stage, state: current.state, outcome: accepted(current.state) ? observedInTime ? 'accepted' : 'late_acceptance' : observedInTime ? 'pending' : 'late_pending', duration_ms: result.observedAt - readStarted });
        // Observation time is when this process received the Notion response.
        if (accepted(current.state) && observedInTime) {
          observedAcceptance = current;
          acceptedRemotely = true;
          store.setRequestTelemetryEnabled?.(false);
          event('accepted', { state: current.state, stage, details: { admission_elapsed_ms: performance.now() - acknowledgementStarted } });
          return current;
        }
        if (accepted(current.state) || !observedInTime) break;
        if (current.state !== 'pending') fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${current.state}.`);
        const afterReadMs = acknowledgementDeadline - performance.now();
        if (afterReadMs <= 0) break;
        await sleep(Math.min(pollMs, afterReadMs));
      }

      event('admission_deadline_reached', { stage: 'acceptance_observation', outcome: 'no_acceptance_observed', details: { deadline_ms: acknowledgementMs } });
      if (lastObservationError) throw lastObservationError;
      stage = 'deadline_inspection';
      const deliveryAtDeadline = (): Inspection => delivery;
      if (lateAcceptanceObserved) fail('ADMISSION_TIMEOUT', `Remote acceptance was first observed after the ${acknowledgementMs} ms admission deadline. The Invocation is retained and the prompt was not retried.`);
      if (readUnresolved && deliveryAtDeadline() !== 'submitted') fail('SUBMISSION_UNCERTAIN', `Notion acceptance observation was still in flight at the ${acknowledgementMs} ms deadline, so the Invocation is retained and prompt delivery remains uncertain.`);
      if (deliveryAtDeadline() === 'not_submitted') return await failUndelivered('delivery_evidence_confirms_not_submitted');
      if (deliveryAtDeadline() === 'submitted') fail('ADMISSION_TIMEOUT', `The prompt was sent, but remote acceptance was not observed within ${acknowledgementMs} ms. The Invocation is retained and the prompt was not retried.`);
      fail('SUBMISSION_UNCERTAIN', `Remote acceptance was not observed within ${acknowledgementMs} ms and prompt delivery remains uncertain. The Invocation is retained and the prompt was not retried.`);
    } catch (error) {
      if (!acceptedRemotely && delivery === 'not_submitted' && !readUnresolved && !lateAcceptanceObserved) {
        try { await cleanup(); } catch (cleanupError) { error = cleanupError; }
      }
      if (!acceptedRemotely) admissionRequests.abort();
      throw error;
    }
  });

  const completion = admission.then(async (firstAcceptedState) => {
    if (!firstAcceptedState) fail('INTERNAL_ERROR', 'Job admission finished without an accepted Invocation.');
    const acceptedState = firstAcceptedState as Invocation;
    event('browser_context_closed', { stage: 'acceptance_handoff', outcome: 'confirmed', details: { target_open: false } });
    resolveAcceptance(acceptedState);
    if (acceptedState.state === 'completed' || acceptedState.state === 'failed') {
      event('terminal_observed', { state: acceptedState.state, stage: 'acceptance_observation' });
      return;
    }
    while (true) {
      await sleep(pollMs);
      stage = 'terminal_observation';
      const terminal = await store.readInvocation(acceptedState.pageId, id);
      if (terminal.state === 'completed' || terminal.state === 'failed') {
        event('terminal_observed', { state: terminal.state, stage });
        return;
      }
      if (terminal.state !== 'in_progress') fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${terminal.state}.`);
    }
  }).catch(async (error: unknown) => {
    if (observedAcceptance) {
      // A close error cannot revoke remote acceptance; retain the remote lifecycle
      // and report that the required pre-return tab cleanup did not complete.
      event('browser_context_closed', { stage: 'acceptance_handoff', outcome: 'failed', error: telemetryError(error), details: { target_open: true } });
      event('admission_failed', { stage: 'acceptance_handoff', outcome: 'tab_close_failed', error: telemetryError(error) });
      rejectAcceptance(error);
      return;
    }
    if (!acceptedRemotely) {
      const browserCloseError = (error as any)?.browserCloseError ?? (error instanceof ShotError && error.code === 'BROWSER_CONTEXT_CLOSE_FAILED' ? error : undefined);
      event('browser_context_closed', {
        stage: 'admission_exit',
        outcome: browserCloseError ? 'failed' : 'confirmed',
        ...(browserCloseError ? { error: telemetryError(browserCloseError) } : {}),
        details: { target_open: Boolean(browserCloseError) },
      });
      if (options.diagnostics && error instanceof ShotError) {
        try {
          const diagnostics = browser.diagnosticReport?.();
          if (diagnostics?.length) error.diagnostics = diagnostics;
        } catch { /* diagnostics are best-effort */ }
      }
      event('admission_failed', { stage, error: telemetryError(error) });
      rejectAcceptance(error);
    } else {
      event('observer_failed', { stage, error: telemetryError(error) });
    }
    throw error;
  });

  void completion.catch(() => {});
  try {
    const job = await acceptance;
    return { job, completion: completion.then(() => undefined) };
  } finally { options.signal?.removeEventListener('abort', relayCancellation); }
}
