import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { State } from './notion.js';

export const JOB_TELEMETRY_RELATIVE_PATH = 'chatgpt-shot/jobs.jsonl';
export const JOB_TELEMETRY_ATTEMPT_LIMIT = 100;

export type JobTelemetryEventName =
  | 'admission_started'
  | 'notion_schema_validation'
  | 'browser_stage'
  | 'browser_context_opened'
  | 'invocation_created'
  | 'prompt_fill_started'
  | 'prompt_filled'
  | 'prompt_fill_failed'
  | 'submission_attempted'
  | 'submit_action_returned'
  | 'submit_action_failed'
  | 'submission_inspected'
  | 'notion_write_access_recovery'
  | 'notion_observation'
  | 'notion_request'
  | 'accepted'
  | 'browser_context_closed'
  | 'terminal_observed'
  | 'admission_deadline_reached'
  | 'admission_failed'
  | 'observer_failed'
  | 'cleanup'
  | 'caller_cancelled';

export type JobTelemetryError = {
  code?: string;
  cause_code?: string;
  category?: string;
  network_code?: string;
  status?: number;
  retry_after_seconds?: number;
};

export type JobTelemetryRecord = {
  job_id: string;
  event: JobTelemetryEventName;
  timestamp: string;
  sequence?: number;
  elapsed_ms?: number;
  duration_ms?: number;
  stage?: string;
  operation?: string;
  state?: State;
  error?: JobTelemetryError;
  inspection?: 'submitted' | 'not_submitted' | 'uncertain';
  outcome?: string;
  details?: Record<string, string | number | boolean | null>;
};

export type JobTelemetryInput = Omit<JobTelemetryRecord, 'job_id' | 'timestamp' | 'sequence' | 'elapsed_ms'>;

export interface JobTelemetryWriter {
  record(event: JobTelemetryRecord): void;
}

const allowedEvents = new Set<JobTelemetryEventName>([
  'admission_started', 'notion_schema_validation', 'browser_stage', 'browser_context_opened', 'invocation_created', 'prompt_fill_started', 'prompt_filled', 'prompt_fill_failed',
  'submission_attempted', 'submit_action_returned', 'submit_action_failed', 'submission_inspected', 'notion_write_access_recovery',
  'notion_observation', 'notion_request', 'accepted', 'browser_context_closed', 'terminal_observed',
  'admission_deadline_reached', 'admission_failed', 'observer_failed', 'cleanup', 'caller_cancelled',
]);
const allowedDetails = new Set([
  'reason', 'method', 'message_marker_seen', 'composer_marker_present', 'sample_count', 'retry_after_seconds',
  'retry_count', 'queue_wait_ms', 'status', 'target_open', 'browser_context_closed', 'concurrency',
  'delivery', 'deadline_ms', 'remaining_ms', 'http_status', 'rate_limit_reason', 'admission_elapsed_ms', 'composer_present', 'permission_choice', 'attempted_choice',
  'button_found', 'click_attempted',
]);
const safeToken = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : undefined;
const safeNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
const safeBoolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const fileByPath = new Map<string, Set<string>>();
const uid = process.getuid?.();

export const jobTelemetryPath = () => join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), JOB_TELEMETRY_RELATIVE_PATH);

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error('Submission telemetry directory is not private and owner-controlled.');
  }
}

function assertSecureFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) throw new Error('Submission telemetry file is not an owner-controlled regular file.');
  chmodSync(path, 0o600);
  return true;
}

function sanitizeRecord(input: unknown): JobTelemetryRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, any>;
  const job_id = safeToken(value.job_id);
  const event = value.event as JobTelemetryEventName;
  const timestamp = typeof value.timestamp === 'string' && !Number.isNaN(Date.parse(value.timestamp)) ? value.timestamp : undefined;
  if (!job_id || !allowedEvents.has(event) || !timestamp) return undefined;
  const output: JobTelemetryRecord = { job_id, event, timestamp };
  const sequence = safeNumber(value.sequence), elapsed = safeNumber(value.elapsed_ms), duration = safeNumber(value.duration_ms);
  if (sequence !== undefined) output.sequence = sequence;
  if (elapsed !== undefined) output.elapsed_ms = elapsed;
  if (duration !== undefined) output.duration_ms = duration;
  for (const name of ['stage', 'operation', 'outcome'] as const) {
    const token = safeToken(value[name]);
    if (token) output[name] = token;
  }
  if (['pending', 'in_progress', 'completed', 'failed'].includes(value.state)) output.state = value.state;
  if (['submitted', 'not_submitted', 'uncertain'].includes(value.inspection)) output.inspection = value.inspection;
  if (value.error && typeof value.error === 'object') {
    const error: JobTelemetryError = {};
    for (const name of ['code', 'cause_code', 'category', 'network_code'] as const) {
      const token = safeToken(value.error[name]);
      if (token) error[name] = token;
    }
    for (const name of ['status', 'retry_after_seconds'] as const) {
      const number = safeNumber(value.error[name]);
      if (number !== undefined) error[name] = number;
    }
    if (Object.keys(error).length) output.error = error;
  }
  if (value.details && typeof value.details === 'object') {
    const details: NonNullable<JobTelemetryRecord['details']> = {};
    for (const [name, item] of Object.entries(value.details)) {
      if (!allowedDetails.has(name)) continue;
      if (typeof item === 'boolean') details[name] = item;
      else if (typeof item === 'number' && Number.isFinite(item) && item >= 0) details[name] = Math.round(item);
      else if (typeof item === 'string') {
        const token = safeToken(item);
        if (token) details[name] = token;
      } else if (item === null) details[name] = null;
    }
    if (Object.keys(details).length) output.details = details;
  }
  return output;
}

