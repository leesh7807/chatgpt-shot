import { existsSync, mkdirSync, readFileSync, chmodSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { fail } from './errors.js';

export type Paths = { configDirectory: string; dataDirectory: string; runtimeDirectory: string; envPath: string; browserProfilePath: string; discoveryPath: string; lockPath: string };
export type Config = Paths & { notionToken: string; databaseUrl: string; acknowledgementMs: number; executionMs: number };
const xdg = (variable: 'XDG_CONFIG_HOME'|'XDG_DATA_HOME'|'XDG_CACHE_HOME', fallback: string) => process.env[variable]?.trim() || join(homedir(), fallback);
export function paths(): Paths {
  const configDirectory = join(xdg('XDG_CONFIG_HOME', '.config'), 'chatgpt-shot');
  const dataDirectory = join(xdg('XDG_DATA_HOME', '.local/share'), 'chatgpt-shot');
  const runtimeDirectory = join(xdg('XDG_CACHE_HOME', '.cache'), 'chatgpt-shot');
  for (const directory of [configDirectory, dataDirectory, runtimeDirectory]) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
  return { configDirectory, dataDirectory, runtimeDirectory, envPath: join(configDirectory, '.env'), browserProfilePath: join(dataDirectory, 'chrome-profile'), discoveryPath: join(runtimeDirectory, 'runtime.json'), lockPath: join(runtimeDirectory, 'service.lock') };
}
export function loadConfig(): Config {
  const state = paths(); const envPath = state.envPath;
  if (!existsSync(envPath)) fail('CONFIG_INVALID', `Missing user configuration at ${envPath}.`);
  const env = dotenv.parse(readFileSync(envPath));
  if (!env.NOTION_TOKEN?.trim()) fail('CONFIG_INVALID', 'NOTION_TOKEN is required in the chatgpt-shot user configuration.');
  if (!env.CHATGPT_SHOT_NOTION_DATABASE_URL?.trim()) fail('CONFIG_INVALID', 'CHATGPT_SHOT_NOTION_DATABASE_URL is required in the chatgpt-shot user configuration.');
  const timeout = (key: ConfigKey, fallback: number) => { const raw = env[key]?.trim(); if (!raw) return fallback; const value = Number(raw); const unlimited = key === 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS' && value === -1; if (!Number.isSafeInteger(value) || (value <= 0 && !unlimited)) fail('CONFIG_INVALID', `${key} must be a positive integer in milliseconds${key === 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS' ? ', or -1 for no local execution timeout.' : '.'}`); return value; };
  return { ...state, notionToken: env.NOTION_TOKEN, databaseUrl: env.CHATGPT_SHOT_NOTION_DATABASE_URL, acknowledgementMs: timeout('CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS', 45_000), executionMs: timeout('CHATGPT_SHOT_EXECUTION_TIMEOUT_MS', 30 * 60_000) };
}
export type ConfigKey = 'NOTION_TOKEN' | 'CHATGPT_SHOT_NOTION_DATABASE_URL' | 'CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS' | 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS';
const keys: ConfigKey[] = ['NOTION_TOKEN', 'CHATGPT_SHOT_NOTION_DATABASE_URL', 'CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS', 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS'];
const template = `# chatgpt-shot user configuration\n# Fill in the two required values below. Keep the value after each equals sign.\nNOTION_TOKEN=\nCHATGPT_SHOT_NOTION_DATABASE_URL=\n\n# Optional lifecycle limits, in milliseconds. Uncomment and adjust as needed.\n# CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS=45000\n# Execution defaults to 1800000 (30 minutes). Set to -1 to wait indefinitely; cancel manually.\n# CHATGPT_SHOT_EXECUTION_TIMEOUT_MS=1800000\n`;
export function ensureConfigFile(state = paths()): void {
  if (existsSync(state.envPath)) return;
  try { writeFileSync(state.envPath, template, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  chmodSync(state.envPath, 0o600);
}
export async function openConfigInDefaultEditor(state = paths()): Promise<void> {
  ensureConfigFile(state);
  const [command, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [state.envPath]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', state.envPath]] : ['xdg-open', [state.envPath]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export function readConfigValues(state = paths()): Partial<Record<ConfigKey, string>> {
  if (!existsSync(state.envPath)) return {};
  const parsed = dotenv.parse(readFileSync(state.envPath));
  return Object.fromEntries(keys.filter(key => parsed[key]?.trim()).map(key => [key, parsed[key].trim()])) as Partial<Record<ConfigKey, string>>;
}
export function setConfigValue(key: ConfigKey, value: string, state = paths()): void {
  if (!keys.includes(key)) fail('CONFIG_INVALID', `Unsupported configuration key ${key}.`);
  if (!value.trim()) fail('CONFIG_INVALID', `${key} cannot be empty.`); if (key === 'CHATGPT_SHOT_ACKNOWLEDGEMENT_TIMEOUT_MS' && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) fail('CONFIG_INVALID', `${key} must be a positive integer in milliseconds.`); if (key === 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS' && (!Number.isSafeInteger(Number(value)) || (Number(value) <= 0 && Number(value) !== -1))) fail('CONFIG_INVALID', 'CHATGPT_SHOT_EXECUTION_TIMEOUT_MS must be a positive integer in milliseconds, or -1 for no local execution timeout.');
  const values = { ...readConfigValues(state), [key]: value.trim() };
  const body = keys.filter(name => values[name]).map(name => `${name}=${JSON.stringify(values[name])}`).join('\n').concat('\n');
  const temporary = `${state.envPath}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, state.envPath); chmodSync(state.envPath, 0o600);
}
