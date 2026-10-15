# REVIEW_STEP_OUT_FIX_ROUND2 — Adversarial Fixes-Delta Gate

**Branch:** feat/native-xdebug-e2e-win · **Review mode:** READ-ONLY · **Scope:** fixes delta vs REVIEW_STEP_OUT_FIX.md (H1, M1–M5, L1–L6)

## VERDICT: GO-with-fixes

The fixes delta is implemented correctly and the unit/integration/live evidence is consistent with it.
One mandatory fix remains (F1): the top-level single-shot path can still issue a `stepOut` **after**
the 25 s overall deadline — the exact class of orphaned-step bug H1 was raised to eliminate. It is a
~5-line gate + one unit test. After F1 lands: **commit-ready**. Findings F2–F6 are low/informational.

---

## FINDINGS (ordered by severity)

### F1 [MEDIUM — must fix] Top-level single-shot path issues `stepOut` with no overall-deadline gate; baseline probe is never raced

- `src/debug/dapBridge.ts:808` — `const before = await stackForSession(...)` (baseline) is **not** raced against the deadline.
- `src/debug/dapBridge.ts:816-817` — `if (depthBefore <= 1) { await session.customRequest('stepOut', { threadId }); ... }` — no `overallDeadline` check before issuing the step.
- The real xdebug.php-debug adapter queues `stackTrace` while RUNNING and never throws `notStopped`
  (verified in `.vscode-test/extensions/xdebug.php-debug-1.40.2/out/xdebugConnection.js`: `_enqueue` executes
  immediately only when the queue is empty AND `_pendingCommands.size === 0`; the response handler drains one
  queued command per response).

Scenario: MCP client calls `step_out` while the debuggee is RUNNING at top level →
baseline `stackForSession` hangs (queued probe) → HTTP transport 408s at 30 s
(`src/mcp/httpTransport.ts:13,67`), client is gone → debuggee later stops (e.g. user
breakpoint) → the orphaned handler's baseline resolves with `depthBefore <= 1` →
**a `stepOut` is issued with no client attached**, resuming the session invisibly past
that breakpoint. A client that retries after the 408 (now encouraged by the id-echoed
408) adds a second handler → **double step**. The depth>1 loop path is safe (its gate at
`src/debug/dapBridge.ts:833-848` returns before stepping); only this path leaks.

This contradicts the documented contract:
- `src/mcp/server.ts:435-437` — "bounded by an overall deadline of about 25s, after which no further step commands are issued"
- `ARCHITECTURE.md:170-171` — "after the deadline no further `stepOut` commands are issued"

The new unit test `H1: slow baseline` (dapBridge.test.ts, ~line 910+) covers only the depth>1 case; the depth<=1 case is untested.

**Fix (concrete):** in the single-shot branch, gate before stepping and mirror the loop-gate shape:
```
if (depthBefore <= 1) {
  if (Date.now() >= overallDeadline) {
    return {
      exited: false, iterations: 0, frame: before[0], depthBefore,
      depthAfter: depthBefore,
      message: `step_out exceeded its overall deadline of ${overallTimeoutMs}ms before the function was exited; no further step commands were issued.`,
    };
  }
  await session.customRequest('stepOut', { threadId });
  ...
}
```
Add a unit test mirroring `H1: slow baseline` with a depth-1 stack, asserting `exited === false`, `iterations === 0`, and **0 stepOut calls**. Optionally (defense in depth) also race the baseline probe itself so the handler's lifetime is bounded even before the baseline resolves.

### F2 [LOW — optional hardening] `removeBreakpoints`/`addBreakpoints` unawaited in the bridge used by the L2 clear hooks

- `src/debug/dapBridge.ts:559-561` — `vscode.debug.removeBreakpoints(existing)` not awaited in `setFileBreakpoints`; same pattern at `src/debug/dapBridge.ts:607-609` and `631-633` (`setFunctionBreakpoints`).
- Consequence: the L2 hook (`src/test/suite/xdebugE2eNative.test.ts:190-192`, wired in `beforeEach` at 208-211 and `after` at 213-216) can resolve its MCP call before VS Code's breakpoint model fully propagates the removal.
- Current ordering makes this safe in practice: `clearAllMcpBreakpoints` runs while **no session is active** (each test starts its own session inside the `it` body, e.g. `xdebugE2eNative.test.ts:233`; `afterEach` stops the previous one at 218-228), and `startDebugSession()` takes >100 ms, giving the removal time to land. No flake observed (e2e 8/8 + live 9/9).
- Hardening: `await` the `vscode.debug.removeBreakpoints`/`addBreakpoints` calls so the guarantee is deterministic rather than timing-dependent. (Pre-existing pattern, but the L2 fix now relies on it.)

