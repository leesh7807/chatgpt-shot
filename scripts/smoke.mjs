#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceEnv = join(repositoryRoot, '.env');
const smokeRoot = join(repositoryRoot, '.smoke');
const xdg = {
  config: join(smokeRoot, 'config'),
  data: join(smokeRoot, 'data'),
  cache: join(smokeRoot, 'cache'),
};
const runtimeConfig = join(xdg.config, 'chatgpt-shot', '.env');
const discoveryPath = join(xdg.cache, 'chatgpt-shot', 'runtime.json');
const cliPath = join(repositoryRoot, 'dist', 'cli.js');
const browserProfilePath = join(xdg.data, 'chatgpt-shot', 'chrome-profile');
const singletonNames = new Set(['SingletonCookie', 'SingletonLock', 'SingletonSocket']);
const chromeCacheDirectoryNames = new Set([
  'Cache',
  'cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
  'ScriptCache',
  'optimization_guide_model_store',
  'optimization_guide_hint_cache_store',
  'component_crx_cache',
  'extensions_crx_cache',
  'AutofillAiModelCache',
]);
const isChromeCacheDirectory = name => chromeCacheDirectoryNames.has(name) || /cache/i.test(name);
const probe = 'This is a chatgpt-shot smoke probe. Reply with exactly: CHATGPT_SHOT_SMOKE_OK';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let secrets = [];

const redact = (value) => secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, String(value));
const messageOf = (error) => error instanceof Error ? error.message : String(error);

function requireRegularFile(path, label) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing at ${path}.`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file at ${path}.`);
}

function ensurePrivateDirectory(path) {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Smoke runtime path must be a real directory: ${path}.`);
  } else mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function lstatOrMissing(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function removeChildrenExcept(directory, preservedNames) {
  const info = lstatOrMissing(directory);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Smoke runtime path must be a real directory: ${directory}.`);
  for (const name of readdirSync(directory)) {
    if (!preservedNames.has(name)) rmSync(join(directory, name), { recursive: true, force: true });
  }
}

function pruneChromeProfile(profilePath) {
  const info = lstatOrMissing(profilePath);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Smoke browser profile must be a real directory: ${profilePath}.`);

  for (const name of singletonNames) {
    const path = join(profilePath, name);
    const entry = lstatOrMissing(path);
    if (!entry) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Unexpected Chrome singleton path: ${path}.`);
    unlinkSync(path);
  }

  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in retained smoke profile: ${path}.`);
      if (!entry.isDirectory()) continue;
      if (isChromeCacheDirectory(name)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      visit(path);
    }
  };
  visit(profilePath);
}

function assertNoChromeCaches(profilePath) {
  const info = lstatOrMissing(profilePath);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Smoke browser profile must be a real directory: ${profilePath}.`);
  for (const name of readdirSync(profilePath)) {
    const path = join(profilePath, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`Smoke transfer state contains a symbolic link: ${path}.`);
    if (!entry.isDirectory()) continue;
    if (isChromeCacheDirectory(name)) throw new Error(`Smoke transfer state still contains a Chrome cache directory: ${path}.`);
    assertNoChromeCaches(path);
  }
}

function assertNoSymlinks(directory) {
  const info = lstatOrMissing(directory);
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error(`Smoke transfer state contains a symbolic link: ${directory}.`);
  if (!info.isDirectory()) return;
  for (const name of readdirSync(directory)) assertNoSymlinks(join(directory, name));
}

function assertChromeProfileStopped() {
  const entries = [...singletonNames].map(name => ({ name, path: join(browserProfilePath, name), info: lstatOrMissing(join(browserProfilePath, name)) })).filter(entry => entry.info);
  if (!entries.length) return;
  const lock = entries.find(entry => entry.name === 'SingletonLock');
  if (!lock?.info.isSymbolicLink()) throw new Error(`Cannot verify that Chrome released the smoke profile at ${browserProfilePath}.`);
  const owner = readlinkSync(lock.path);
  const separator = owner.lastIndexOf('-');
  const ownerHost = separator > 0 ? owner.slice(0, separator) : '';
  const ownerPid = separator > 0 ? Number(owner.slice(separator + 1)) : NaN;
  if (ownerHost !== hostname() || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`Cannot verify the Chrome profile owner recorded at ${lock.path}.`);
  }
  try { process.kill(ownerPid, 0); }
  catch (error) {
    if (error?.code === 'ESRCH') return;
    throw new Error(`Cannot verify that Chrome stopped for smoke profile PID ${ownerPid}.`);
  }
  throw new Error(`Chrome process ${ownerPid} still owns the smoke profile.`);
}

function assertSmokeRuntimeStopped() {
  const runtimeEntries = [
    discoveryPath,
    join(xdg.cache, 'chatgpt-shot', 'service.lock'),
    join(xdg.cache, 'chatgpt-shot', 'manual-open.lock'),
    join(xdg.cache, 'chatgpt-shot', 'broker.sock'),
    join(xdg.cache, '.chatgpt.sock'),
  ];
  const active = runtimeEntries.find(path => lstatOrMissing(path));
  if (active) throw new Error(`Cannot clean the smoke transfer state while runtime data remains at ${active}.`);
  assertChromeProfileStopped();
}

