# Phase rf-4 — Reliability Integration Verification

## Goal
Run the full test suite after all reliability improvements. Verify all 9 reliability gaps are addressed and the codebase is stable.

## Tasks

### 1. Run all tests
```bash
npm run test
```
- All tests must pass (expect count stable or increased)
- No failing or skipped tests

### 2. Type check
```bash
npm run check-types
```
- Must pass cleanly

### 3. Compile
```bash
npm run compile
```
- Bundle must complete without errors

### 4. Verify all 9 reliability gaps are resolved

| # | Gap | Expected Behavior |
|---|-----|-------------------|
| 6 | Bridge notStopped errors | `stack`/`scopes`/`variables`/`evaluate` throw actionable message: "Call wait_for_stop... or pause..." |
| 4 | Tool error responses | ALL 21 tools return `structuredContent: { success: false, error: "..." }` on failure |
| 7 | wait_for_stop timeout | `timeoutMs` parameter, defaults 30s, returns errorResult on timeout |
| 2 | Server death detection | `httpServer.on('close')` resets `runningServer` + `serverUriPromise` |
| 1 | EADDRINUSE retry guard | Max 3 attempts, clear error message on final failure |
| 8 | Request timeout | 30s `req.setTimeout`, sends 408 JSON-RPC error |
| 3 | Health endpoint | `GET /health` → 200 `{"status":"ok","version":"...","uptime":...}` |
| 11 | Diagnostics tool | `diagnostics` MCP tool with session info + recommendations |
| 10 | Status bar | VS Code status bar shows session count, updates on session events |

### 5. Review key reliability invariants

- [ ] MCP client calling `stack` with no session → gets `structuredContent: { success: false, error: "No active debug session" }`
- [ ] MCP client calling `stack` while running → gets actionable error message about wait_for_stop
- [ ] `wait_for_stop` without Xdebug → times out after 30s with clear error
- [ ] HTTP server crashes → `serverUriPromise` resets, next provider call restarts
- [ ] Port conflict → retries once on port 0, then fails cleanly
- [ ] Client hangs → times out at 30s with 408
- [ ] `GET /health` → always returns 200 (doesn't depend on debug session)
- [ ] `diagnostics` tool → returns actionable recommendations in all 3 states
- [ ] Status bar → shows session count, updates on session lifecycle changes

### 6. Git diff summary
```bash
git diff --stat
```

## Acceptance Criteria

- [ ] `npm run test` passes, 0 failures
- [ ] `npm run check-types` passes clean
- [ ] `npm run compile` completes
- [ ] All 9 gaps verified ✅
- [ ] No regressions from quorum fixes (qf-1 through qf-4)
- [ ] Output `<promise>PHASE rf-4 COMPLETE</promise>`
- [ ] Output `<promise>ALL RELIABILITY PHASES COMPLETE</promise>`
