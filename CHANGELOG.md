# Changelog

## 0.1.0 — 2026-05-14

### Reliability & Resilience

- **Structured error responses**: All MCP tools now return `structuredContent: { success: false, error: "..." }` on failures instead of throwing raw exceptions. Errors are wrapped with a `safeHandler` that guarantees MCP clients always receive structured output.
- **Actionable notStopped messages**: Bridge functions (`stack`, `scopes`, `variables`, `evaluate`) now catch `notStopped` errors and return clear guidance: _"Debug session is not stopped. Call wait_for_stop... or pause..."_
- **`wait_for_stop` timeout**: Added `timeoutMs` parameter (default 30s). When Xdebug never connects, returns a structured timeout error instead of hanging indefinitely.
- **Request timeout**: HTTP request handler enforces a 30s timeout, returning a 408 JSON-RPC error to prevent slow clients from blocking the event loop.
- **Server death detection**: If the HTTP server crashes unexpectedly, state is automatically reset so the next `provideMcpServerDefinitions` call can restart cleanly.
- **EADDRINUSE retry guard**: Port binding retries capped at 3 attempts (default port → OS-assigned → give up) with a clear error message instead of an infinite loop.
- **OutputChannel logger**: All extension logging now writes to the VS Code Output panel ("Xdebug MCP" channel) with timestamps, falling back to `console` in test environments. Previously logged only to the hidden Developer Tools Console.

### Diagnostics & Observability

- **`GET /health` endpoint**: Lightweight health check returning `{ status, version, uptime }`. Useful for monitoring and probing server liveness.
- **`diagnostics` MCP tool**: Self-diagnostic tool for AI agents. Reports session count, stopped state, thread info, and actionable recommendations across 3 states (no session / running / stopped).
- **VS Code status bar indicator**: Shows `$(debug-alt) Xdebug MCP (N)` when debug sessions are active, or `$(debug-disconnect) Xdebug MCP` with a warning background when idle. Clicking it shows server version and session count.

### Code Quality

- **Extracted `isNotStoppedError`** to shared `src/debug/errors.ts` (was duplicated in `dapBridge.ts` and `server.ts`).
- **Narrowed `fileExists()` error handling**: Only catches `ENOENT`/`FileNotFound`; re-throws permission and I/O errors instead of silently treating them as "file not found."
- **`safeThreads()` logging**: Errors from DAP `threads` requests are now logged via the shared logger instead of being silently swallowed.
- **Normalized `restart()` signature**: Now takes `{ sessionId?: string }` options object, matching all other bridge functions.
- **Consolidated test mocks**: `src/__tests__/mockVscode.ts` is now used by all test files (was previously dead code). Added `src/__tests__/setup.ts` for global vitest setup.

### Test Coverage (149 → 170 tests)

- Resource handler tests: `xdebug://stack` and `xdebug://variables/{frameId}`
- `wait_for_stop` error propagation tests
- HTTP header normalization tests (Accept injection for POST/GET)
- `outputSchema` presence tests for `set_breakpoint` and `set_logpoint`
- Removed dead assignment in `dapBridge.test.ts`

---

## 0.0.3 — earlier

Initial release with MCP tools, DAP bridge, HTTP transport, and path mappings.
