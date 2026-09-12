import { ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fail, isStaleBrowserSessionError } from './errors.js';

type Request = { operation: string; sessionId?: string; prompt?: string; invocationId?: string };
type Response = { ok: true; value?: unknown } | { ok: false; code: string; message: string };
type Message = { id?: number; sessionId?: string; result?: any; error?: { message: string } };
type VirtualDisplay = { process: ChildProcess; display: string; authorizationPath: string };
const uid = process.getuid?.();
const ownedDirectory = (path: string) => { try { const stat = lstatSync(path); return stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0; } catch { return false; } };
const runtimeBase = () => {
  // A broker owns a repository profile across separate CLI invocations. XDG_RUNTIME_DIR is
  // intentionally per-session and may differ between those invocations, so it cannot name the
  // durable broker identity.
  const cache = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  if (!existsSync(cache)) mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (!ownedDirectory(cache)) fail('BROWSER_UNAVAILABLE', 'No owner-controlled local runtime directory is available.');
  return cache;
};
const runtimeDirectory = () => join(runtimeBase(), 'chatgpt-shot');
export const brokerSocket = (_profile: string) => join(runtimeDirectory(), 'broker.sock');
const profile = (path: string) => path;
const chrome = () => [process.env.CHATGPT_SHOT_BROWSER, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path): path is string => Boolean(path && existsSync(path)));
const xvfb = () => 'Xvfb';
const xAuthorityField = (value: Buffer) => { const length = Buffer.alloc(2); length.writeUInt16BE(value.length); return Buffer.concat([length, value]); };
export const privateXAuthority = (cookie: Buffer) => Buffer.concat([Buffer.from([0xff, 0xff]), xAuthorityField(Buffer.alloc(0)), xAuthorityField(Buffer.alloc(0)), xAuthorityField(Buffer.from('MIT-MAGIC-COOKIE-1')), xAuthorityField(cookie)]);
export const privateDisplayArguments = (authorizationPath: string) => ['-auth', authorizationPath, '-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'];
export const chromeArguments = (directory: string) => [`--user-data-dir=${directory}`, '--profile-directory=Default', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--no-startup-window'];
export const chromeEnvironment = (display?: string, authorizationPath?: string) => display ? { ...process.env, DISPLAY: display, ...(authorizationPath ? { XAUTHORITY: authorizationPath } : {}) } : undefined;
export const privateDisplayFromOutput = (output: string): string | undefined => {
  const display = output.trim();
  return /^\d+$/.test(display) && Number(display) <= 65_535 ? `:${display}` : undefined;
};

async function startVirtualDisplay(): Promise<VirtualDisplay | undefined> {
  if (process.platform !== 'linux') return;
  const authorizationPath = join(runtimeDirectory(), `xvfb-${randomUUID()}.Xauthority`);
  try { writeFileSync(authorizationPath, privateXAuthority(randomBytes(16)), { mode: 0o600, flag: 'wx' }); }
  catch (error) { return fail('BROWSER_UNAVAILABLE', `Could not create private Xvfb authorization: ${error instanceof Error ? error.message : String(error)}`, error); }
  const removeAuthorization = () => { try { unlinkSync(authorizationPath); } catch {} };
  const child = spawn(xvfb(), privateDisplayArguments(authorizationPath), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  const output = child.stdio[3] as NodeJS.ReadableStream | null;
  const error = child.stdio[2] as NodeJS.ReadableStream | null;
  if (!output) { child.kill(); removeAuthorization(); fail('BROWSER_UNAVAILABLE', 'Xvfb did not create its display-allocation pipe.'); }
  let stderr = '';
  error?.setEncoding('utf8'); error?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  output!.setEncoding('utf8');
  return await new Promise<VirtualDisplay>((resolve, reject) => {
    let allocation = '';
    let settled = false;
    let failing = false;
    const finish = (result?: VirtualDisplay, failure?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); child.removeListener('error', failed); child.removeListener('exit', exited);
      if (result) resolve(result); else { removeAuthorization(); reject(failure!); }
    };
    const detail = () => stderr.trim() ? `: ${stderr.trim()}` : '';
    const failed = (cause: Error) => {
      if (settled || failing) return;
      failing = true;
      const failure = Object.assign(new Error(`Xvfb is required for the Linux browser runtime and could not be started${detail()}: ${cause.message}`), { code: 'BROWSER_UNAVAILABLE' });
      if (child.exitCode !== null || !child.pid) return finish(undefined, failure);
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => { clearTimeout(force); finish(undefined, failure); });
      child.kill('SIGTERM');
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => finish(undefined, Object.assign(new Error(`Xvfb is required for the Linux browser runtime and exited before allocating a private display (code ${code ?? 'null'}, signal ${signal ?? 'none'})${detail()}`), { code: 'BROWSER_UNAVAILABLE' }));
    const timeout = setTimeout(() => failed(new Error('Xvfb did not allocate a private display before its deadline.')), 10_000);
    child.once('error', failed); child.once('exit', exited);
    output!.on('data', (chunk: string) => {
      if (failing) return;
      allocation += chunk;
      const display = privateDisplayFromOutput(allocation);
      if (display) finish({ process: child, display, authorizationPath });
      else if (allocation.length > 32) failed(new Error(`Xvfb returned an invalid private display allocation: ${JSON.stringify(allocation)}`));
    });
  });
}

/** Minimal, process-private CDP adapter; it deliberately exposes no raw CDP across broker IPC. */
class PipeCdp {
  private next = 0; private buffer = ''; private closed = false; private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private readonly input: NodeJS.WritableStream, output: NodeJS.ReadableStream) {
    output.setEncoding('utf8'); output.on('data', (chunk: string) => { this.buffer += chunk; let end: number; while ((end = this.buffer.indexOf('\0')) >= 0) { const body = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); if (body) this.receive(JSON.parse(body)); } });
    const close = () => this.finish(); input.once('error', close); output.once('end', close); output.once('close', close); output.once('error', close);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Chrome private debugging pipe is closed.'));
    const id = ++this.next; this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    });
  }
  private receive(message: Message) { if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
  private finish() { if (this.closed) return; this.closed = true; for (const pending of this.pending.values()) pending.reject(new Error('Chrome private debugging pipe closed.')); this.pending.clear(); }
  close() { this.finish(); }
}

