# Phase rf-3R — Review Diagnostics & Observability

## Goal
Review Phase rf-3 changes: verify health endpoint, diagnostics tool, and status bar are correct and non-intrusive.

## What to Inspect

### 1. `src/mcp/httpTransport.ts` — health endpoint
- [ ] `/health` path check BEFORE `/mcp` check (so both coexist)
- [ ] Only responds to GET requests
- [ ] Returns `Content-Type: application/json`
- [ ] Response includes `status`, `version`, `uptime`
- [ ] NOT accessible on any other path
- [ ] Does NOT consume body (no `readJsonBody` call)

### 2. `src/mcp/server.ts` — diagnostics tool
- [ ] Registered with `title: 'Diagnostics'` and `description`
- [ ] Has `inputSchema` with optional `sessionId`
- [ ] Wrapped with `safeHandler(`
- [ ] Calls `listSessions()` then `status()` safely
- [ ] `status()` call wrapped in try/catch (session may die)
- [ ] Returns `recommendations` array with actionable advice
- [ ] Covers 3 states: no session, running, stopped
- [ ] Includes server version, session list, thread info

### 3. `src/debug/dapBridge.ts` — getSessionCount export
- [ ] `getSessionCount()` function returns `sessionRegistry.size`
- [ ] Exported (not private)
- [ ] No side effects (doesn't modify registry)

### 4. `src/extension.ts` — status bar
- [ ] Status bar item created in `activate()`
- [ ] Pushed to `context.subscriptions`
- [ ] Updates on session events
- [ ] Icons: `debug-alt` (active) vs `debug-disconnect` (idle)
- [ ] Warning background for no-session state
- [ ] Click command `xdebug-mcp.showDiagnostics` registered
- [ ] `updateStatusBar()` uses `getSessionCount()`
- [ ] Initial call to `updateStatusBar()` at end of activate

### Verification
```bash
npm run check-types
npm run test
# Also check: does the health endpoint return before the /mcp routing?
# Manually verify: GET /health → 200, GET /mcp → MCP handshake
```

## Acceptance Criteria

- [ ] Health endpoint accessible at `/health`
- [ ] Diagnostics tool returns structured, actionable info
- [ ] Status bar item appears in VS Code window
- [ ] No regressions in existing functionality
- [ ] All tests pass, types clean
- [ ] Output `<promise>PHASE rf-3R REVIEWED — PASS</promise>` or `<promise>BLOCKED: reason</promise>`
