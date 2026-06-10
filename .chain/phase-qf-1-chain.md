# Phase qf-1 — Code Fixes

## Goal
Fix 4 Warnings from the quorum review: extract shared `isNotStoppedError`, narrow `fileExists` error handling, log `safeThreads` errors, and normalize `restart()` signature.

## Files to Modify

### 1. CREATE `src/debug/errors.ts` (W1)
Extract `isNotStoppedError` into a shared utility module:

```typescript
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
```

### 2. EDIT `src/debug/dapBridge.ts` (W1)
- REMOVE the private `isNotStoppedError` function (lines 207-215)
- ADD `import { isNotStoppedError } from './errors';` at top
- Verify it's still used by `status()` and `listSessions` internally

### 3. EDIT `src/mcp/server.ts` (W1)
- REMOVE the private `isNotStoppedError` function (lines 26-34)
- ADD `import { isNotStoppedError } from '../debug/errors';` at top
- Verify it's still used by `wait_for_stop` handler

### 4. EDIT `src/debug/dapBridge.ts` — narrow `fileExists` catch (W2)
Change the `fileExists` function (lines 94-99):

```typescript
async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error: any) {
    // Only treat "file not found" as false; re-throw permission/IO errors.
    if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
```

### 5. EDIT `src/debug/dapBridge.ts` — log `safeThreads` errors (W3)
Change the `safeThreads` function (lines 217-222):

```typescript
async function safeThreads(session: vscode.DebugSession): Promise<ThreadInfo[]> {
  try {
    const response = (await session.customRequest('threads')) as { threads?: ThreadInfo[] };
    return Array.isArray(response?.threads) ? response.threads : [];
  } catch (error) {
    console.error(`[xdebug-mcp] Failed to get threads: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
```

### 6. EDIT `src/debug/dapBridge.ts` — normalize `restart()` (W7)
Change the `restart` function (line 343) to match other control functions:

```typescript
export async function restart(options: { sessionId?: string } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('restart');
}
```

### 7. EDIT `src/mcp/server.ts` — update `restart` tool handler
Update the `restart` tool registration to pass `{ sessionId }` as object:

```typescript
server.registerTool(
  'restart',
  {
    title: 'Restart',
    description: 'Restart the debug session',
    inputSchema: {
      sessionId: sessionIdSchema
    }
  },
  async ({ sessionId }): Promise<CallToolResult> => {
    await dap.restart({ sessionId });
    return okResult();
  }
);
```

## Acceptance Criteria

- [ ] `src/debug/errors.ts` exists with exported `isNotStoppedError`
- [ ] `dapBridge.ts` imports `isNotStoppedError` from `./errors`
- [ ] `server.ts` imports `isNotStoppedError` from `../debug/errors`
- [ ] No duplicate `isNotStoppedError` implementations remain
- [ ] `fileExists` only catches ENOENT/FileNotFound, re-throws others
- [ ] `safeThreads` logs errors to console.error
- [ ] `restart()` signature matches `{ sessionId?: string }` pattern
- [ ] `restart` tool in server.ts passes `{ sessionId }` object
- [ ] `npm run check-types` passes
- [ ] `npm run test` passes (all existing tests still green)
- [ ] Output `<promise>PHASE qf-1 COMPLETE</promise>`
