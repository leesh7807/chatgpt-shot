import type { JobTelemetryAttempt, JobTelemetryRecord } from './job-telemetry.js';

export type RemoteJobObservation =
  | { status: 'not_checked' | 'unavailable'; source: 'notion'; reason: string; code?: string }
  | { status: 'not_found'; source: 'notion' }
  | { status: 'pending' | 'accepted'; source: 'notion'; job: { id: string; state: string; error?: string | null } };

type Delivery = 'submitted' | 'not_submitted' | 'uncertain' | 'unknown';
const acceptedStates = new Set(['in_progress', 'completed', 'failed']);
const mostRecent = (events: JobTelemetryRecord[], event: JobTelemetryRecord['event']) => [...events].reverse().find((item) => item.event === event);

function localAcceptance(events: JobTelemetryRecord[]) {
  const observation = [...events].reverse().find((event) => event.event === 'notion_observation' && (acceptedStates.has(event.state ?? '') || event.outcome === 'accepted'));
  return observation ? { observed: true, state: observation.state ?? null, at: observation.timestamp } : { observed: false, state: null, at: null };
}

function lastAdmissionObservation(events: JobTelemetryRecord[]) {
  const observation = mostRecent(events, 'notion_observation');
  if (!observation) return { status: 'not_observed', state: null, outcome: null, at: null, source: 'local_attempt_telemetry' };
  const status = acceptedStates.has(observation.state ?? '') || observation.outcome === 'accepted' || observation.outcome === 'late_acceptance'
    ? 'accepted'
    : observation.state === 'pending' || observation.outcome === 'pending' || observation.outcome === 'late_pending'
      ? 'pending'
      : observation.outcome === 'read_failed' || observation.outcome === 'late_read_failed'
        ? 'read_failed'
        : 'unresolved';
  return { status, state: observation.state ?? null, outcome: observation.outcome ?? null, at: observation.timestamp, source: 'local_attempt_telemetry' };
}

function deliveryOf(attempt: JobTelemetryAttempt | undefined): Delivery {
  if (!attempt) return 'unknown';
  const events = attempt.events;
  const inspection = mostRecent(events, 'submission_inspected')?.inspection;
  if (inspection === 'submitted' || inspection === 'not_submitted' || inspection === 'uncertain') return inspection;
  if (mostRecent(events, 'submit_action_returned')?.outcome === 'not_attempted') return 'not_submitted';
  if (events.some((event) => event.event === 'submission_attempted')) return 'uncertain';
  if (events.some((event) => event.event === 'admission_failed')) return 'not_submitted';
  return 'uncertain';
}

function retryStatus(attempt: JobTelemetryAttempt | undefined, delivery: Delivery, remote: RemoteJobObservation, acceptanceObserved: boolean) {
  if (remote.status === 'accepted' || acceptanceObserved) return { status: 'unsafe' as const, reason: 'An accepted remote Job was observed; continue tracking this Job.' };
  if (remote.status === 'pending') return { status: 'unsafe' as const, reason: 'A pending remote Invocation exists; reconcile it before considering another submission.' };
  if (delivery === 'submitted') return { status: 'unsafe' as const, reason: 'Prompt delivery was confirmed, so another submission could duplicate the work.' };
  if (delivery !== 'not_submitted') return { status: 'unknown' as const, reason: 'Prompt delivery is not proven absent; do not submit again yet.' };
  if (!attempt) return { status: 'unknown' as const, reason: 'No local Attempt evidence is available.' };

  const events = attempt.events;
  const pendingObserved = events.some((event) => event.event === 'notion_observation' && (event.state === 'pending' || event.outcome === 'pending' || event.outcome === 'late_pending'));
  const invocationCreated = events.some((event) => event.event === 'invocation_created') || pendingObserved;
  const invocationCreateRequested = events.some((event) => event.event === 'notion_request' && event.operation === 'pages.create');
  const cleanup = mostRecent(events, 'cleanup');
  const remoteConfirmsNoInvocation = remote.status === 'not_found';
  if (invocationCreated && cleanup?.outcome !== 'succeeded' && !remoteConfirmsNoInvocation) {
    return { status: cleanup?.outcome === 'failed' ? 'unsafe' as const : 'unknown' as const, reason: cleanup?.outcome === 'failed' ? 'Invocation cleanup failed; confirm the remote record is absent before another submission.' : 'The created Invocation has not been confirmed cleaned up.' };
  }
  if (!invocationCreated && invocationCreateRequested && !remoteConfirmsNoInvocation && cleanup?.outcome !== 'succeeded') {
    return { status: 'unknown' as const, reason: 'Invocation creation may have reached Notion; its remote record is not confirmed absent.' };
  }
  return { status: 'safe' as const, reason: 'The prompt was not submitted and any created Invocation is confirmed absent or cleaned up.' };
}

export function buildAttemptRecoveryReport(attemptId: string, attempt: JobTelemetryAttempt | undefined, remote: RemoteJobObservation, localErrorCode?: string) {
  const events = attempt?.events ?? [];
  const delivery = deliveryOf(attempt);
  const acceptance = localAcceptance(events);
  const lastObservation = lastAdmissionObservation(events);
  const remoteAccepted = remote.status === 'accepted';
  const retry = retryStatus(attempt, delivery, remote, acceptance.observed);
  const failure = mostRecent(events, 'admission_failed')?.error;
  const errorCode = failure?.code;
  const stage = [...events].reverse().find((event) => event.stage)?.stage ?? null;
  const actions = remoteAccepted || acceptance.observed
    ? [`chatgpt-shot jobs ${attemptId}`, `chatgpt-shot inspect ${attemptId}`]
    : errorCode === 'CHATGPT_AUTH_REQUIRED' || errorCode === 'USER_INTERVENTION_REQUIRED'
      ? ['Run chatgpt-shot open in a terminal and confirm the visible browser action, complete sign-in or the browser check yourself, then close Chrome.', 'After manual intervention, reconcile with chatgpt-shot inspect ' + attemptId + '.']
      : retry.status === 'safe'
        ? ['If the original request is still needed, submit it once manually. Automatic retry is not performed.', 'Keep ' + attemptId + ' and reconcile it with chatgpt-shot inspect ' + attemptId + '.']
        : ['Do not resubmit yet. Recheck this Attempt with chatgpt-shot inspect ' + attemptId + ' after the missing evidence or Notion access is available.'];

  return {
    schema_version: 1,
    attempt_id: attemptId,
    local_attempt: localErrorCode ? {
      found: false,
      status: 'unavailable',
      code: localErrorCode,
      source: 'local_attempt_telemetry',
      authority: 'local_evidence',
    } : attempt ? {
      found: true,
      status: 'available',
      source: 'local_attempt_telemetry',
      authority: 'local_evidence',
      started_at: attempt.started_at,
      last_stage: stage,
      error_code: errorCode ?? null,
      delivery,
      remote_acceptance_observed_during_admission: { ...acceptance, last_observation: lastObservation },
      events,
    } : { found: false, status: 'not_found', source: 'local_attempt_telemetry', authority: 'local_evidence' },
    remote,
    retry_safety: { status: retry.status, automatic_retry: false, reason: retry.reason },
    next_actions: actions,
  };
}
