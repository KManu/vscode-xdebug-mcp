# Phase rf-2R — Review Timeouts & Resilience

## Goal
Review Phase rf-2 changes: verify timeouts are correctly configured, server recovery works, and no regressions.

## What to Inspect

### 1. `src/mcp/server.ts` — wait_for_stop timeout
- [ ] `timeoutMs` in inputSchema with `z.number().int().positive().optional().default(30000)`
- [ ] `deadline` computed as `Date.now() + (timeoutMs ?? 30000)`
- [ ] Timeout check `if (Date.now() > deadline)` inside poll loop
- [ ] Timeout returns `errorResult(...)` with clear message
- [ ] Existing poll behavior unchanged for short waits

### 2. `src/mcp/httpTransport.ts` — server death detection
- [ ] `httpServer.on('close', ...)` handler added
- [ ] Handler checks `runningServer === httpServer` before resetting (not stale ref)
- [ ] Both `runningServer` and `serverUriPromise` reset to `undefined`
- [ ] Console.log message is clear

### 3. `src/mcp/httpTransport.ts` — request timeout
- [ ] `req.setTimeout(REQUEST_TIMEOUT_MS, ...)` in request handler
- [ ] Timeout sends proper 408 with JSON-RPC error shape
- [ ] Checks `!res.headersSent` before writing
- [ ] Calls `req.destroy()` after timeout
- [ ] `REQUEST_TIMEOUT_MS = 30_000` constant defined

### 4. `src/mcp/httpTransport.ts` — EADDRINUSE retry guard
- [ ] `portAttempts` counter initialized to 0
- [ ] `MAX_PORT_ATTEMPTS = 3` constant defined
- [ ] First fallback uses port 0
- [ ] After MAX_PORT_ATTEMPTS exceeded, rejects with clear error
- [ ] Both `runningServer` and `serverUriPromise` reset on final failure
- [ ] Non-EADDRINUSE errors still reset state (fixes quorum W4)

### Verification
```bash
npm run check-types
npm run test
git diff src/mcp/
```

## Acceptance Criteria

- [ ] All timeout paths have clear error messages
- [ ] Server state resets cleanly on unexpected close
- [ ] EADDRINUSE handles 3 attempts then fails gracefully
- [ ] Request timeout doesn't break existing transport tests
- [ ] All tests pass, types clean
- [ ] Output `<promise>PHASE rf-2R REVIEWED — PASS</promise>` or `<promise>BLOCKED: reason</promise>`
