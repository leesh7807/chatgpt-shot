import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { brokerRequest, brokerSocket } from './broker.js';
import { fail } from './errors.js';

export type Inspection = 'submitted' | 'not_submitted' | 'uncertain';
export interface BrowserTransport { withBrowser<T>(operation: () => Promise<T>): Promise<T>; ensureAvailable(): Promise<void>; ensureAuthenticated(): Promise<void>; openFreshContext(): Promise<void>; fillPrompt(prompt: string): Promise<void>; submitPrompt(): Promise<void>; inspectSubmission(invocationId: string): Promise<Inspection>; close(): Promise<void>; }

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const profilePath = (profile: string) => profile;
const systemChrome = () => [process.env.CHATGPT_SHOT_BROWSER, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path): path is string => Boolean(path && existsSync(path)));
async function request(root: string, operation: string, sessionId?: string, prompt?: string, invocationId?: string) { try { return await brokerRequest(root, { operation, sessionId, prompt, invocationId }); } catch (error: any) { if (error.code) return fail(error.code, error.message); throw error; } }
export async function ensureBroker(profile: string) {
  const absent = (error: any) => error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED';
  try { await request(profile, 'ensure'); return; } catch (error: any) {
    if (!absent(error)) throw error;
    if (error.code === 'ECONNREFUSED') try { unlinkSync(brokerSocket(profile)); } catch {}
  }
  if (!existsSync(process.argv[1])) fail('BROWSER_UNAVAILABLE', 'Cannot locate the chatgpt-shot broker entry point.');
  // Development execution via tsx supplies the TypeScript loader through execArgv; retain it when
  // the detached broker is spawned so the broker has the same executable semantics as its caller.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__broker'], { detached: true, stdio: 'ignore' }); child.unref();
  for (let attempt = 0; attempt < 50; attempt++) { try { await request(profile, 'ensure'); return; } catch (error: any) { if (!absent(error)) throw error; await wait(100); } }
  fail('BROWSER_UNAVAILABLE', 'Could not start the local ChatGPT browser broker.');
}
export async function manualLogin(profile: string): Promise<void> {
  await shutdownBroker(profile);
  const executable = systemChrome(); if (!executable) fail('BROWSER_UNAVAILABLE', 'A supported system Chrome executable is required for manual login.');
  const path = profilePath(profile); mkdirSync(path, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => { const child: import('node:child_process').ChildProcess = spawn(executable!, [`--user-data-dir=${path}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com/'], { stdio: 'ignore' }); child.once('error', reject); child.once('close', () => resolve()); });
}
export async function shutdownBroker(root: string): Promise<void> {
  try { await request(root, 'shutdown'); }
  catch (error: any) {
    // No broker is the normal first-login and already-shut-down state. Do not conceal a live
    // broker's shutdown failure, which has a different error category.
    if (error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED') return;
    throw error;
  }
}

export class ChatGPTBrowser implements BrowserTransport {
  private sessionId?: string;
  constructor(private readonly profile: string) {}
  async withBrowser<T>(operation: () => Promise<T>) { try { return await operation(); } finally { await this.close(); } }
  async ensureAvailable() { await ensureBroker(this.profile); }
  async ensureAuthenticated() { const status = await request(this.profile, 'auth') as { authenticated?: boolean }; if (!status?.authenticated) fail('CHATGPT_AUTH_REQUIRED', 'ChatGPT authentication is required. Run `chatgpt-shot login`.'); }
  async openFreshContext() { await this.close(); this.sessionId = await request(this.profile, 'open'); }
  async fillPrompt(prompt: string) { if (!this.sessionId) fail('BROWSER_UNAVAILABLE', 'Browser invocation page is unavailable.'); await request(this.profile, 'fill', this.sessionId, prompt); }
  async submitPrompt() {
    if (!this.sessionId) fail('BROWSER_UNAVAILABLE', 'Browser invocation page is unavailable.');
    try { await request(this.profile, 'submit', this.sessionId); }
    catch (error: any) { fail('SUBMISSION_UNCERTAIN', `Browser transport failed while submitting: ${error?.message ?? String(error)}`); }
  }
  async inspectSubmission(invocationId: string): Promise<Inspection> { if (!this.sessionId) return 'uncertain'; return request(this.profile, 'inspect', this.sessionId, undefined, invocationId); }
  async close() { if (this.sessionId) await request(this.profile, 'close', this.sessionId).catch(() => {}); this.sessionId = undefined; }
}

export { brokerSocket };
