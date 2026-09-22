import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chatgptShotRepositoryRoot, JOB_TELEMETRY_RELATIVE_PATH, jobTelemetryPath, LocalJobTelemetryWriter } from '../src/job-telemetry.js';

test('resolves canonical telemetry storage from the executing checkout', () => {
  assert.ok(chatgptShotRepositoryRoot?.endsWith('/chatgpt-shot-job-execution-telemetry'));
  assert.equal(jobTelemetryPath, join(chatgptShotRepositoryRoot!, JOB_TELEMETRY_RELATIVE_PATH));
});

test('local writer treats storage errors as best-effort', () => {
  const writer = new LocalJobTelemetryWriter('/dev/null/chatgpt-shot/jobs.jsonl');
  assert.doesNotThrow(() => writer.record({ job_id: 'job-1', event: 'admission_started', timestamp: new Date().toISOString() }));
});
