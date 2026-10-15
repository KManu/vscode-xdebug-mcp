# Code Review: step_out depth-based auto-repeat fix (PLAN_STEP_OUT_FIX.md Option A)

**Branch:** feat/native-xdebug-e2e-win · **Scope:** 7 files, +506/−9 · **Date:** review of uncommitted working tree
**Verification accepted as given:** 209 unit tests passing; live Xdebug verification (repros: `exited:true, iterations:2, depthBefore:2, depthAfter:1`; `{main}` single-shot ~10 ms); full e2e 8/8 passing.

## Verdict: **GO-with-fixes**

The design is sound, matches the plan, and is genuinely well tested (the 9 new unit tests exercise real branches, not call counts). However, **H1 is a real production bite that must be fixed before commit**: the step_out safety timeout is structurally ineffective against the actual Xdebug adapter, and exceeding the HTTP transport's 30 s budget leaves an orphaned DAP loop that keeps stepping the debug session after the client is gone. Fix is small and local to `src/debug/dapBridge.ts` (+ optionally `src/mcp/httpTransport.ts`). M1–M5 are recommended follow-ups.

---

## HIGH

### H1 — The 10 s per-iteration timeout cannot fire against the real Xdebug adapter; a never-stopping step_out hangs past the HTTP 30 s budget and leaves an orphaned loop that keeps stepping the session (state corruption)

**Mechanism (verified against the shipped adapter bundle, `.vscode-test/extensions/xdebug.php-debug-1.40.2/`):**

1. The real adapter never produces a `notStopped` error — a grep of the entire adapter bundle finds no `'notStopped'` string. Instead, `xdebugConnection.js` `_enqueue`/`_executeCommand` (~lines 698–742) write the command to the DBGp socket and leave the promise pending until Xdebug answers **at the next break**; the queue is drained only on each response (lines 669–674). `phpDebug.js` `stackTraceRequest` (769–830) performs no running-state check.
2. Therefore `waitForStepStop()`'s first `customRequest('stackTrace', …)` poll **blocks until the debuggee stops**. The deadline check at `src/debug/dapBridge.ts:684-686` is only evaluated *after* a caught `isNotStoppedError` — an error that the real adapter can never throw. If the debuggee never stops (infinite loop, no breakpoint, `ignore`-filtered breakpoint), the poll hangs indefinitely. The unit test "never stops → descriptive timeout error" (`dapBridge.test.ts`, fake timers + `stopTimeoutMs:1000`) models a fast-failing adapter that does not exist for Xdebug; against the real adapter the timeout path is dead code.
3. The only real guard becomes the HTTP layer: `src/mcp/httpTransport.ts:14` `REQUEST_TIMEOUT_MS = 30000`, `req.setTimeout(...)` at lines 23–35 emits a 408 with `id: null` and `req.destroy()`. The in-flight tool handler is **not cancelled**. When the debuggee eventually stops, the queued `stackTrace` resolves, `waitForStepStop` returns frames, and the loop **issues up to 3 more `stepOut` DAP commands** with the client long gone — the debug session spontaneously resumes and steps through code. A client retry then interleaves with the orphan loop → double-stepping.
4. Even the legitimate worst case overflows the budget: 3 iterations × `STEP_OUT_STOP_TIMEOUT_MS = 10000` (`dapBridge.ts:67`) = 30 s, *plus* the baseline `stack()` call, the `resolveThreadId` `threads` probe, and 150 ms poll overshoot — the 408 can fire mid-loop even when everything works, just slowly.

**Evidence lines:** `src/debug/dapBridge.ts:663-704` (poll loop, deadline only after notStopped), `src/debug/dapBridge.ts:684-686`, `src/mcp/httpTransport.ts:14, 23-35`; adapter: `xdebugConnection.js:669-674, 682-683, 698-742`; `phpDebug.js:769-830`.

