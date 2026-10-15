# Changelog

## Unreleased

## 0.2.0 — 2026-10-15

### Reliability & Resilience

- **Native MCP server registration fixed**: `McpHttpServerDefinition` was built with a single options object instead of VS Code's positional `(label, uri, headers, version)` signature, so VS Code rejected the definition ("Expected string, but got object") and the extension never registered its MCP server with VS Code's native MCP client. Registration now uses the stable typed API without `as any` casts, which also surfaced and fixed a latent `string`-vs-`vscode.Uri` bug (`e9ab826`).
- **`terminate` clears stale sessions**: `xdebug.php-debug` acknowledges `terminate` without promptly firing `terminated`, so sessions lingered in `list_sessions`; `terminate()` now polls for removal and falls back to `disconnect({ terminateDebuggee: true })` (`e9ab826`).
- **`step_out` exits the function in one call**: Xdebug's DBGp `step_out` stops first at the function's return line, leaving the session one hop inside the frame; `dapBridge` now runs a depth-based auto-repeat loop (cap 3) under one 25s deadline (inside the 30s HTTP budget) and returns a structured `{ exited, iterations, frame, depthBefore, depthAfter }` result (`1af3f73`).
- **Deterministic MCP teardown**: stopping the server (window reload, disable/enable, extension-host restart, quit) now releases the HTTP listener and the discovery file even while a client holds an SSE stream open. Previously `server.close()`'s callback never fired while a connection stayed open, so teardown hung and the port-file cleanup was unreachable. Teardown is now single-flight, bounded (~1.75s worst case), idempotent, and safe to call during an in-flight start (`3a88ee2`).
- **Per-window discovery**: every window publishes `~/.vscode-xdebug-mcp/port.<pid>.json` alongside the shared `port.json` pointer, and readers resolve the newest live entry, so a second window on a fallback port no longer erases the first from discovery (`68c6fb2`).
- **Output-channel disposal on deactivate**: the "Xdebug MCP" output channel is disposed after teardown settles; logging after deactivate falls back to the console instead of resurrecting a disposed channel, and re-activation re-arms cleanly (`b63a12c`).

### Testing

- **Port-file flake fix**: The MCP port file is now isolated per test fork, eliminating an EPERM rename race and the intermittent single-test failure it caused (`ac0b51d`).
- **E2E suites verified in a real VS Code instance**: The native CLI launch suite and the web/Apache session-identification suite (`npm run test:e2e:win`) pass in a real VS Code instance against real Xdebug (XAMPP PHP 8.2.12, Xdebug 3.5.3).

### Tooling

- **Biome formatter**: Adopted Biome (`@biomejs/biome` 2.5.5) as the project formatter, ending formatter-induced working-tree churn.
- **Repo cleanup**: Untracked agent state and ad-hoc working docs, and stopped packaging dev/agent tooling into the `.vsix` (`c29e7ed`).

---

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

### Test Coverage (149 → 199 tests)

- Resource handler tests: `xdebug://stack` and `xdebug://variables/{frameId}`
- `wait_for_stop` error propagation tests
- HTTP header normalization tests (Accept injection for POST/GET)
- `outputSchema` presence tests for `set_breakpoint` and `set_logpoint`
- Removed dead assignment in `dapBridge.test.ts`

---

## 0.0.3 — earlier

Initial release with MCP tools, DAP bridge, HTTP transport, and path mappings.
