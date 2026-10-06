#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  await buildProductionCli();
  prepareRuntime(sourceBytes);

  let id;
  let failure;
  try {
    id = await submitProbe();
    await readJob(id);
  } catch (error) {
    failure = error;
  }
  try { await stopSmokeService(); }
  catch (error) { failure = failure ? new Error(`${messageOf(failure)}; cleanup failed: ${messageOf(error)}`) : error; }
  if (failure) throw failure;
  process.stdout.write(`Smoke passed: production submission accepted and durable Job ${id} was read back.\n`);
}

main().catch(error => {
  process.stderr.write(`Smoke failed: ${redact(messageOf(error))}\n`);
  process.exitCode = 1;
});