### F3 [INFO] Per-wait timeout message reports the clamped remainder, not the configured timeout

- `src/debug/dapBridge.ts:741,750` throw `` `Timed out waiting for step_out to complete after ${timeoutMs}ms.` `` where `timeoutMs` is the **clamped per-iteration remainder** (`src/debug/dapBridge.ts:846`). Near budget exhaustion this surfaces odd values (e.g. "after 800ms." asserted in `src/__tests__/dapBridge.test.ts:903`) while `STEP_OUT_STOP_TIMEOUT_MS` is 10000. Accurate per-wait, but potentially confusing to MCP clients. Cosmetic; optionally reword to mention the overall deadline.

### F4 [INFO] 408 response sent for notifications (id: null) deviates from JSON-RPC strictly

- `src/mcp/httpTransport.ts:36-51` — `handleRequestTimeout` writes a 408 with `id: null` when the request had no id. JSON-RPC says servers MUST NOT reply to notifications. Harmless in practice (SDK clients ignore unknown/null ids); a timeout on a notification is rare. Note also that the GET/SSE timeout path still destroys the stream (pre-existing `REQUEST_TIMEOUT_MS = 30_000` behavior at `src/mcp/httpTransport.ts:13,67`, unchanged by this fix — the `headersSent` guard at 38-39 is an improvement, not a regression).

### F5 [INFO] server.test.ts exited:false case doesn't assert `depthAfter` pass-through

- `src/__tests__/server.test.ts` (~1237-1249) — the second step_out test asserts success/exited/iterations/message but not `depthAfter` (the mock provides `depthAfter: 2`). M3's "both test files agree" is fully covered only in `src/__tests__/dapBridge.test.ts` (cap-exhaustion test asserts `depthAfter: 2`). One-line assertion would complete M3 coverage at the MCP boundary.

### F6 [INFO] Stale comment in e2e header

- `src/test/suite/xdebugE2eNative.test.ts:4` — "stopOnEntry halts it on line 1"; the actual entry stop is `test.php:7` (require_once), as the entry polls at 234/258/285/306/322/350/386 assert. Comment rot; trivial to fix in passing.

---

## FIXES-DELTA VERIFICATION (each finding from REVIEW_STEP_OUT_FIX.md)

### H1 — overall deadline, raced probes, 408 id echo — FIXED with one residual (F1)

- **(a) Late probe / interleaving.** `raceStackTraceProbe` (`src/debug/dapBridge.ts:696-717`) settles via `Promise.race`; a late-resolving `customRequest` is dropped (race already settled, handlers attached -> no unhandled rejection). At the adapter level the stale `stack_get` stays in `_pendingCommands` until the next stop response or connection close (then rejected `'connection closed (on close)'`, xdebugConnection.js close handler ~677-683); new tool-call commands queue behind it and drain one-per-response — a one-round-trip delay, no corruption, self-healing. The bridge mutates no shared state on the late resolution. Max ONE stale probe per `step_out` call (the `StepWaitTimeoutError` propagates out of `waitForStepStop` immediately at `src/debug/dapBridge.ts:748-751`). A retry's loop-path handler cannot double-step: its gate (`src/debug/dapBridge.ts:833-848`) returns without stepping once the deadline is past. The single-shot path is the exception — see F1.
- **(b) Request/response pairing.** DAP responses carry `request_seq`; VS Code's DebugSession matches by seq, not wire order — no mismatch, no bookkeeping corruption. Verified against the vscode-debugadapter Response contract and the adapter's transaction-id matching (xdebugConnection.js response handler matches on `transaction_id`).
- **(c) 25 s budget for the legitimate worst case.** Baseline (stopped session -> resolves in ms) + threads probe + 2 x ~10 s iterations = ~20 s + overhead < 25 s; a 3rd iteration clamps (`Math.min`, `src/debug/dapBridge.ts:846`) and its raced timer fires before the 30 s HTTP budget. Unit-covered by `H1: slow probes` (clamp to 800 ms, exactly 2 stepOuts, rejects at `src/__tests__/dapBridge.test.ts:903`) and `H1: slow baseline` (iterations: 0, 0 stepOuts). Robust.
- **(d) 408 id echo safety.** `extractJsonRpcId` (`src/mcp/httpTransport.ts:24-32`) returns `number | string | null`; `handleRequestTimeout` (`src/mcp/httpTransport.ts:36-51`) guards `headersSent`. `parsedBody` is declared `let parsedBody: unknown | undefined` at `src/mcp/httpTransport.ts:64` before the `req.setTimeout` registration at 67, and only assigned after `readJsonBody` for POST -> GET/SSE and slow-body timeouts produce `id: null` safely. Malformed-body 400/413 branch: the armed timer later fires with `headersSent === true` -> destroy-only no-op (pre-existing pattern). The echoed id is JSON-RPC-conformant for requests; see F4 for the notification nuance. Unit-covered (new describe in `src/__tests__/httpTransport.test.ts`).

