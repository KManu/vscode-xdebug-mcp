# Phase rf-1 — Graceful Error Handling

## Goal
Ensure ALL MCP tools return `structuredContent` even on errors, and bridge functions provide actionable messages when the debugger isn't stopped. This addresses the top 2 reliability gaps.

## Gaps Addressed
- **Gap 6** (1st priority): `stack`/`scopes`/`variables`/`evaluate` throw raw `notStopped` errors
- **Gap 4** (2nd priority): Tools throw raw errors on "no session" — no structuredContent

## Files to Modify

### 1. ADD `safeHandler` wrapper to `src/mcp/server.ts`

Add this function near the top of `makeServer()`:

```typescript
function errorResult(error: unknown): CallToolResult & { structuredContent: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { success: false, error: message }
  };
}

// Higher-order wrapper that catches errors and converts them to structured error results.
function safeHandler<T extends any[]>(
  fn: (...args: T) => Promise<CallToolResult & { structuredContent: unknown }>
): (...args: T) => Promise<CallToolResult & { structuredContent: unknown }> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}
```

### 2. WRAP all 18 MCP tool handlers with `safeHandler`

For EVERY `server.registerTool(...)` call, wrap the handler:
```typescript
// Before:
async ({ sessionId, ... }) => { ... }

// After:
safeHandler(async ({ sessionId, ... }) => { ... })
```

This covers: `list_sessions`, `status`, `threads`, `stack`, `scopes`, `variables`, `snapshot`, `continue`, `pause`, `step_over`, `step_in`, `step_out`, `restart`, `terminate`, `disconnect`, `set_breakpoint`, `set_logpoint`, `clear_breakpoints`, `set_function_breakpoints`, `set_exception_breakpoints`, `evaluate_expr`, `wait_for_stop`, `list_resource_templates`.

**Important:** Do NOT wrap `list_resource_templates` or void-returning resource handlers — those are already safe.

### 3. ADD notStopped error wrapping in `src/debug/dapBridge.ts`

Import `isNotStoppedError` (already extracted in qf-1). Add try/catch with actionable messages to 4 functions:

**`stack()`:**
```typescript
export async function stack(options = {}): Promise<StackFrame[]> {
  const session = getSession(options.sessionId);
  try {
    const response = await session.customRequest('stackTrace', { /* ... */ });
    return Array.isArray(response?.stackFrames) ? response.stackFrames : [];
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error('Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.');
    }
    throw error;
  }
}
```

**`scopes()`:**
```typescript
export async function scopes(frameId: number, sessionId?: string): Promise<Scope[]> {
  const session = getSession(sessionId);
  try {
    const response = await session.customRequest('scopes', { frameId });
    return Array.isArray(response?.scopes) ? response.scopes : [];
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error('Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.');
    }
    throw error;
  }
}
```

**`variables()`:**
```typescript
export async function variables(options: { /* ... */ }): Promise<Variable[]> {
  const session = getSession(options.sessionId);
  try {
    const response = await session.customRequest('variables', { /* ... */ });
    return Array.isArray(response?.variables) ? response.variables : [];
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error('Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.');
    }
    throw error;
  }
}
```

**`evaluate()`:**
```typescript
export async function evaluate(options: { /* ... */ }): Promise<EvaluateResult> {
  const session = getSession(options.sessionId);
  try {
    return await session.customRequest('evaluate', { /* ... */ }) as EvaluateResult;
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error('Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.');
    }
    throw error;
  }
}
```

## Acceptance Criteria

- [ ] `safeHandler` and `errorResult` functions exist in server.ts
- [ ] All 20+ `server.registerTool()` handlers wrapped with `safeHandler`
- [ ] `stack()` in dapBridge.ts catches notStopped with actionable message
- [ ] `scopes()` in dapBridge.ts catches notStopped with actionable message
- [ ] `variables()` in dapBridge.ts catches notStopped with actionable message
- [ ] `evaluate()` in dapBridge.ts catches notStopped with actionable message
- [ ] All error messages include guidance ("Call wait_for_stop..." / "or pause...")
- [ ] `npm run check-types` passes
- [ ] `npm run test` passes (existing tests: all tools still return structuredContent, error paths now return errorResult)
- [ ] Output `<promise>PHASE rf-1 COMPLETE</promise>`
