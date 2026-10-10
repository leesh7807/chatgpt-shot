import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_TELEMETRY_ATTEMPT_LIMIT, JOB_TELEMETRY_RELATIVE_PATH, jobTelemetryPath, LocalJobTelemetryWriter, readRecentJobTelemetry } from '../src/job-telemetry.js';

test('resolves telemetry under the XDG cache location', () => {
  const prior = process.env.XDG_CACHE_HOME; const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-telemetry-'));
  try {
    process.env.XDG_CACHE_HOME = directory;
    assert.equal(jobTelemetryPath(), join(directory, JOB_TELEMETRY_RELATIVE_PATH));
  } finally { if (prior === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prior; rmSync(directory, { recursive: true, force: true }); }
});

test('local writer treats storage errors as best-effort', () => {
  const writer = new LocalJobTelemetryWriter('/dev/null/chatgpt-shot/jobs.jsonl');
  assert.doesNotThrow(() => writer.record({ job_id: 'job-1', event: 'admission_started', timestamp: new Date().toISOString() }));
});

test('retains full event trails for the latest 100 attempts without storing prompt text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-shot-telemetry-'));
  const path = join(directory, 'jobs.jsonl'); const writer = new LocalJobTelemetryWriter(path);
  try {
    for (let index = 0; index < JOB_TELEMETRY_ATTEMPT_LIMIT + 5; index++) {
      const id = `job-${index}`; const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      writer.record({ job_id: id, event: 'admission_started', timestamp });
      writer.record({ job_id: id, event: 'prompt_fill_started', timestamp, details: { deadline_ms: 180_000 } });
      writer.record({ job_id: id, event: 'notion_write_access_recovery', timestamp, sequence: 3, elapsed_ms: 5, stage: 'acceptance_observation', outcome: 'approval_button_click_reported', duration_ms: 25, details: { button_found: true, click_attempted: true, attempted_choice: 'always_allow', tab_index: 2, opened_fresh_tab: true } });
      writer.record({ job_id: id, event: 'admission_failed', timestamp, error: { code: 'SUBMISSION_UNCERTAIN' }, prompt: 'private prompt must not be stored' } as any);
    }
    const attempts = readRecentJobTelemetry(path);
    assert.equal(attempts.length, 100);
    assert.equal(attempts[0].job_id, 'job-5');
    assert.equal(attempts.at(-1)?.job_id, 'job-104');
    assert.equal(attempts[0].events.length, 4);
    assert.deepEqual(attempts[0].events.find(event => event.event === 'notion_write_access_recovery'), {
      job_id: 'job-5', event: 'notion_write_access_recovery', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toISOString(),
      sequence: 3, elapsed_ms: 5, duration_ms: 25, stage: 'acceptance_observation', outcome: 'approval_button_click_reported', details: { button_found: true, click_attempted: true, attempted_choice: 'always_allow', tab_index: 2, opened_fresh_tab: true },
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8').includes('private prompt'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
