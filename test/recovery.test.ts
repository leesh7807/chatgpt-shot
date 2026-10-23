import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobTelemetryAttempt, JobTelemetryRecord } from '../src/job-telemetry.js';
import { buildAttemptRecoveryReport, type RemoteJobObservation } from '../src/recovery.js';

const id = '01234567-89ab-4def-8123-456789abcdef';
const event = (name: JobTelemetryRecord['event'], fields: Partial<JobTelemetryRecord> = {}): JobTelemetryRecord => ({
  job_id: id,
  event: name,
  timestamp: '2026-10-23T00:00:00.000Z',
  ...fields,
});
const attempt = (...events: JobTelemetryRecord[]): JobTelemetryAttempt => ({ job_id: id, started_at: events[0]?.timestamp ?? '2026-10-23T00:00:00.000Z', events });
const remoteUnavailable: RemoteJobObservation = { status: 'unavailable', source: 'notion', reason: 'notion_lookup_failed', code: 'NOTION_UNAVAILABLE' };

test('an accepted remote Job overrides local retry hints and remains trackable', () => {
  const report = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('submission_inspected', { inspection: 'submitted' }),
    event('admission_failed', { error: { code: 'BROWSER_CONTEXT_CLOSE_FAILED' } }),
  ), { status: 'accepted', source: 'notion', job: { id, state: 'in_progress' } });
  assert.equal(report.retry_safety.status, 'unsafe');
  assert.match(report.retry_safety.reason, /accepted remote Job/);
  assert.deepEqual(report.next_actions[0], `chatgpt-shot jobs ${id}`);
});

test('uncertain delivery never becomes safe when remote lookup is unavailable', () => {
  const report = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('submission_attempted'),
    event('admission_failed', { error: { code: 'SUBMISSION_UNCERTAIN' } }),
  ), remoteUnavailable);
  assert.equal(report.local_attempt.delivery, 'uncertain');
  assert.equal(report.retry_safety.status, 'unknown');
  assert.equal(report.retry_safety.automatic_retry, false);
});

test('confirmed non-delivery before Invocation creation is safe to retry manually', () => {
  const report = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('admission_failed', { stage: 'authentication', error: { code: 'CHATGPT_AUTH_REQUIRED' } }),
  ), remoteUnavailable);
  assert.equal(report.local_attempt.delivery, 'not_submitted');
  assert.equal(report.retry_safety.status, 'safe');
  assert.match(report.next_actions[0], /chatgpt-shot open/);
});

test('created Invocation requires cleanup confirmation before retry is safe', () => {
  const failedCleanup = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('invocation_created'),
    event('admission_failed', { stage: 'prompt_filling', error: { code: 'SUBMISSION_FAILED' } }),
    event('cleanup', { outcome: 'failed' }),
  ), remoteUnavailable);
  assert.equal(failedCleanup.retry_safety.status, 'unsafe');

  const cleaned = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('invocation_created'),
    event('admission_failed', { stage: 'prompt_filling', error: { code: 'SUBMISSION_FAILED' } }),
    event('cleanup', { outcome: 'succeeded' }),
  ), remoteUnavailable);
  assert.equal(cleaned.retry_safety.status, 'safe');
});

test('a pending remote Invocation blocks resubmission even when delivery was not attempted', () => {
  const report = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('invocation_created'),
    event('admission_failed', { error: { code: 'SUBMISSION_FAILED' } }),
  ), { status: 'pending', source: 'notion', job: { id, state: 'pending' } });
  assert.equal(report.retry_safety.status, 'unsafe');
  assert.match(report.retry_safety.reason, /pending remote Invocation/);
});

test('an empty local log and a missing remote record remain unknown', () => {
  const report = buildAttemptRecoveryReport(id, undefined, { status: 'not_found', source: 'notion' });
  assert.equal(report.local_attempt.found, false);
  assert.equal(report.retry_safety.status, 'unknown');
  assert.equal(report.schema_version, 1);
});

test('unavailable local diagnostics do not erase an independent remote Job observation', () => {
  const report = buildAttemptRecoveryReport(id, undefined, { status: 'accepted', source: 'notion', job: { id, state: 'failed', error: 'remote error' } }, 'LOCAL_DIAGNOSTICS_UNAVAILABLE');
  assert.equal(report.local_attempt.status, 'unavailable');
  assert.equal(report.local_attempt.code, 'LOCAL_DIAGNOSTICS_UNAVAILABLE');
  assert.equal(report.remote.status, 'accepted');
  assert.equal(report.retry_safety.status, 'unsafe');
});

test('local pending observations remain distinct from accepted remote states', () => {
  const report = buildAttemptRecoveryReport(id, attempt(
    event('admission_started'),
    event('notion_observation', { state: 'pending', outcome: 'pending', stage: 'acceptance_observation' }),
    event('admission_failed', { error: { code: 'ADMISSION_TIMEOUT' } }),
  ), remoteUnavailable);
  assert.equal(report.local_attempt.remote_acceptance_observed_during_admission.observed, false);
  assert.equal(report.local_attempt.remote_acceptance_observed_during_admission.last_observation.status, 'pending');
  assert.equal(report.retry_safety.status, 'unknown');
});
