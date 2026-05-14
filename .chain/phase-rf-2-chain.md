# Phase rf-2 — Timeouts & Server Resilience

## Goal
Add timeout protection, server death detection, and port binding robustness. Addresses 4 reliability gaps.

## Gaps Addressed
- **Gap 7** (3rd priority): `wait_for_stop` polls indefinitely with no timeout
- **Gap 2** (4th priority): Server dies silently after startup, stale URI served
- **Gap 8** (6th priority): No request timeout — slow clients can block event loop
- **Gap 1** (5th priority): Double EADDRINUSE infinite loop on port 0 failure

## Files to Modify

### 1. `src/mcp/server.ts` — wait_for_stop timeout (Gap 7)

Add `timeoutMs` parameter to `wait_for_stop`:

```typescript
server.registerTool('wait_for_stop', {
  /* ...existing schema... */,
  inputSchema: {
    sessionId: sessionIdSchema,
    threadId: z.number().int().positive().optional(),
    pollMs: z.number().int().positive().default(300),
    timeoutMs: z.number().int().positive().optional().default(30000)  // ← NEW
  }
}, safeHandler(async ({ sessionId, threadId, pollMs, timeoutMs }) => {
  const deadline = Date.now() + (timeoutMs ?? 30000);
  
  const poll = async () => {
    try {
      const frames = await dap.stack({ sessionId, threadId, startFrame: 0, levels: 1 });
      return frames[0];
    } catch (error) {
      if (isNotStoppedError(error)) {
        return undefined;
      }
      throw error;
    }
  };

  let frame = await poll();
  while (!frame) {
    if (Date.now() > deadline) {
      return errorResult(
        new Error(`Timed out waiting for debugger to stop after ${timeoutMs ?? 30000}ms. ` +
                  'Ensure Xdebug is configured, a PHP request was triggered, and a breakpoint is set.')
      );
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
    frame = await poll();
  }

  return structuredResult({ stopped: true, frame });
}));
```

### 2. `src/mcp/httpTransport.ts` — server death detection (Gap 2)

After `const httpServer = createServer(...)`, add:

```typescript
httpServer.on('close', () => {
  if (runningServer === httpServer) {
    console.log('[xdebug-mcp] HTTP server closed unexpectedly');
    runningServer = undefined;
    serverUriPromise = undefined;
  }
});
```

### 3. `src/mcp/httpTransport.ts` — request timeout (Gap 8)

Inside the `createServer` request handler, at the top:

```typescript
const REQUEST_TIMEOUT_MS = 30_000;
req.setTimeout(REQUEST_TIMEOUT_MS, () => {
  if (!res.headersSent) {
    res.statusCode = 408;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request timeout' },
      id: null
    }));
  }
  req.destroy();
});
```

### 4. `src/mcp/httpTransport.ts` — EADDRINUSE retry guard (Gap 1)

Replace the error handler at the port binding section:

```typescript
let portAttempts = 0;
const MAX_PORT_ATTEMPTS = 3;

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && portAttempts < MAX_PORT_ATTEMPTS) {
    portAttempts++;
    if (portAttempts >= MAX_PORT_ATTEMPTS) {
      serverUriPromise = undefined;
      runningServer = undefined;
      reject(new Error(`Failed to bind MCP server after ${MAX_PORT_ATTEMPTS} attempts. Port ${DEFAULT_PORT} and dynamic ports are all occupied.`));
      return;
    }
    const fallbackPort = portAttempts === 1 ? 0 : undefined;
    console.log(`[xdebug-mcp] Port ${DEFAULT_PORT} in use, falling back to dynamic port (attempt ${portAttempts}/${MAX_PORT_ATTEMPTS - 1})`);
    tryListen(fallbackPort ?? 0);
  } else {
    serverUriPromise = undefined;
    runningServer = undefined;
    reject(err);
  }
});
```

### 5. `src/mcp/httpTransport.ts` — timeout-related constant

Add near the top with other constants:

```typescript
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PORT_ATTEMPTS = 3;
```

## Acceptance Criteria

- [ ] `wait_for_stop` has `timeoutMs` parameter, defaults to 30000ms
- [ ] `wait_for_stop` returns `structuredContent: { success: false, error: "..." }` on timeout
- [ ] Error message explains Xdebug/breakpoint requirements
- [ ] Server `close` event resets `runningServer` and `serverUriPromise` if unintentional
- [ ] Server `error` event (non-EADDRINUSE after startup) resets state
- [ ] Request timeout of 30s sends 408 JSON-RPC error
- [ ] EADDRINUSE retries capped at 3 attempts, gives clear error message
- [ ] `npm run check-types` passes
- [ ] `npm run test` passes
- [ ] Output `<promise>PHASE rf-2 COMPLETE</promise>`
