import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_TELEMETRY_RELATIVE_PATH, jobTelemetryPath, LocalJobTelemetryWriter } from '../src/job-telemetry.js';

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
