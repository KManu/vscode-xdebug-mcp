/**
 * Shared debug error utilities used by both dapBridge and server modules.
 */

/**
 * Detects DAP "notStopped" errors from either error message or body.error.id.
 * Used by status() (dapBridge) and wait_for_stop polling (server).
 */
export function isNotStoppedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('notStopped')) {
    return true;
  }
  const errorWithBody = error as { body?: { error?: { id?: string } } };
  return errorWithBody?.body?.error?.id === 'notStopped';
}