**Suggested fix:**
- Introduce one overall deadline derived from the HTTP budget (e.g. `Date.now() + 25_000`) and clamp each iteration: `const iterBudget = Math.min(stopTimeoutMs, overallDeadline - Date.now())`; check the overall deadline at the top of each loop iteration.
- Race each stack probe against a timer so the loop's own timeout works against the real adapter: `Promise.race([customRequest('stackTrace', …), rejectAfter(remainingMs)])` (the late-resolving DAP response is simply dropped; no further stepOuts are issued after the race fires, so no stale command interleaves).
- In `httpTransport.ts`, include the original request id in the 408 JSON-RPC error (currently `id: null`) so clients can correlate instead of treating it as a transport failure and retrying into the orphaned loop.
- Optional: pass an AbortSignal from the HTTP request into the tool handler so the loop stops when the client disconnects. Note `safeHandler` (`server.ts:36-44`) already converts the loop's own timeout throw into a proper `errorResult` (success:false) — but only if HTTP hasn't killed the request first; closing that race is the point of the overall deadline.
- Mitigating note: when the script *completes* (rather than runs forever), the adapter's `close` handler rejects pending commands with `Error('connection closed (on close)')` (`xdebugConnection.js:682-683`), which correctly classifies as `'ended'` — so this hang is specifically the never-stops case, plus the slow-success budget overflow.

---

## MEDIUM

### M1 — `waitForStepStop` classifies any non-`notStopped` error as "session ended" → `exited: true`

`src/debug/dapBridge.ts:698-703`: every error other than `notStopped` returns `'ended'`, and `stepOut` turns that into `exited: true` + "Debug session ended during step_out." without ever verifying the session actually left `sessionRegistry`. A transient or unrelated protocol error from an alternate/future adapter would report a false `exited: true` while the session is alive and still inside the function.

**Fix:** before declaring `'ended'`, verify the session is gone (e.g. `!sessionRegistry.has(session.id)`); otherwise rethrow so the tool reports a real error. For the pinned Xdebug adapter the realistic close-path errors (`'connection closed (on close)'`, `'Unknown thread ID'`) do mean death, so this is robustness, not a today-bug.

### M2 — An inner breakpoint in a *nested* callee over-steps beyond the documented caveat

The loop compares against the original `depthBefore` but re-issues `stepOut` on whatever frame it lands in. If a breakpoint in a nested callee is hit mid-step, depth **increases**; `depthAfter < depthBefore` is false, so the loop re-steps — but the new `stepOut` exits the *nested* function, not the original one (`src/debug/dapBridge.ts:756-758, 764-770`). Combined with Xdebug's per-hop intermediate stop, three iterations can land the session in the grand-caller — well beyond what the tool description's "may step past it" caveat (`src/mcp/server.ts:433-437`) implies.

**Fix:** treat a depth *increase* as a stop condition: return `exited: false` with a message naming the nested stop ("stopped at a breakpoint inside a nested function"), rather than re-stepping.

### M3 — `depthAfter` omitted on cap exhaustion + mock drift between test files

The cap-exhausted return (`src/debug/dapBridge.ts:766-777`) omits `depthAfter` even though `lastFrames` holds a real depth — clients can't tell whether the session sits inside the function. The tests disagree on the contract: `server.test.ts:1234` mocks `exited: false` **with** `depthAfter: 2`, while `dapBridge.test.ts:673` asserts `depthAfter` is undefined. Pick one (recommend: always return it) and align both.

### M4 — `{main}` single-shot returns `exited: true` without verification, and the trigger condition is name-based at any depth

