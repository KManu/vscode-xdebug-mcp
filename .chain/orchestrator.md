# Ralph Chain Orchestrator — vscode-xdebug-mcp

## Overview

Two independent chains in sequence:
1. **Quorum Review Fixes** (qf-*) — Address findings from the 3-agent code review
2. **Reliability Improvements** (rf-*) — Harden MCP server against 12 failure scenarios

## Canonical Phase Order

| Phase | Key | Name | Spec | Summary |
|-------|-----|------|------|---------|
| **— Quorum Review Fixes —** |
| 0 | `qf-0` | Preliminary Checks | `.chain/phase-qf-0-chain.md` | Verify current state, 149 tests pass, types clean |
| 1 | `qf-1` | Code Fixes | `.chain/phase-qf-1-chain.md` | Extract isNotStoppedError, narrow fileExists catch, log safeThreads errors, normalize restart() |
| 1R | `qf-1R` | Review Code Fixes | `.chain/phase-qf-1R-chain.md` | Reviewer validates Phase 1 changes |
| 2 | `qf-2` | Dead Code Resolution | `.chain/phase-qf-2-chain.md` | Refactor tests to use shared mockVscode.ts (B1) |
| 2R | `qf-2R` | Review Dead Code Resolution | `.chain/phase-qf-2R-chain.md` | Reviewer validates Phase 2 changes |
| 3 | `qf-3` | Test Gap Coverage | `.chain/phase-qf-3-chain.md` | Add missing tests for resources, error propagation, header normalization |
| 3R | `qf-3R` | Review Test Coverage | `.chain/phase-qf-3R-chain.md` | Reviewer validates Phase 3 tests |
| 4 | `qf-4` | QF Integration Verification | `.chain/phase-qf-4-chain.md` | Full test suite, type check, compile, confirm all blockers/warnings resolved |
| **— Reliability Improvements —** |
| 5 | `rf-1` | Graceful Error Handling | `.chain/phase-rf-1-chain.md` | safeHandler wrapper on all tools + notStopped catch in bridge functions (Gap 4, 6) |
| 5R | `rf-1R` | Review Error Handling | `.chain/phase-rf-1R-chain.md` | Reviewer validates error-to-structuredResult conversion |
| 6 | `rf-2` | Timeouts & Server Resilience | `.chain/phase-rf-2-chain.md` | wait_for_stop timeout, server death detection, request timeout, EADDRINUSE guard (Gap 1, 2, 7, 8) |
| 6R | `rf-2R` | Review Resilience | `.chain/phase-rf-2R-chain.md` | Reviewer validates timeout and server recovery logic |
| 7 | `rf-3` | Diagnostics & Observability | `.chain/phase-rf-3-chain.md` | Health endpoint, diagnostics MCP tool, status bar indicator (Gap 3, 10, 11) |
| 7R | `rf-3R` | Review Diagnostics | `.chain/phase-rf-3R-chain.md` | Reviewer validates diagnostic endpoints and UX |
| 8 | `rf-4` | Reliability Integration | `.chain/phase-rf-4-chain.md` | Full test suite, type check, compile, verify all 10 reliability gaps addressed |

## Quorum Review Findings Addressed

### Phase qf-1 — Code Fixes
- **W1**: Extract `isNotStoppedError` to `src/debug/errors.ts`
- **W2**: Narrow `fileExists()` catch to ENOENT only
- **W3**: Log error in `safeThreads()` catch
- **W7**: Normalize `restart()` signature

### Phase qf-2 — Dead Code Resolution
- **B1**: `mockVscode.ts` (232 lines) unused — refactor tests to use shared mocks

### Phase qf-3 — Test Gap Coverage
- **W4**: Resource handler tests (`xdebug://stack`, `xdebug://variables/{frameId}`)
- **W5**: `wait_for_stop` error propagation test
- **W6**: HTTP header normalization tests
- **N7**: Remove dead assignment in `dapBridge.test.ts`
- **N10**: `outputSchema` presence tests

## Reliability Gaps Addressed

| Phase | Gaps | Impact | What Changes |
|-------|------|--------|-------------|
| rf-1 | Gap 4, 6 | **High** | `safeHandler` wrapper: all tools return `structuredContent` with `success: false` on errors. Bridge functions catch `notStopped` and throw actionable message |
| rf-2 | Gap 1, 2, 7, 8 | **Medium** | `wait_for_stop` timeout (30s default), server death detection via `close` handler, 30s request timeout, EADDRINUSE retry limit (3 attempts) |
| rf-3 | Gap 3, 10, 11 | **Low-Med** | `GET /health` endpoint, `diagnostics` MCP tool, VS Code status bar item |

### Full Gap Catalog (see `RELIABILITY.md`)

| # | Gap | Priority |
|---|-----|----------|
| 6 | `stack`/`scopes`/`variables` throw raw notStopped | 1st |
| 4 | Tools throw raw errors on no session | 2nd |
| 7 | `wait_for_stop` no timeout | 3rd |
| 2 | Server dies silently after startup | 4th |
| 1 | Double EADDRINUSE infinite loop | 5th |
| 8 | No request timeout | 6th |
| 3 | No health check endpoint | 7th |
| 11 | No diagnostics MCP tool | 8th |
| 10 | No status bar indicator | 9th |

### Deferred (from both reviews)

- N1-N6, N8-N9, N11 from quorum review
- Gap 5 (list_sessions empty vs no PHP ext — edge case)
- Gap 9 (concurrent requests — acceptable with per-request isolation)
