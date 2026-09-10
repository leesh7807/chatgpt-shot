import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { fail } from './errors.js';

export type Paths = { configDirectory: string; dataDirectory: string; runtimeDirectory: string; envPath: string; browserProfilePath: string; discoveryPath: string; lockPath: string };
export type Config = Paths & { notionToken: string; databaseUrl: string };
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
  return { ...state, notionToken: env.NOTION_TOKEN, databaseUrl: env.CHATGPT_SHOT_NOTION_DATABASE_URL };
}
