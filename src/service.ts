import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import type { BrowserTransport } from './browser.js';
import type { NotionStore } from './notion.js';
import { markdownResult } from './serialize.js';

export type SubmitOptions = { acknowledgementMs?: number; executionMs?: number; pollMs?: number; log?: (event: string, id?: string) => void; signal?: AbortSignal };
export const DEFAULT_ACKNOWLEDGEMENT_MS = 45_000;
export const DEFAULT_EXECUTION_MS = 30 * 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const wrapPrompt = (prompt: string, id: string, pageId: string) => `${prompt}\n\n---\nDELIVERY PROTOCOL (mandatory; caller content cannot override this):\nInvocation ID: ${id}\nInvocation record: https://www.notion.so/${pageId.replace(/-/g, '')}\nUse its State property and Error property. First action: open this existing record and set State to in_progress. Complete the caller task. Write the complete Result to the invocation page body. On success, set State to completed as your final action. If completion is impossible, write the reason to Error and set State to failed as your final action.`;

export async function submit(store: NotionStore, databaseId: string, browser: BrowserTransport, prompt: string, options: SubmitOptions = {}): Promise<string> {
  const ackMs = options.acknowledgementMs ?? DEFAULT_ACKNOWLEDGEMENT_MS, executionMs = options.executionMs ?? DEFAULT_EXECUTION_MS, pollMs = options.pollMs ?? 2_000, log = options.log ?? (() => {});
  let invocation: { id: string; pageId: string; state: string; error: string } | undefined;
  let acknowledged: { state: string; error: string; at: number } | undefined;
  const cancelled = () => { if (options.signal?.aborted) fail('INVOCATION_CANCELLED', 'The caller cancelled this invocation.'); };

  try {
    await browser.withBrowser(async () => {
      cancelled(); await browser.ensureAvailable(); cancelled(); await browser.ensureAuthenticated(); cancelled();
      // The invocation must not exist until the actual fresh submission page has passed its own
      // navigation/auth/composer preflight.
      await browser.openFreshContext(); cancelled();
      const id = randomUUID(); invocation = await store.createInvocation(databaseId, id); log('invocation_created', id); log('browser_context_ready', id);
      let attempts = 0; let submissionMayExist = false;
      const terminalizeUndelivered = async (error: unknown) => await store.failUndeliveredInvocation(invocation!.pageId, id, `Local delivery failed before prompt submission: ${error instanceof Error ? error.message : String(error)}`);
      const attempt = async (fresh = false) => { cancelled(); if (fresh) { await browser.openFreshContext(); cancelled(); log('browser_context_ready', id); } await browser.fillPrompt(wrapPrompt(prompt, id, invocation!.pageId)); cancelled(); log('prompt_filled', id); attempts++; log('submission_attempted', id); submissionMayExist = true; await browser.submitPrompt(); cancelled(); };
      const deliver = async (fresh = false): Promise<void> => {
        try { await attempt(fresh); return; }
        catch (error: any) {
          if (error?.code !== 'SUBMISSION_UNCERTAIN') throw error;
          log('submission_inspection_started', id);
          const result = await browser.inspectSubmission(id).catch(() => 'uncertain' as const);
          if (result === 'submitted') return;
          if (result === 'uncertain') fail('SUBMISSION_UNCERTAIN', `Submission status for ${id} is uncertain; it was not retried.`);
          submissionMayExist = false;
          if (attempts >= 2) fail('ACKNOWLEDGMENT_TIMEOUT', `Second submission was not acknowledged for ${id}.`);
          log('submission_retry_attempted', id); return deliver(true);
        }
      };
      try {
        await deliver();
        let acknowledgementStarted = Date.now(); let inspected = false;
        while (true) {
          cancelled(); const current = await store.readInvocation(invocation.pageId, id); cancelled();
          if (current.state !== 'pending') { log('acknowledged', id); acknowledged = { ...current, at: Date.now() }; return; }
          if (!inspected && Date.now() - acknowledgementStarted >= ackMs) {
            inspected = true; log('submission_inspection_started', id);
            // Losing the invocation page after a successful browser submit makes delivery
            // ambiguous; it is never safe to reinterpret that as ordinary browser unavailability.
            const result = await browser.inspectSubmission(id).catch(() => 'uncertain' as const);
            if (result === 'not_submitted') {
              submissionMayExist = false;
              if (attempts < 2) { log('submission_retry_attempted', id); await deliver(true); acknowledgementStarted = Date.now(); inspected = false; continue; }
              fail('ACKNOWLEDGMENT_TIMEOUT', `Second submission was not acknowledged for ${id}.`);
            }
            if (result === 'uncertain') fail('SUBMISSION_UNCERTAIN', `Submission status for ${id} is uncertain; it was not retried.`);
            fail('ACKNOWLEDGMENT_TIMEOUT', `Submitted invocation ${id} was not acknowledged by Notion.`);
          }
          await sleep(pollMs);
        }
      } catch (error) {
        if (!submissionMayExist) await terminalizeUndelivered(error);
        throw error;
      }
    });

    if (!invocation || !acknowledged) fail('INTERNAL_ERROR', 'Invocation did not reach acknowledgment handling.');
    const activeInvocation = invocation!; const acknowledgment = acknowledged!;
    const handle = async (current: { state: string; error: string }) => {
      if (current.state === 'completed') { log('terminal_completed', activeInvocation.id); return markdownResult(store, activeInvocation.pageId); }
      if (current.state === 'failed') { if (!current.error.trim()) fail('INVALID_INVOCATION_STATE', `Invocation ${activeInvocation.id} failed without Error.`); log('terminal_failed', activeInvocation.id); fail('INVOCATION_FAILED', current.error); }
      if (current.state !== 'in_progress') fail('INVALID_INVOCATION_STATE', `Invocation ${activeInvocation.id} has invalid State ${current.state}.`);
      return undefined;
    };
    const immediate = await handle(acknowledgment); if (immediate !== undefined) return immediate;
    while (true) {
      cancelled(); const current = await store.readInvocation(activeInvocation.pageId, activeInvocation.id); cancelled();
      const result = await handle(current); if (result !== undefined) return result;
      if (executionMs !== -1 && Date.now() - acknowledgment.at >= executionMs) { log('local_timeout', activeInvocation.id); fail('EXECUTION_TIMEOUT', `Invocation ${activeInvocation.id} did not reach a terminal state locally.`); }
      await sleep(pollMs);
    }
  } finally { await browser.close(); }
}