function readRecords(path: string): JobTelemetryRecord[] {
  if (!assertSecureFile(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { const record = sanitizeRecord(JSON.parse(line)); return record ? [record] : []; }
    catch { return []; }
  });
}

function retainedIds(path: string): Set<string> {
  const cached = fileByPath.get(path);
  if (cached) return cached;
  const ids = new Set<string>();
  for (const record of readRecords(path)) if (record.event === 'admission_started') ids.add(record.job_id);
  const trimmed = new Set([...ids].slice(-JOB_TELEMETRY_ATTEMPT_LIMIT));
  fileByPath.set(path, trimmed);
  return trimmed;
}

function prune(path: string, newRecord: JobTelemetryRecord): Set<string> {
  const records = [...readRecords(path), newRecord];
  const startTimes = new Map<string, string>();
  for (const record of records) {
    if (record.event === 'admission_started' && !startTimes.has(record.job_id)) startTimes.set(record.job_id, record.timestamp);
  }
  const keep = new Set([...startTimes.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(-JOB_TELEMETRY_ATTEMPT_LIMIT)
    .map(([id]) => id));
  const retained = records.filter((record) => keep.has(record.job_id));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, retained.map((record) => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  fileByPath.set(path, keep);
  return keep;
}

/**
 * Best-effort local admission diagnostics. A new admission prunes by attempt,
 * while all events for the newest 100 attempts remain available after restart.
 */
export class LocalJobTelemetryWriter implements JobTelemetryWriter {
  constructor(private readonly path: string | undefined = jobTelemetryPath()) {}

  record(event: JobTelemetryRecord): void {
    if (!this.path) return;
    try {
      secureDirectory(dirname(this.path));
      const safe = sanitizeRecord(event);
      if (!safe) return;
      const retained = retainedIds(this.path);
      if (safe.event === 'admission_started') {
        prune(this.path, safe);
        return;
      }
      if (!retained.has(safe.job_id)) return;
      assertSecureFile(this.path);
      appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch {
      // Local diagnostics must never change submission or remote Job behavior.
    }
  }
}

/** Adds an ordered, monotonic clock to one submission attempt's event trail. */
export class JobTelemetrySession {
  private sequence = 0;
  private readonly startedAt = performance.now();
  constructor(readonly jobId: string, private readonly writer: JobTelemetryWriter = new LocalJobTelemetryWriter()) {}
  record(event: JobTelemetryInput): void {
    try {
      this.writer.record({
        job_id: this.jobId,
        timestamp: new Date().toISOString(),
        sequence: ++this.sequence,
        elapsed_ms: performance.now() - this.startedAt,
        ...event,
      });
    } catch { /* diagnostic side effect only */ }
  }
}

export type JobTelemetryAttempt = { job_id: string; started_at: string; events: JobTelemetryRecord[] };

export function readRecentJobTelemetry(path = jobTelemetryPath(), jobId?: string, limit = JOB_TELEMETRY_ATTEMPT_LIMIT): JobTelemetryAttempt[] {
  const records = readRecords(path);
  const attempts = new Map<string, JobTelemetryAttempt>();
  for (const record of records) {
    if (jobId && record.job_id !== jobId) continue;
    let attempt = attempts.get(record.job_id);
    if (!attempt) {
      attempt = { job_id: record.job_id, started_at: record.timestamp, events: [] };
      attempts.set(record.job_id, attempt);
    }
    if (record.event === 'admission_started') attempt.started_at = record.timestamp;
    attempt.events.push(record);
  }
  return [...attempts.values()]
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .slice(-Math.max(1, Math.min(JOB_TELEMETRY_ATTEMPT_LIMIT, Math.trunc(limit))));
}
