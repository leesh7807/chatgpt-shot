import { performance } from 'node:perf_hooks';
import { fail, ShotError } from './errors.js';
import type { BrowserTransport, Inspection, SubmissionInspection, SubmitAttempt } from './browser.js';
import type { Invocation, NotionStore } from './notion.js';
import { JobTelemetrySession, LocalJobTelemetryWriter, type JobTelemetryInput, type JobTelemetryWriter } from './job-telemetry.js';
import { recoverNotionWriteAccess } from './notion-approval-assist.js';

export type SubmitOptions = {
  acknowledgementMs?: number;
  pollMs?: number;
  telemetry?: JobTelemetryWriter;
  telemetrySession?: JobTelemetrySession;
  signal?: AbortSignal;
  diagnostics?: boolean;
  /** Monotonic clock seam for controlled admission tests; not a user setting. */
  now?: () => number;
};
export type JobExecution = { job: Invocation; completion: Promise<void> };
export const DEFAULT_ACKNOWLEDGEMENT_MS = 180_000;
const INTERNAL_RETRY_AFTER_MS = 90_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const raceAdmission = async <T>(operation: Promise<T>, deadline: number, signal?: AbortSignal, now: () => number = () => performance.now()): Promise<T> => {
  const remaining = deadline - now();
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

export const wrapPrompt = (prompt: string, pageId: string) => `<task>\n${prompt}\n</task>\n\n<chatgpt-shot>\nThis block is supplied by chatgpt-shot and defines how to return the result.\n\nInvocation record:\nhttps://www.notion.so/${pageId.replace(/-/g, '')}\n\nThe user authorizes the Notion updates required for this Invocation only: set its State to \`in_progress\`, write this task's result to its page, and set the final State as specified below. Do not modify other pages or settings.\n\n1. Before starting the task, set State to \`in_progress\`.\n2. Complete the task in <task>.\n3. Write the complete result to the invocation page body.\n4. As the final action:\n   - success → set State to \`completed\`\n   - failure → write the reason to Error and set State to \`failed\`\n</chatgpt-shot>`;

/**
 * Admit one Job and resolve only after the remote writer has recorded acceptance.
 * The acknowledgement clock begins immediately before prompt filling. A returned
 * Job has had its submission tab closed; terminal observation is Notion-only.
 */
export async function startJob(store: NotionStore, databaseId: string, browser: BrowserTransport, prompt: string, id: string, options: SubmitOptions = {}): Promise<JobExecution> {
  const acknowledgementMs = options.acknowledgementMs ?? DEFAULT_ACKNOWLEDGEMENT_MS;
  const pollMs = options.pollMs ?? 2_000;
  const now = options.now ?? (() => performance.now());
  const telemetry = options.telemetrySession ?? new JobTelemetrySession(id, options.telemetry ?? new LocalJobTelemetryWriter());
  const event = (name: JobTelemetryInput['event'], fields: Omit<JobTelemetryInput, 'event'> = {}) => telemetry.record({ event: name, ...fields });
  const admissionRequests = new AbortController();
  const relayCancellation = () => admissionRequests.abort();
  if (options.signal?.aborted) admissionRequests.abort();
  else options.signal?.addEventListener('abort', relayCancellation, { once: true });
  let invocation: Invocation | undefined;
  let observedAcceptance: Invocation | undefined;
  let resolveObservedAcceptance!: (job: Invocation) => void;
  const observedAcceptanceReady = new Promise<Invocation>((resolve) => { resolveObservedAcceptance = resolve; });
  let acceptedRemotely = false;
  let lateAcceptanceObserved = false;
  let readUnresolved = false;
  let delivery: Inspection = 'uncertain';
  const possibleDeliveryAttempts = new Set<number>();
  const confirmedDeliveryAttempts = new Set<number>();
  let submissionAction: Promise<{ result?: SubmitAttempt; error?: unknown }> | undefined;
  let submissionActionSettled = false;
  let firstActionNotAttempted = false;
  let retryStarted = false;
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
  const refreshDelivery = () => {
    delivery = confirmedDeliveryAttempts.size ? 'submitted' : possibleDeliveryAttempts.size ? 'uncertain' : 'not_submitted';
  };
  const inspect = async (inspectionStage: 'post_submit' | 'deadline', deadline: number, attempt: number): Promise<Inspection> => {
    const started = performance.now();
    try {
      if (!invocation) return 'uncertain';
      const result = inspectionResult(await raceAdmission(browser.inspectSubmission(invocation.pageId.replace(/-/g, ''), { settleMs: 0 }), deadline, options.signal, now));
      if (result.inspection === 'submitted') {
        possibleDeliveryAttempts.add(attempt);
        confirmedDeliveryAttempts.add(attempt);
      } else if (result.inspection === 'not_submitted' && !confirmedDeliveryAttempts.has(attempt)) {
        possibleDeliveryAttempts.delete(attempt);
      } else if (result.inspection === 'uncertain') possibleDeliveryAttempts.add(attempt);
      refreshDelivery();
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
  const startSubmission = (attempt: number, submissionStage: 'submission' | 'submission_retry', deadline: number): Promise<{ result?: SubmitAttempt; error?: unknown }> => {
    if (!invocation) return Promise.resolve({ error: new Error('Invocation is unavailable for prompt submission.') });
    submissionActionSettled = false;
    possibleDeliveryAttempts.add(attempt);
    refreshDelivery();
    event('submission_attempted', {
      stage: submissionStage,
      details: { deadline_ms: acknowledgementMs, ...(attempt > 1 ? { retry_count: attempt - 1, reason: 'no_acceptance_after_90s' } : {}) },
    });
    const action: Promise<{ result?: SubmitAttempt; error?: unknown }> = browser.submitPrompt(invocation.pageId.replace(/-/g, '')).then(
      (result) => {
        if (result.outcome === 'not_attempted') {
          possibleDeliveryAttempts.delete(attempt);
          refreshDelivery();
        }
        event('submit_action_returned', {
          stage: submissionStage,
          outcome: result.outcome,
          details: { ...(result.outcome === 'not_attempted' ? { reason: result.reason } : { method: result.method ?? 'click' }), ...(attempt > 1 ? { retry_count: attempt - 1 } : {}) },
        });
        return { result };
      },
      (error: unknown) => {
        event('submit_action_failed', { stage: submissionStage, error: telemetryError(error), ...(attempt > 1 ? { details: { retry_count: attempt - 1 } } : {}) });
        return { error };
      },
    );
    submissionAction = action;
    void action.then((outcome) => {
      if (attempt === 1 && outcome.result?.outcome === 'not_attempted') firstActionNotAttempted = true;
      if (submissionAction === action) submissionActionSettled = true;
      if (outcome.result?.outcome !== 'not_attempted') void inspect('post_submit', deadline, attempt);
    });
    return action;
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
      const acknowledgementStarted = now();
      const acknowledgementDeadline = acknowledgementStarted + acknowledgementMs;
      const retryAt = acknowledgementStarted + INTERNAL_RETRY_AFTER_MS;
      const acceptObservation = (current: Invocation, acceptedStage: string, observedAt: number) => {
        if (acceptedRemotely || !accepted(current.state) || observedAt > acknowledgementDeadline) return;
        observedAcceptance = current;
        acceptedRemotely = true;
        store.setRequestTelemetryEnabled?.(false);
        event('accepted', { state: current.state, stage: acceptedStage, details: { admission_elapsed_ms: observedAt - acknowledgementStarted } });
        resolveObservedAcceptance(current);
      };
      event('prompt_fill_started', { stage, details: { deadline_ms: acknowledgementMs } });
      try {
        await raceAdmission(browser.fillPrompt(wrapPrompt(prompt, invocation.pageId), invocation.pageId.replace(/-/g, '')), acknowledgementDeadline, options.signal, now);
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

      if (now() >= acknowledgementDeadline) {
        stage = 'prompt_filling';
        event('admission_deadline_reached', { stage, outcome: 'expired_before_send', details: { deadline_ms: acknowledgementMs } });
        delivery = 'not_submitted';
        return await failUndelivered('deadline_before_send');
      }

      stage = 'submission';
      // UI evidence is diagnostic. Remote Notion state owns admission and is polled
      // even when the browser call or its evidence probe is uncertain.
      const firstSubmission = startSubmission(1, 'submission', acknowledgementDeadline);
      const firstSubmissionBoundary = Math.min(acknowledgementDeadline, retryAt);
      try { await raceAdmission(firstSubmission, firstSubmissionBoundary, options.signal, now); }
      catch (error) { if (!(error instanceof ShotError) || error.code !== 'ADMISSION_TIMEOUT') throw error; }
      cancelled();
      if (firstActionNotAttempted) return await failUndelivered('send_control_not_ready');
      let lastObservationError: unknown;
      let transientReadFailures = 0;
      const retryPreflight = async (): Promise<Invocation | undefined> => {
        const preflightStarted = performance.now();
        const preflight = Promise.resolve().then(() => store.readInvocation(invocation!.pageId, id)).then(
          (value) => ({ kind: 'read' as const, value, observedAt: now() }),
          (error: unknown) => ({ kind: 'error' as const, error, observedAt: now() }),
        );
        let preflightLogged = false;
        const applyPreflight = (result: { kind: 'read'; value: Invocation; observedAt: number } | { kind: 'error'; error: unknown; observedAt: number }) => {
          if (preflightLogged) return;
          preflightLogged = true;
          if (result.kind === 'error') {
            lastObservationError = result.error;
            event('notion_observation', { stage: 'retry_preflight', outcome: 'read_failed', duration_ms: performance.now() - preflightStarted, error: telemetryError(result.error) });
            return;
          }
          const current = result.value;
          const observedInTime = result.observedAt <= acknowledgementDeadline;
          event('notion_observation', { stage: 'retry_preflight', state: current.state, outcome: accepted(current.state) ? observedInTime ? 'accepted' : 'late_acceptance' : observedInTime ? 'pending' : 'late_pending', duration_ms: performance.now() - preflightStarted });
          if (observedInTime && !accepted(current.state) && current.state !== 'pending') {
            lastObservationError = new ShotError('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${current.state}.`);
            return;
          }
          if (!observedInTime) {
            if (accepted(current.state)) lateAcceptanceObserved = true;
            return;
          }
          lastObservationError = undefined;
          if (accepted(current.state)) {
            acceptObservation(current, 'retry_preflight', result.observedAt);
          }
        };
        void preflight.then(applyPreflight);
        await Promise.race([preflight, sleep(0), observedAcceptanceReady]);
        if (acceptedRemotely && observedAcceptance) return observedAcceptance;
        if (errorCode(lastObservationError) === 'INVALID_INVOCATION_STATE') throw lastObservationError;
        return undefined;
      };
      while (true) {
        cancelled();
        if (acceptedRemotely && observedAcceptance) return observedAcceptance;
        if (errorCode(lastObservationError) === 'INVALID_INVOCATION_STATE') throw lastObservationError;
        if (firstActionNotAttempted) return await failUndelivered('send_control_not_ready');
        const currentTime = now();
        const remainingMs = acknowledgementDeadline - currentTime;
        if (remainingMs <= 0) break;

        if (acknowledgementMs > INTERNAL_RETRY_AFTER_MS && !retryStarted && currentTime >= retryAt && submissionActionSettled) {
          if (acceptedRemotely && observedAcceptance) return observedAcceptance;
          retryStarted = true;

          // A fast authoritative read avoids work when acceptance is already
          // visible. A delayed read remains watched while the same Invocation is
          // prepared for its one retry.
          if (await retryPreflight()) return observedAcceptance!;
          if (now() >= acknowledgementDeadline) continue;

          cancelled();
          stage = 'retry_prompt_filling';
          const retryFillStarted = performance.now();
          event('prompt_fill_started', { stage, details: { deadline_ms: acknowledgementMs, retry_count: 1, reason: 'no_acceptance_after_90s' } });
          try {
            const fill = raceAdmission(browser.fillPrompt(wrapPrompt(prompt, invocation.pageId), invocation.pageId.replace(/-/g, '')), acknowledgementDeadline, options.signal, now).then(() => ({ kind: 'filled' as const }));
            const fillResult = await Promise.race([fill, observedAcceptanceReady.then(value => ({ kind: 'accepted' as const, value }))]);
            if (fillResult.kind === 'accepted') return fillResult.value;
            event('prompt_filled', { stage, duration_ms: performance.now() - retryFillStarted, details: { retry_count: 1 } });
            cancelled();
          } catch (error) {
            event('prompt_fill_failed', { stage, duration_ms: performance.now() - retryFillStarted, error: telemetryError(error), details: { retry_count: 1 } });
            if (error instanceof ShotError && error.code === 'ADMISSION_CANCELLED') {
              if (!cancellationRecorded) { cancellationRecorded = true; event('caller_cancelled', { stage }); }
              throw error;
            }
            continue;
          }
          if (acceptedRemotely && observedAcceptance) return observedAcceptance;
          if (now() >= acknowledgementDeadline) continue;
          cancelled();
          if (await retryPreflight()) return observedAcceptance!;
          if (now() >= acknowledgementDeadline) continue;
          cancelled();
          stage = 'submission_retry';
          startSubmission(2, 'submission_retry', acknowledgementDeadline);
          continue;
        }

        stage = 'acceptance_observation';
        const readStarted = performance.now();
        const timeoutMarker = { kind: 'timeout' as const };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;
        const aborted = options.signal ? new Promise<{ kind: 'aborted' }>((resolve) => {
          abortListener = () => resolve({ kind: 'aborted' });
          if (options.signal!.aborted) abortListener();
          else options.signal!.addEventListener('abort', abortListener, { once: true });
        }) : new Promise<never>(() => {});
        const read = store.readInvocation(invocation.pageId, id).then(
          (value) => ({ kind: 'read' as const, value, observedAt: now() }),
          (error: unknown) => ({ kind: 'error' as const, error, observedAt: now() }),
        );
        const nextObservationBoundary = acknowledgementMs > INTERNAL_RETRY_AFTER_MS && !retryStarted && now() < retryAt ? retryAt : acknowledgementDeadline;
        const observationWaitMs = Math.max(1, nextObservationBoundary - now());
        const timed = new Promise<typeof timeoutMarker>((resolve) => { timer = setTimeout(() => resolve(timeoutMarker), observationWaitMs); });
        const result = await Promise.race([read, timed, aborted, observedAcceptanceReady.then(value => ({ kind: 'accepted' as const, value }))]);
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
        if (result.kind === 'accepted') return result.value;
        if (result.kind === 'timeout' || result.kind === 'aborted') {
          void read.then((lateResult) => {
            const pastDeadline = lateResult.observedAt > acknowledgementDeadline;
            event('notion_observation', {
              stage: pastDeadline ? 'late_response' : 'retry_window_response',
              ...(lateResult.kind === 'read' ? { state: lateResult.value.state } : {}),
              outcome: lateResult.kind === 'error' ? pastDeadline ? 'late_read_failed' : 'read_failed' : accepted(lateResult.value.state) ? pastDeadline ? 'late_acceptance' : 'accepted' : pastDeadline ? 'late_pending' : 'pending',
              duration_ms: lateResult.observedAt - readStarted,
              ...(lateResult.kind === 'error' ? { error: telemetryError(lateResult.error) } : {}),
              details: { deadline_ms: acknowledgementMs },
            });
            if (lateResult.kind === 'error') lastObservationError = lateResult.error;
            else if (pastDeadline) {
              if (accepted(lateResult.value.state)) lateAcceptanceObserved = true;
            } else {
              lastObservationError = undefined;
              if (!accepted(lateResult.value.state) && lateResult.value.state !== 'pending') {
                lastObservationError = new ShotError('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${lateResult.value.state}.`);
                return;
              }
              if (accepted(lateResult.value.state)) acceptObservation(lateResult.value, 'retry_window_response', lateResult.observedAt);
            }
          });
          if (nextObservationBoundary === retryAt) continue;
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
          transientReadFailures++;
          const retryAfter = retryable && error instanceof ShotError ? error.retryAfterSeconds : undefined;
          const backoffMs = retryAfter !== undefined ? retryAfter * 1_000 : retryable ? Math.min(5_000, 500 * 2 ** Math.min(4, transientReadFailures - 1)) : pollMs;
          const pause = Math.min(backoffMs, Math.max(0, acknowledgementDeadline - now()));
          if (pause > 0) {
            const waits: Promise<unknown>[] = [sleep(pause)];
            if (submissionAction && !submissionActionSettled) waits.push(submissionAction);
            await Promise.race(waits);
          }
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
          acceptObservation(current, stage, result.observedAt);
          return current;
        }
        if (accepted(current.state) || !observedInTime) break;
        if (current.state !== 'pending') fail('INVALID_INVOCATION_STATE', `Invocation ${id} has invalid State ${current.state}.`);
        const recoveryStartedAt = performance.now();
        const recovery = await recoverNotionWriteAccess(browser);
        if (recovery && 'permissionChoice' in recovery) {
          event('notion_write_access_recovery', {
            stage,
            outcome: 'approval_button_disappeared',
            duration_ms: performance.now() - recoveryStartedAt,
            ...(recovery.permissionChoice ? { details: { permission_choice: recovery.permissionChoice } } : {}),
          });
        } else if (recovery && recovery.status !== 'not_present') {
          event('notion_write_access_recovery', {
            stage,
            outcome: recovery.status === 'click_unconfirmed' ? 'approval_prompt_click_unconfirmed' : 'approval_prompt_not_actionable',
            duration_ms: performance.now() - recoveryStartedAt,
            details: {
              reason: recovery.reason ?? recovery.status,
              ...(recovery.attemptedChoice ? { attempted_choice: recovery.attemptedChoice } : {}),
            },
          });
        }
        const afterReadMs = acknowledgementDeadline - now();
        if (afterReadMs <= 0) break;
        const waits: Promise<unknown>[] = [sleep(Math.min(pollMs, afterReadMs))];
        if (submissionAction && !submissionActionSettled) waits.push(submissionAction);
        await Promise.race(waits);
      }

      event('admission_deadline_reached', { stage: 'acceptance_observation', outcome: 'no_acceptance_observed', details: { deadline_ms: acknowledgementMs } });
      if (acceptedRemotely && observedAcceptance) return observedAcceptance;
      if (lastObservationError) throw lastObservationError;
      stage = 'deadline_inspection';
      const deliveryAtDeadline = (): Inspection => delivery;
      if (lateAcceptanceObserved) fail('ADMISSION_TIMEOUT', `Remote acceptance was first observed after the ${acknowledgementMs} ms admission deadline. The Invocation is retained.`);
      if (readUnresolved && deliveryAtDeadline() !== 'submitted') fail('SUBMISSION_UNCERTAIN', `Notion acceptance observation was still in flight at the ${acknowledgementMs} ms deadline, so the Invocation is retained and prompt delivery remains uncertain.`);
      if (deliveryAtDeadline() === 'not_submitted') return await failUndelivered('delivery_evidence_confirms_not_submitted');
      if (deliveryAtDeadline() === 'submitted') fail('ADMISSION_TIMEOUT', `The prompt may have been sent, but remote acceptance was not observed within ${acknowledgementMs} ms. The Invocation is retained.`);
      fail('SUBMISSION_UNCERTAIN', `Remote acceptance was not observed within ${acknowledgementMs} ms and prompt delivery remains uncertain. The Invocation is retained.`);
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