### M1 — 'ended' only when session left the registry — FIXED

`src/debug/dapBridge.ts:763-771`: `!sessionRegistry.has(session.id)` -> `log.warn` + `'ended'`; otherwise rethrow. Both branches genuinely unit-tested: session-ended (registry cleared mid-call -> `exited: true`, message `'Debug session ended during step_out.'`) and transient-error-while-registered (rejects `'connection lost'`).

### M2 — depth INCREASE stops the loop — FIXED

`src/debug/dapBridge.ts:861-873`: compares `depthAfter` against the ORIGINAL `depthBefore` captured once at 809 (never the previous iteration's depth). Returns `exited: false` with `frame`/`depthBefore`/`depthAfter`/`message` naming the nested function — schema-consistent with every other return. Unit-tested (base 2 -> after 3, `iterations: 1`).

### M3 — cap exhaustion includes depthAfter — FIXED

Cap return at `src/debug/dapBridge.ts:881-890` derives `depthAfter` from `lastFrames`. `src/__tests__/dapBridge.test.ts` cap test asserts `depthAfter: 2`; `src/__tests__/server.test.ts` mock supplies `depthAfter: 2` and the handler passes it through unconditionally (`src/mcp/server.ts:453-459`) — though the server test doesn't assert it (F5).

### M4 — single-shot on depth <= 1, no {main} name check — FIXED

`src/debug/dapBridge.ts:816` uses only `depthBefore <= 1`; grep confirms zero `{main}` references remain in `src/debug/dapBridge.ts` and `src/mcp/server.ts`. Immediate-return message present (817-830). `src/mcp/server.ts:437-439` and `ARCHITECTURE.md:162-165` agree with the implementation. (The deadline caveat is F1.)

### M5 — two new unit tests — FIXED (real assertions)

Same-depth name change (greet->helper, depth 2->2 -> `exited: true`) and depth-1 non-`{main}` top-level frame -> single-shot (`iterations: 1`, message contains `'returned immediately without waiting for exit'`), both in `src/__tests__/dapBridge.test.ts`.

### L1 — pollUntilStopped verifies position via stack; 127.0.0.1 — FIXED

`src/test/suite/xdebugE2eNative.test.ts:74-105`: when `expectedLine`/`expectedFileSubstr` given, requires top frame line + file-substring match before returning (guards the stale-stop race); transient errors swallowed; explicit timeout error. All 17 call sites cross-checked against the real fixture lines (`src/test/fixtures/php-e2e/scripts/test.php`: require_once=7, $x=9, $y=10, add()=12, $x_plus_y=13, echo=14, greet()=17, echo=18, done=24; lib.php: add return=3, greet body=7): entry polls 7/'test.php' OK; T1 10 OK; T3 10->step_over->12 OK; T6 12->step_in->lib.php:3->step_out->13 OK; T7 greet->lib.php:7->step_out->18 OK. No position collision: no expected position ever equals the previous stop's position, so a stale `stopped:true` cannot falsely satisfy the check. `mcpRequest` hostname is `127.0.0.1` OK. No flake vector found.

### L2 — breakpoint-clear hooks — FIXED (see F2 hardening note)

`clearAllMcpBreakpoints` (`xdebugE2eNative.test.ts:190-192`) clears file + function breakpoints via empty arrays; `beforeEach` (208-211) and `after` (213-216) with 15 s timeouts. Verified the bridge path cannot throw with no active session: `setFileBreakpoints` (`src/debug/dapBridge.ts:551-598`) and `setFunctionBreakpoints` (606-634) never call `getSession` — they use `resolveFileUri` (which degrades via `getSessionIfAvailable`, `src/debug/dapBridge.ts:118-121`) and `vscode.debug.*` directly. Empty-array semantics: file map key deleted (594), function list replaced with `[]` after removing previous ones (607-609). Hook ordering (clear before the test starts its session; stop in `afterEach`) leaves no realistic race — the only residual is the unawaited model update (F2).

### L3 — description prose — FIXED

`src/mcp/server.ts:431-441` lists the success wrapper plus exited/iterations/frame/depthBefore/depthAfter/message, and documents message-with-`exited:true` (session ended / immediate top-level return). Accurate except the F1 overclaim.

### L4 — stackForSession extraction + threadId fallback 0->1 — FIXED, safe for all callers

`stepOut` resolves the session once (789) and passes it to `stackForSession` (808) — no double `getSession`. `stackForSession` fallback is now `options.threadId ?? 1` with the threads-probe catch also landing on 1 (~425/449), matching `resolveThreadId` (`src/debug/dapBridge.ts:664-675`). Audited every `dap.stack()` caller: `src/mcp/server.ts:335` (frame resolution for `scopes`), `677` and `704` (`wait_for_stop`) — all pass the schema `threadId` (optional positive int) or undefined; grep confirms no `threadId: 0` dependency anywhere in src or tests (only `startFrame: 0` usages, unrelated). The mock adapter supports `threads` (`src/test/fixtures/mockDebugAdapter.ts:100-101, 261-265`), so the fallback never fires in integration tests and real Xdebug always answers `threads`. No caller depended on 0.

### L5/L6 — mock stack shrink + integration assertions — FIXED, no leakage

`src/test/fixtures/mockDebugAdapter.ts:56` (`stepOutCount`), 273 (2-frame stack when `stepOutCount >= 1`), 431 (increment on `stepOut`), 458 (reset on `restart`). Leakage across tests: impossible — `createDebugAdapterDescriptor` returns `new DebugAdapterInlineImplementation(new MockDebugAdapter())` per session (`src/test/fixtures/mockDebugAdapter.ts:25`), and every mcpTools test starts a fresh session in its own `beforeEach` (`src/test/suite/mcpTools.test.ts:274, 436, 545, 688, 749, 882`). The step_out integration test (`src/test/suite/mcpTools.test.ts:602-612`) asserts `sc.exited === true && sc.iterations === 1` — a real regression guard (baseline 3 frames -> 2 frames -> early exit).

---

## WHOLE-DIFF SCAN — nothing new broke

- No unintended edits: diff confined to the 11 expected files + docs; no source edits beyond the planned areas.
- No `console.log` added to src (only the pre-existing logger fallback, `src/utils/logger.ts:37`); `log.warn` added correctly (`src/utils/logger.ts:48-56`) and used once (`src/debug/dapBridge.ts:765`).
- No dead constants: all five (`STEP_OUT_MAX_ITERATIONS`, `STEP_OUT_STOP_TIMEOUT_MS`, `STEP_OUT_POLL_MS`, `DEPTH_PROBE_LEVELS`, `STEP_OUT_OVERALL_TIMEOUT_MS`) are used.
- `log` import present in dapBridge.ts (line 3) and used.
- Comment rot only in the e2e header (F6).
- ARCHITECTURE.md and server.ts agree with the implementation on everything except the F1 overclaim (no-steps-after-deadline).

## TEST EVIDENCE CROSS-CHECK (trusted, not re-run)

check-types OK · unit 221/221 (+12) OK · compile:integration OK · live Xdebug hold 9 passing (step_in->step_out {exited:true,iterations:2,depthBefore:2,depthAfter:1}->test.php:13; greet fn-bp one step_out->test.php:18; {main} single-shot iterations:1) OK · full e2e 8 passing + 1 pending (hold self-skip) OK — all consistent with the code as reviewed.

## VERDICT

**GO-with-fixes.** Apply F1 (5-line gate + one unit test), then commit-ready. F2–F6 optional.