`src/debug/dapBridge.ts:730-735`: if `depthBefore <= 1` **or** the top frame name is `{main}`, the tool fires one `stepOut` and immediately returns `exited: true` with a stale `frame`, no wait. Two issues:
- DBGp `step_out` at top level behaves like `run` and **honors breakpoints** — the script need not run to completion; it can stop at a user breakpoint inside a called function while the result claims `exited: true`.
- The name-based condition fires on `{main}` at **any** depth (e.g. an included file's top-level scope), which contradicts ARCHITECTURE.md's "depth ≤ 1" description.

**Fix:** single-shot only when `depthBefore <= 1` (drop the name check), and soften the result — either omit `exited`, or add a message that the tool returned immediately and did not wait for exit.

### M5 — Two untested branches in the exit classification

The secondary name-change signal (`depthAfter === depthBefore && frameAfter.name !== topName`, `src/debug/dapBridge.ts:757-758`) has **no unit test**, and neither does `depthBefore <= 1` with a non-`{main}` top frame name. The other 9 tests genuinely exercise their branches (clean adapter, both repros, `{main}`, cap, session-end, timeout, recursion, thread auto-resolution — real assertions, not call-count mocks). Add two small tests. (On false-fire analysis for recursion: same-name recursion is handled by the primary depth signal, so the name-change branch fires only when the stop is genuinely in a different function at the same depth — defensible; no realistic false positive found.)

---

## LOW

### L1 — e2e `pollUntilStopped` stale-stop race; `localhost` vs `127.0.0.1` for MCP requests

`src/test/suite/xdebugE2eNative.test.ts` `pollUntilStopped` (lines 74–88) polls `status`; after `continue`/`step_in`, the first status call can land while the session is still stopped at the **old** location (the adapter answers `stackTrace` instantly until the resume is processed) → returns early → the subsequent stack-line assertion flakes. Pre-existing pattern, now amplified in Tests 6 & 7 by the extra step_in round trip. **Fix:** poll for the expected frame line, not just `stopped:true`. Also: `mcpRequest` uses `hostname: 'localhost'` (line ~31) while the server binds 127.0.0.1 — works today, but 127.0.0.1 is deterministic against IPv6 `::1` resolution; the Xdebug `debugConfig` already uses 127.0.0.1 correctly.

### L2 — Cross-test breakpoint persistence leftovers

Test 7 explicitly clears file breakpoints (`set_breakpoint(file, [])`) — good — but its **function breakpoint `greet` persists after the suite**, and Test 6's line-12 file breakpoint relies on Test 7's cleanup (MCP-layer `mcpFileBreakpoints` bookkeeping must stay in sync with VS Code). Add an `after()` that clears function breakpoints, or clear them at Test 7's start.

### L3 — Documentation drift in the tool description

`src/mcp/server.ts:433-437` lists `exited/iterations/depthBefore/depthAfter` but omits `frame`, `message`, and the `success` wrapper; it says "check the returned message field when exited is false" — but `message` also appears with `exited: true` on the session-ended path (`dapBridge.ts:748-749`). No tool declares an `outputSchema`, so the additive `structuredContent` fields are schema-safe for pi gateways and no fields were renamed; `success: true` is preserved on every path, and `exited: false` correctly arrives as `success: true` + message (plan §5.2). Just fix the prose.

### L4 — `resolveThreadId` fallback inconsistent with `stack()`

`resolveThreadId` (`dapBridge.ts:638-657`) falls back to threadId `1`, while `stack()` (`dapBridge.ts:406-420`) falls back to `0` — inconsistent for adapters without threads support. Also `stepOut` calls `getSession` twice (once directly at :723, once inside `stack()` at :728) with an `await` between; a session switch in that window would probe the wrong session. Micro; pass the resolved session down.

### L5 — `step_out` while the session is RUNNING hangs instead of erroring

With the real adapter the baseline `stack()` at `dapBridge.ts:727-728` **hangs** (queued command, per H1) rather than hitting the friendly notStopped error path at `:447-451` — the tool blocks until the next stop and *then* steps out. Surprising semantics; the H1 overall-deadline fix bounds it, but consider documenting the behavior.

### L6 — Mock-adapter integration test never exercises the loop's exit semantics

`mockDebugAdapter.ts` `handleStackTrace` (267–306) always returns the same 3-frame stack, so `mcpTools.test.ts:602-613`'s step_out runs 3 stepOuts, hits the cap, and asserts only `success:true` + `status.stopped` — it passes without ever proving the loop exits early. Plan §6.2's optional hardening (shrink the mock stack after each stepOut) would make the integration test assert real loop semantics; consider doing it.

---

## Positive findings

- **Return-shape change is safe:** the only caller of `dapBridge.stepOut` is `src/mcp/server.ts:444` (grep-verified; e2e/suite tests call raw `customRequest` or the MCP tool) — no hidden `void`-expectation callers.
- **`logger.warn`** (`src/utils/logger.ts:50-56`) correctly mirrors `info`/`error` and is used once, in `waitForStepStop` — sane.
- **Unit test quality is high:** the 9 new tests genuinely exercise each branch with real frame fixtures and fake timers; the timeout test uses `advanceTimersByTimeAsync` correctly; the cap test asserts both `exited:false` and the message text.
- **`'ended'` classification matches the real adapter's actual close-path errors** (`'connection closed (on close)'` at `xdebugConnection.js:682-683`, `'Unknown thread ID'` at `phpDebug.js:773`).
- **e2e Tests 6 & 7 assert the NEW structured field** (`structuredContent.exited === true`), not just success — as required.
- **ARCHITECTURE.md** is otherwise accurate against the implementation (constants, algorithm, message semantics) apart from the `{main}` wording noted in M4/L3.
