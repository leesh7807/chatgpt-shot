import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { State } from './notion.js';

export const JOB_TELEMETRY_RELATIVE_PATH = 'chatgpt-shot/jobs.jsonl';

export type JobTelemetryEventName =
  | 'admission_started'
  | 'invocation_created'
  | 'prompt_filled'
  | 'submission_attempted'
  | 'submit_returned'
  | 'submission_inspected'
  | 'accepted'
  | 'terminal_observed'
  | 'admission_failed'
  | 'observer_failed'
  | 'cleanup'
  | 'caller_cancelled';

export type JobTelemetryError = { code?: string; message: string };
export type JobTelemetryRecord = {
  job_id: string;
  event: JobTelemetryEventName;
  timestamp: string;
  stage?: string;
  state?: State;
  error?: JobTelemetryError;
  inspection?: 'submitted' | 'not_submitted' | 'uncertain';
  outcome?: 'succeeded' | 'failed';
};

export interface JobTelemetryWriter {
  record(event: JobTelemetryRecord): void;
}

export const jobTelemetryPath = () => join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), JOB_TELEMETRY_RELATIVE_PATH);

/**
 * Best-effort local diagnostic writer. Its filesystem errors are intentionally
 * isolated from Job admission and observer control flow by record().
 */
export class LocalJobTelemetryWriter implements JobTelemetryWriter {
  constructor(private readonly path: string | undefined = jobTelemetryPath()) {}

  record(event: JobTelemetryRecord): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Telemetry is a diagnostic side effect and must never change Job behavior.
    }
  }
}