class Page {
  private deadline = Number.POSITIVE_INFINITY;
  constructor(readonly targetId: string, readonly sessionId: string, private readonly cdp: PipeCdp) {}
  async within<T>(deadline: number, operation: () => Promise<T>): Promise<T> { const previous = this.deadline; this.deadline = Math.min(previous, deadline); try { return await operation(); } finally { this.deadline = previous; } }
  private remaining() { const ms = this.deadline - Date.now(); if (ms <= 0) fail('BROWSER_UNAVAILABLE', 'ChatGPT browser operation exceeded its broker deadline.'); return Math.min(30_000, ms); }
  async evaluate<T>(expression: string, args: unknown[] = []): Promise<T> { const result = await this.cdp.send('Runtime.evaluate', { expression: `(${expression})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, this.sessionId, this.remaining()); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Page evaluation failed.'); return result.result.value as T; }
  async navigate(url = 'https://chatgpt.com/') {
    await this.cdp.send('Page.enable', {}, this.sessionId, this.remaining());
    const result = await this.cdp.send('Page.navigate', { url }, this.sessionId, this.remaining());
    if (result.errorText) fail('BROWSER_UNAVAILABLE', `ChatGPT navigation failed: ${result.errorText}`);
    const origin = new URL(url).origin;
    for (let i = 0; i < 60; i++) {
      if (await this.evaluate<string>('()=>location.href').then((current) => new URL(current).origin === origin).catch(() => false)) return;
      await delay(500);
    }
    fail('BROWSER_UNAVAILABLE', 'ChatGPT navigation did not commit before its deadline.');
  }
  async close() { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5_000); }
}

const visibility = `const visible=e=>{const s=getComputedStyle(e),b=e.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&b.width>0&&b.height>0};`;
const authProbe = `()=>{${visibility}const c=[...document.querySelectorAll('a,button')].filter(visible);const loginVisible=c.some(e=>/^(log in|sign up)$/i.test((e.textContent||'').trim())||/\\/(auth|login)/i.test(e.href||''));const accountVisible=c.some(e=>/(account|profile|settings|upgrade plan|my plan|log out|user menu|avatar)/i.test([e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-testid'),e.textContent].filter(Boolean).join(' ')))||[...document.querySelectorAll('[data-testid*="profile"],[data-testid*="account"],img[alt*="profile" i],img[alt*="avatar" i]')].some(visible);return {loginVisible,accountVisible,authenticated:!loginVisible&&accountVisible}}`;
const composerProbe = `()=>{${visibility}return [...document.querySelectorAll('textarea,[contenteditable="true"]')].some(visible)}`;

class Broker {
  private process?: ChildProcess; private display?: VirtualDisplay; private cdp?: PipeCdp; private control?: Page; private starting?: Promise<void>; private startingChild?: ChildProcess; private startingDisplay?: VirtualDisplay; private startingCdp?: PipeCdp; private stopping = false;
  private readonly pages = new Map<string, Page>();
  constructor(private readonly root: string) {}
  private async runtime() {
    if (this.stopping) fail('BROWSER_UNAVAILABLE', 'Browser broker is shutting down.');
    if (this.cdp && this.control) return;
    if (this.starting) return this.starting;
    const start = this.startRuntime(); this.starting = start; try { return await start; } finally { this.starting = undefined; }
  }
  private async startRuntime() {
    const executable = chrome(); if (!executable) fail('BROWSER_UNAVAILABLE', 'A supported system Chrome executable is unavailable.');
    const directory = profile(this.root); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    let virtual: VirtualDisplay | undefined; let child: ChildProcess | undefined; let cdp: PipeCdp | undefined;
    try {
      virtual = await startVirtualDisplay(); this.startingDisplay = virtual;
      // Chrome normally creates a visible New Tab on process launch. The broker creates and
      // navigates its own control target below, so suppress the otherwise unused startup tab.
      // Only this Chrome child receives the broker-owned display; the broker keeps its inherited DISPLAY.
      child = spawn(executable!, chromeArguments(directory), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: chromeEnvironment(virtual?.display, virtual?.authorizationPath) }) as ChildProcess;
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
      const input = child.stdio[3], output = child.stdio[4]; if (!input || !output) fail('BROWSER_UNAVAILABLE', 'Chrome did not create its private debugging pipe.');
      cdp = new PipeCdp(input as NodeJS.WritableStream, output as NodeJS.ReadableStream); this.startingChild = child; this.startingCdp = cdp;
      child.once('exit', () => {
        if (this.process === child) { this.process = undefined; this.cdp = undefined; this.control = undefined; this.pages.clear(); }
        if (virtual && virtual === this.display) { this.display = undefined; void this.terminateDisplay(virtual); }
      });
      const deadline = Date.now() + 150_000; const control = await this.createPage(cdp, deadline); await control.within(deadline, async () => { await control.navigate(); await this.ready(control); }); if (this.stopping) throw new Error('Broker shutdown began during startup.');
      this.process = child; this.display = virtual; this.cdp = cdp; this.control = control;
    } catch (error) {
      cdp?.close(); await this.terminate(child); await this.terminateDisplay(virtual);
      if ((error as any)?.code) throw error;
      fail('BROWSER_UNAVAILABLE', `Could not launch the private ChatGPT browser runtime: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally { if (this.startingChild === child) this.startingChild = undefined; if (this.startingDisplay === virtual) this.startingDisplay = undefined; if (this.startingCdp === cdp) this.startingCdp = undefined; }
  }
  private async createPage(cdp = this.cdp!, deadline = Date.now() + 30_000) { const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) fail('BROWSER_UNAVAILABLE', 'ChatGPT target creation exceeded its broker deadline.'); return Math.min(30_000, ms); }; const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, remaining()); const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, undefined, remaining()); return new Page(created.targetId, attached.sessionId, cdp); }
  private async ready(page: Page) {
    for (let i = 0; i < 30; i++) { const state = await page.evaluate<boolean>('()=>document.readyState!=="loading"'); if (state) { if (await page.evaluate<boolean>('()=>/just a moment|checking your browser/i.test(document.body.innerText)')) fail('USER_INTERVENTION_REQUIRED', 'ChatGPT Web requires user intervention before automation can continue.'); return; } await delay(500); }
    fail('BROWSER_UNAVAILABLE', 'ChatGPT did not become ready before its deadline.');
  }
  private async auth(page: Page) {
    return page.within(Date.now() + 45_000, async () => {
      await this.ready(page);
      let last: { loginVisible: boolean; accountVisible: boolean; authenticated: boolean } = { loginVisible: false, accountVisible: false, authenticated: false };
      for (let i = 0; i < 60; i++) {
        last = await page.evaluate<{ loginVisible: boolean; accountVisible: boolean; authenticated: boolean }>(authProbe);
        if (last.authenticated || last.loginVisible) return last;
        await delay(500);
      }
      return last;
    });
  }
  private async composer(page: Page) { await this.ready(page); for (let i = 0; i < 60; i++) { if (await page.evaluate<boolean>(composerProbe)) return; await delay(500); } fail('BROWSER_UNAVAILABLE', 'The authenticated ChatGPT composer is unavailable.'); }
  private async recreateControl() {
    const deadline = Date.now() + 75_000;
    const replacement = await this.createPage(this.cdp!, deadline);
    try {
      await replacement.within(deadline, async () => { await replacement.navigate(); await this.ready(replacement); });
      const previous = this.control;
      this.control = replacement;
      await previous?.close().catch(() => {});
    } catch (error) { await replacement.close().catch(() => {}); throw error; }
  }
  async handle(request: Request): Promise<unknown> {
    await this.runtime();
    try {
      if (request.operation === 'ensure') return;
      if (request.operation === 'auth') {
        try { return await this.auth(this.control!); }
        catch (error) {
          if (!isStaleBrowserSessionError(error)) throw error;
          await this.recreateControl();
          return this.auth(this.control!);
        }
      }
      if (request.operation === 'open') { const deadline = Date.now() + 75_000; const page = await this.createPage(this.cdp!, deadline); try { await page.within(deadline, async () => { await page.navigate(); const auth = await this.auth(page); if (!auth.authenticated) fail('CHATGPT_AUTH_REQUIRED', 'ChatGPT authentication is required. Run `chatgpt-shot login`.'); await this.composer(page); }); const id = randomUUID(); this.pages.set(id, page); return id; } catch (error) { await page.close().catch(() => {}); throw error; } }
      const page = request.sessionId ? this.pages.get(request.sessionId) : undefined; if (!page) return fail('BROWSER_UNAVAILABLE', 'Browser invocation page is unavailable.');
      if (request.operation === 'fill') { const deadline = Date.now() + 45_000; await page.within(deadline, async () => { await this.composer(page); await page.evaluate(`value=>{${visibility}const e=[...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);if(!e)throw new Error('composer unavailable');e.focus();if(e instanceof HTMLTextAreaElement){const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,value)}else e.textContent=value;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))}`, [request.prompt ?? '']); }); return; }
      if (request.operation === 'submit') { const clicked = await page.evaluate<boolean>(`()=>{${visibility}const b=[...document.querySelectorAll('button')].find(e=>/send prompt|send message/i.test([e.getAttribute('aria-label'),e.textContent].filter(Boolean).join(' '))&&!e.disabled&&visible(e));if(!b)return false;b.click();return true}`); if (!clicked) await this.cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.sessionId).then(() => this.cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.sessionId)); return; }
      if (request.operation === 'inspect') { const id = request.invocationId ?? ''; const value = await page.evaluate<{ seen: boolean; value: string }>(`id=>{${visibility}const e=[...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let seen=false,node;while(node=walker.nextNode()){const parent=node.parentElement;if(!parent?.closest('textarea,[contenteditable="true"]')&&node.textContent?.includes(id)){seen=true;break}}return {seen,value:e instanceof HTMLTextAreaElement?e.value:(e?.textContent||'')}}`, [id]); return value.seen && !value.value.includes(id) ? 'submitted' : !value.seen && value.value.includes(id) ? 'not_submitted' : 'uncertain'; }
      if (request.operation === 'close') { await page.close().catch(() => {}); this.pages.delete(request.sessionId!); return; }
      fail('INTERNAL_ERROR', `Unsupported broker operation ${request.operation}.`);
    } catch (error) {
      if (request.sessionId && isStaleBrowserSessionError(error)) this.pages.delete(request.sessionId);
      throw error;
    }
  }
  async discard(sessionId: string) { const page = this.pages.get(sessionId); if (!page) return; this.pages.delete(sessionId); await page.close().catch(() => {}); }
  async close() {
    this.stopping = true;
    // A startup has not published ownership yet, but it still owns the profile.
    // Stop and reap it before reporting shutdown complete.
    const startingChild = this.startingChild;
    const startingDisplay = this.startingDisplay;
    this.startingCdp?.close();
    if (startingChild?.exitCode === null) startingChild.kill('SIGTERM');
    if (startingDisplay?.process.exitCode === null) startingDisplay.process.kill('SIGTERM');
    await this.starting?.catch(() => {});
    await this.terminate(startingChild);
    await this.terminateDisplay(startingDisplay);
    await Promise.all([...this.pages.values()].map((page) => page.close().catch(() => {})));
    this.pages.clear(); this.cdp?.close(); const child = this.process; const display = this.display;
    this.process = undefined; this.display = undefined; this.cdp = undefined; this.control = undefined;
    await this.terminate(child);
    await this.terminateDisplay(display);
  }
  private async terminateDisplay(display?: VirtualDisplay) { if (!display) return; await this.terminate(display.process); try { unlinkSync(display.authorizationPath); } catch {} }
  private async terminate(child?: ChildProcess) {
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => { clearTimeout(force); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runBroker(profilePath: string): Promise<void> {
  const directory = runtimeDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); if (!ownedDirectory(directory)) fail('BROWSER_UNAVAILABLE', 'Broker runtime directory is not owner-controlled.'); const socket = brokerSocket(profilePath); const broker = new Broker(profilePath); let stopping = false;
  const server = net.createServer({ allowHalfOpen: true }, connection => { const peer = (connection as unknown as { getPeerCredentials?: () => { uid?: number } }).getPeerCredentials?.(); if (peer?.uid !== undefined && process.getuid && peer.uid !== process.getuid()) return connection.destroy(); let body = ''; let responseStarted = false; let clientGone = false; connection.setEncoding('utf8'); connection.on('error', () => {}); connection.on('close', () => { if (!responseStarted) clientGone = true; }); connection.on('data', chunk => { body += chunk; }); connection.on('end', async () => { let response: Response; try { const request = JSON.parse(body) as Request; if (request.operation === 'shutdown') { await shutdown(); response = { ok: true }; } else { const value = await broker.handle(request); if ((clientGone || connection.destroyed) && request.operation === 'open' && typeof value === 'string') await broker.discard(value); if (clientGone || connection.destroyed) return; response = { ok: true, value }; } } catch (error: any) { response = { ok: false, code: error?.code ?? 'INTERNAL_ERROR', message: error?.message ?? String(error) }; } responseStarted = true; connection.end(JSON.stringify(response)); }); });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => { if (stopping) return; stopping = true; await broker.close(); server.close(); try { unlinkSync(socket); } catch {} })();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { try { chmodSync(socket, 0o600); resolve(); } catch (error) { reject(error); } }); }); process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
}
export const brokerRequest = async (root: string, request: Request): Promise<any> => await new Promise((resolve, reject) => {
  const path = brokerSocket(root); try { const stat = lstatSync(path); if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) throw new Error('Broker socket is not owned by this OS user.'); } catch (error: any) { if (error.code !== 'ENOENT') return reject(error); }
  const socket = net.createConnection(path); let body = ''; let settled = false;
  const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timeout); socket.destroy(); error ? reject(error) : resolve(value); };
  // Submit can fall back from a 30s DOM evaluation to two 30s CDP key events. Its caller must
  // never time out while the broker can still perform that side effect.
  // ensure may cold-start Chrome, create/attach a target, navigate, and wait for readiness.
  // Its caller must outlive every bounded private-CDP operation in that startup path.
  const timeoutMs = request.operation === 'ensure' ? 180_000 : request.operation === 'submit' ? 95_000 : request.operation === 'open' || request.operation === 'shutdown' ? 90_000 : request.operation === 'fill' || request.operation === 'auth' ? 60_000 : 15_000;
  const timeout = setTimeout(() => finish(new Error('Broker RPC timed out.')), timeoutMs);
  socket.setEncoding('utf8'); socket.once('error', (error) => finish(error)); socket.on('data', chunk => { body += chunk; }); socket.on('end', () => { try { const response = JSON.parse(body) as Response; if (!response.ok) { const error: any = new Error(response.message); error.code = response.code; finish(error); } else finish(undefined, response.value); } catch (error: any) { finish(error); } }); socket.end(JSON.stringify(request));
});