function cleanSmokeTransferState() {
  assertSmokeRuntimeStopped();
  const configInfo = lstatOrMissing(runtimeConfig);
  if (configInfo && (!configInfo.isFile() || configInfo.isSymbolicLink())) throw new Error(`Retained smoke configuration must be a regular file: ${runtimeConfig}.`);
  removeChildrenExcept(xdg.config, new Set(['chatgpt-shot']));
  removeChildrenExcept(dirname(runtimeConfig), new Set(['.env']));
  removeChildrenExcept(xdg.data, new Set(['chatgpt-shot']));
  removeChildrenExcept(join(xdg.data, 'chatgpt-shot'), new Set(['chrome-profile']));
  pruneChromeProfile(browserProfilePath);
  rmSync(xdg.cache, { recursive: true, force: true });
  removeChildrenExcept(smokeRoot, new Set(['config', 'data']));
  for (const path of [smokeRoot, xdg.config, dirname(runtimeConfig), xdg.data, join(xdg.data, 'chatgpt-shot'), browserProfilePath]) {
    const info = lstatOrMissing(path);
    if (info?.isDirectory() && !info.isSymbolicLink()) chmodSync(path, 0o700);
  }
  if (configInfo) chmodSync(runtimeConfig, 0o600);
  assertNoChromeCaches(browserProfilePath);
  assertNoSymlinks(smokeRoot);
}

function prepareRuntime(sourceBytes) {
  ensurePrivateDirectory(smokeRoot);
  for (const path of Object.values(xdg)) ensurePrivateDirectory(path);
  ensurePrivateDirectory(dirname(runtimeConfig));
  const temporary = `${runtimeConfig}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, sourceBytes, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, runtimeConfig);
  chmodSync(runtimeConfig, 0o600);
  for (const path of [dirname(discoveryPath)]) ensurePrivateDirectory(path);
}

function childEnv() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_CACHE_HOME: xdg.cache,
  };
}

function run(executable, args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: repositoryRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function buildProductionCli() {
  const result = await run(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], process.env);
  if (result.code !== 0) {
    const detail = redact(result.stderr || result.stdout || `compiler exited with ${result.signal ?? result.code}`);
    throw new Error(`Production CLI build failed: ${detail.trim()}`);
  }
}

async function cli(...args) {
  return run(process.execPath, [cliPath, ...args], childEnv());
}

function failureDetail(result) {
  const output = redact(result.stderr.trim() || result.stdout.trim());
  return output || `process exited with ${result.signal ?? result.code}`;
}

function isAuthenticationFailure(result) {
  return result.code !== 0 && /(?:^|\n)CHATGPT_AUTH_REQUIRED:/.test(result.stderr);
}

async function submitProbe() {
  let submitted = await cli('submit', probe);
  if (isAuthenticationFailure(submitted)) {
    process.stdout.write('The retained smoke browser profile needs a manual ChatGPT sign-in. Sign in to the opened profile and close the browser to continue.\n');
    const opened = await cli('open');
    if (opened.code !== 0) throw new Error(`Could not open the retained smoke browser profile: ${failureDetail(opened)}`);
    submitted = await cli('submit', probe);
  }
  if (submitted.code !== 0) throw new Error(`Production submit failed: ${failureDetail(submitted)}`);
  const id = submitted.stdout.trim();
  if (!uuidPattern.test(id)) throw new Error('Production submit did not return one valid Job UUID.');
  return id;
}

async function readJob(id) {
  const result = await cli('jobs', id);
  if (result.code !== 0) throw new Error(`Production Job read failed: ${failureDetail(result)}`);
  let job;
  try { job = JSON.parse(result.stdout); }
  catch { throw new Error('Production Job read returned invalid JSON.'); }
  if (!job || job.id?.toLowerCase() !== id.toLowerCase() || !['in_progress', 'completed', 'failed'].includes(job.state)) {
    throw new Error('Production Job read did not return the submitted durable Job.');
  }
}

async function stopSmokeService() {
  if (!existsSync(discoveryPath)) return;
  process.stdout.write('Stopping the isolated smoke Service and draining accepted work.\n');
  const result = await cli('stop');
  if (result.code !== 0) throw new Error(`Could not stop the isolated smoke Service: ${failureDetail(result)}`);
}

async function main() {
  requireRegularFile(sourceEnv, 'Project root .env');
  const sourceBytes = readFileSync(sourceEnv);
  secrets = Object.values(dotenv.parse(sourceBytes)).filter(Boolean);
  let id;
  let failure;
  try {
    process.stdout.write('Building production CLI.\n');
    await buildProductionCli();
    process.stdout.write('Preparing isolated smoke runtime.\n');
    prepareRuntime(sourceBytes);
    process.stdout.write('Submitting smoke probe and waiting for remote acceptance.\n');
    id = await submitProbe();
    process.stdout.write('Remote acceptance confirmed; reading durable Job.\n');
    await readJob(id);
  } catch (error) {
    failure = error;
  }
  try {
    await stopSmokeService();
    cleanSmokeTransferState();
    process.stdout.write('Retained smoke configuration and browser profile are clean for transfer.\n');
  } catch (error) {
    const detail = id
      ? `Smoke Job ${id} was accepted and read back, but final cleanup failed: ${messageOf(error)}`
      : `Smoke cleanup failed: ${messageOf(error)}`;
    failure = failure ? new Error(`${messageOf(failure)}; ${detail}`) : new Error(detail);
  }
  if (failure) throw failure;
  process.stdout.write(`Smoke passed: production submission accepted and durable Job ${id} was read back.\n`);
}

main().catch(error => {
  process.stderr.write(`Smoke failed: ${redact(messageOf(error))}\n`);
  process.exitCode = 1;
});
