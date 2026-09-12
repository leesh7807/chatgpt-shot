export type ErrorCode =
  | 'CONFIG_INVALID' | 'NOTION_UNAVAILABLE' | 'NOTION_PARENT_PAGE_INVALID' | 'NOTION_PARENT_PAGE_INACCESSIBLE'
  | 'NOTION_INIT_FAILED' | 'NOTION_SCHEMA_INVALID' | 'INVOCATION_CREATE_FAILED' | 'BROWSER_UNAVAILABLE'
  | 'CHATGPT_AUTH_REQUIRED' | 'USER_INTERVENTION_REQUIRED' | 'SUBMISSION_FAILED' | 'SUBMISSION_UNCERTAIN'
  | 'ACKNOWLEDGMENT_TIMEOUT' | 'EXECUTION_TIMEOUT' | 'INVOCATION_FAILED' | 'INVALID_INVOCATION_STATE'
  | 'RESULT_READ_FAILED' | 'RESULT_SERIALIZATION_FAILED' | 'INVOCATION_CANCELLED' | 'INTERNAL_ERROR';

export class ShotError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly cause?: unknown) { super(message); }
}
export const STALE_BROWSER_SESSION_MESSAGE = 'Session with given id not found';
export const isStaleBrowserSessionError = (error: unknown): boolean => error instanceof Error && (error.message === STALE_BROWSER_SESSION_MESSAGE || error.message === `${STALE_BROWSER_SESSION_MESSAGE}.`);
const errorCodes = new Set<ErrorCode>(['CONFIG_INVALID', 'NOTION_UNAVAILABLE', 'NOTION_PARENT_PAGE_INVALID', 'NOTION_PARENT_PAGE_INACCESSIBLE', 'NOTION_INIT_FAILED', 'NOTION_SCHEMA_INVALID', 'INVOCATION_CREATE_FAILED', 'BROWSER_UNAVAILABLE', 'CHATGPT_AUTH_REQUIRED', 'USER_INTERVENTION_REQUIRED', 'SUBMISSION_FAILED', 'SUBMISSION_UNCERTAIN', 'ACKNOWLEDGMENT_TIMEOUT', 'EXECUTION_TIMEOUT', 'INVOCATION_FAILED', 'INVALID_INVOCATION_STATE', 'RESULT_READ_FAILED', 'RESULT_SERIALIZATION_FAILED', 'INVOCATION_CANCELLED', 'INTERNAL_ERROR']);
export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && errorCodes.has(value as ErrorCode);
export const fail = (code: ErrorCode, message: string, cause?: unknown): never => { throw new ShotError(code, message, cause); };
