# PLAN: Fix `step_out` Requiring Two Invocations Against Real Xdebug

Status: investigation complete — implementable as written.
Scope: read-only investigation deliverable. Implementation follows this plan exactly.

---

## 1. Bug summary

The MCP `step_out` tool requires **two** invocations to exit a function when talking to real
Xdebug (xdebug.php-debug adapter v1.40.2 + Xdebug 3.5.3, CLI launch config,
`runtimeExecutable: C:/xampp/php/php.exe`, `stopOnEntry: true`, breakpoint at the call site).

Verified live, twice:

- **Repro A** — stopped at `test.php:12` (`$result = add($x, $y);`), `step_in` → inside `add()`
  at `src/test/fixtures/php-e2e/scripts/lib.php:3` (`return $a + $b;`). First `step_out`
  returns `ok` but the session stays stopped at `lib.php:3` (20s of polling, never moves).
  A `step_over` at that return line exits to `test.php:13` in one call.
- **Repro B** — function breakpoint on `greet` → stopped at `lib.php:7`
  (`$prefix = "Hello, ";`). First `step_out` advances only to `lib.php:8` (the return line)
  and stays stopped. A **second** `step_out` completes the exit to `test.php:18`.

**Pattern:** the first `step_out` stops at the function's return statement (Xdebug's
intermediate stop); the next `step_out` (or a `step_over`) actually leaves the frame.

---

## 2. Root cause (file:line evidence)

### 2.1 Our MCP layer issues exactly one DAP `stepOut` and never waits for the stop

- MCP tool registration: `src/mcp/server.ts:427-441` — the `step_out` handler is
  `await dap.stepOut({ sessionId, threadId }); return okResult();`. It returns success the
  moment the DAP request round-trips; it never waits for the stopped event and never checks
  where execution landed.
- Bridge: `src/debug/dapBridge.ts:637-640` —
  `export async function stepOut(options = {}): Promise<void>` issues a single
  `session.customRequest('stepOut', { threadId: options.threadId ?? 1 })` and returns.
- The extension has no other step-looping logic anywhere (grep confirmed).

So one MCP `step_out` == one DAP `stepOut` == one DBGp `step_out`.

### 2.2 The adapter passes `step_out` through untouched — one DBGp command per DAP request

`.vscode-test/extensions/xdebug.php-debug-1.40.2/out/phpDebug.js`:

- `stepOutRequest(response, args)` at **phpDebug.js:1150-1170**: gets the connection by
  threadId, **sends the DAP response immediately** (phpDebug.js:1156), then
  `const xdebugResponse = await connection.sendStepOutCommand(); await this._checkStatus(xdebugResponse);`
  — exactly ONE DBGp `step_out`, no repetition, no post-stop inspection.
  Identical one-shot shape for `nextRequest` (phpDebug.js:1109-1125) and `stepInRequest`
  (phpDebug.js:1127-1147).
- DBGp layer: `xdebugConnection.js:865-879` — `sendStepOutCommand()` is just
  `new StatusResponse(await this._enqueueExecuteCommand('step_out'))` (xdebugConnection.js:877-879).

### 2.3 Xdebug's `step_out` stops first at the function's return line

Xdebug/DBGp `step_out` does not exit the scope in one hop: the first `step_out` runs to the
**last statement of the current function scope** — the return line — and breaks there; a
second `step_out` then leaves the frame and breaks in the caller. This is exactly what the
two live repros show:

- Repro A (already at `lib.php:3`, the return line): step_out #1 → breaks again at
  `lib.php:3` (no visible movement); step_out #2 → `test.php:13`.
- Repro B (at `lib.php:7`): step_out #1 → advances to the return line `lib.php:8`; step_out
  #2 → `test.php:18`.

### 2.4 Why the intermediate stop is surfaced instead of auto-continued

`_checkStatus(response)` at **phpDebug.js:548-630** handles the status coming back from the
step command:

- status `'break'` and `response.command.startsWith('step')` (phpDebug.js:591) → the adapter
  **only auto-repeats the step** when `this._args.skipFiles` is set AND the stopped file
  matches the skipFiles globs (`isPositiveMatchInGlobs(...)`, phpDebug.js:593-615) — i.e. the
  justMyCode/skipFiles filtering feature.
- Otherwise: `stoppedEventReason = 'step'` (phpDebug.js:616) and
  `new vscode.StoppedEvent(stoppedEventReason, connection.id, exceptionText)` with
  `allThreadsStopped: false` (phpDebug.js:626-628).

So in the normal case (no skipFiles), the intermediate return-line stop is surfaced to the
extension host as an ordinary DAP stopped event. The adapter never auto-continues.

### 2.5 What signals our extension can actually see

- **DAP stopped reason is NOT accessible.** VS Code's extension API exposes custom debug
  events only via `onDidReceiveDebugSessionCustomEvent`; the DAP `stopped` event (and its
  `reason: 'step' | 'breakpoint' | ...`) is consumed by VS Code internals. Our bridge
  therefore cannot distinguish "stopped at return line" from "stopped after exiting" by
  reason — only by polling state.
- **The only live signals via `customRequest('stackTrace')`** (`src/debug/dapBridge.ts:398-429`,
  mapped by the adapter at phpDebug.js:769-870) are:
  - `frames[].name` == Xdebug `where` attribute == function name; `'{main}'` at top level
    (xdebugConnection.js:330-348).
  - `frames[].line` (1-based).
  - `frames[].id` — a monotonically increasing counter per adapter (phpDebug.js:104), so a
    changed id means *a new stop happened*, but it says nothing about which frame we are in.
  - **Stack depth** = `frames.length` — Xdebug returns the full stack; the adapter slices it
    to `args.levels` (phpDebug.js:818), so requesting a large `levels` gives the true depth.
  - The DBGp frame `level` attribute is parsed by the adapter (xdebugConnection.js:340) but
    **not exposed over DAP** (phpDebug.js:864-868 returns only id/name/source/line/column).

---

## 3. Fix options

### Option A — Depth-based auto-repeat loop in `dapBridge.stepOut()`  **(RECOMMENDED)**

Before issuing the step, capture the current stack depth (`stackTrace` with a large
`levels`). Issue `stepOut`, wait for the stop (poll `stackTrace`, mirroring the existing
`wait_for_stop` loop at `src/mcp/server.ts:680-710`), and compare depth:

- depth **decreased** → the frame was exited → done.
- depth **unchanged** → still inside the same function (Xdebug's intermediate return-line
  stop) → issue `stepOut` again, bounded by a `maxIterations` cap.

`dapBridge.stepOut()` returns a small result object `{ exited, iterations, frame, ... }`
instead of `void`; the MCP `step_out` tool returns it as structured content.

- **Correctness:** high. Depth is the one signal that is unambiguous: a genuine exit always
  reduces depth by exactly 1, and this holds even when the caller has the **same name** as
  the callee (recursion) — the case that breaks any frame-name comparison.
- **Complexity:** low. ~60 lines in `dapBridge.ts` + a tiny server-side handler change.
- **Edge cases:** handled explicitly — `{main}` top frame (single shot, no loop), recursion
  (depth), generators (normal scope exit, depth still drops), already-at-return-line
  (depth unchanged on first stop → loop), deep stacks (see §7), inner breakpoints (see §7).
- **Portability:** if a future Xdebug/adapter fixes the quirk, the loop exits after
  iteration 1 (depth already decreased) — behavior degrades gracefully to today's.
- **How to detect "stopped at return line" reliably:** do NOT try to detect the return line
  itself (requires PHP source parsing). Detect the *exit* instead:
  `depthAfter < depthBefore`. The intermediate stop is simply "the stop where depth did not
  decrease". Secondary exit signal for adapter quirks: top-frame `name` changed at equal
  depth.

### Option B — Same loop, but implemented in the `step_out` MCP tool handler (`server.ts`)

Functionally identical loop, but living in `src/mcp/server.ts` instead of
`src/debug/dapBridge.ts`.

- Trade-offs: keeps the bridge "thin", but duplicates step/wait logic in the MCP layer,
  makes it unavailable to any other caller of `dapBridge.stepOut()`, and is harder to unit
  test with the existing `dapBridge.test.ts` harness (which mocks `customRequest` directly).
- Verdict: inferior placement of the same algorithm. Rejected in favor of A.

### Option C — Documentation-only: "step_out advances to function end; call again to exit"

Honest, zero engineering, zero risk.

- But it violates the tool's contract (name and schema say *step out*), breaks agent
  workflows that assume one call == one exit, and the second call is unnecessary friction
  for every MCP client. Rejected as the fix; the intermediate-stop behavior should still be
  *documented* in the tool description as part of Option A.

### Option D — `stepOut` then `next` (`step_over`) when stopped at the return line

Observed to work live: a `step_over` at the return line exits the frame in one call.
Could be used as the final iteration of the loop instead of a second `stepOut`.

- Trade-offs: adds a second command type (`next` has different semantics — from a
  non-return line it steps *one line*, not out) and buys nothing over a second `stepOut`
  (also proven to exit, Repro A). Mixing commands makes the loop state machine more complex
  for no gain. Rejected as primary; keep as a fallback if a future Xdebug changes
  `step_out` behavior (the loop would then need a different final hop).

### Trade-off summary

| Option | Correctness | Complexity | Risk | UX |
|---|---|---|---|---|
| A. depth loop in dapBridge | High | Low | Low (cap-bounded) | One call exits |
| B. depth loop in server.ts | High | Low-Med | Low | One call exits |
| C. docs-only | Honest, low | Zero | Zero | Two calls — poor |
| D. stepOut+next mix | Med-High | Med | Med (semantic mixing) | One call exits |

---

## 4. Recommended design (Option A)

### 4.1 Exit detection — why depth, and how to make it reliable

- **Primary signal:** `depthAfter < depthBefore`, where depth = `stackTrace(...,
  levels: DEPTH_PROBE_LEVELS).frames.length`. Robust for recursion (inner→outer with the
  same name still drops depth by 1), for the return-line intermediate stop (depth unchanged:
  `lib.php:3 → lib.php:3` in Repro A, `lib.php:7 → lib.php:8` in Repro B), and for closures.
- **Secondary signal:** top-frame `name` changed while depth is unchanged (covers exotic
  adapter frame remapping); treat as exited to avoid over-stepping.
- **Do NOT use:** frame line comparison (changes *within* the function on the intermediate
  stop — Repro B), frame id comparison (always changes per stop; phpDebug.js:104), or a
  cached "return lines" map (requires PHP parsing — rejected in §3).
- **Truncation caveat:** the adapter slices the stack to `args.levels` (phpDebug.js:818).
  Use `DEPTH_PROBE_LEVELS = 256` for the probes; real CLI scripts never approach this.
  Document the >256-frame recursion edge in §7.

### 4.2 Algorithm

New code in `src/debug/dapBridge.ts` (constants near the top of the file):

```ts
export interface StepOutResult {
  exited: boolean;
  iterations: number;
  frame?: StackFrame;      // top frame after the final stop (undefined if session ended)
  depthBefore: number;
  depthAfter?: number;     // undefined if session ended mid-step
  message?: string;        // set when exited === false
}

const STEP_OUT_MAX_ITERATIONS = 3;      // quirk needs 2; 3 gives margin
const STEP_OUT_STOP_TIMEOUT_MS = 10000; // per-iteration wait for the stop
const STEP_OUT_POLL_MS = 150;           // poll interval while waiting for the stop
const DEPTH_PROBE_LEVELS = 256;         // stackTrace depth for exit detection
```

Helpers:

```ts
// Extracted from the threadId auto-resolution already present in stack()
// (dapBridge.ts:406-420): options.threadId, else 'threads' request, else 1.
async function resolveThreadId(session: vscode.DebugSession, requested?: number): Promise<number>

// Mirrors the wait_for_stop poll loop (src/mcp/server.ts:680-710), but calls
// session.customRequest('stackTrace', { threadId, startFrame: 0, levels: DEPTH_PROBE_LEVELS })
// directly so it can observe depth and classify errors:
//   frames present                    -> return frames
//   isNotStoppedError(error)          -> keep polling until deadline, then throw
//                                        'Timed out waiting for step_out to complete after Nms.'
//   any OTHER error (unknown thread /  -> return 'ended'
//   terminated / disconnected session)
async function waitForStepStop(
  session: vscode.DebugSession,
  threadId: number,
  timeoutMs: number,
  pollMs: number
): Promise<StackFrame[] | 'ended'>
```

Rewrite `stepOut()` (replacing dapBridge.ts:637-640):

```ts
export async function stepOut(
  options: { sessionId?: string; threadId?: number; maxIterations?: number; stopTimeoutMs?: number } = {}
): Promise<StepOutResult> {
  const session = getSession(options.sessionId);
  const threadId = await resolveThreadId(session, options.threadId);
  const maxIterations = options.maxIterations ?? STEP_OUT_MAX_ITERATIONS;   // testability knobs,
  const stopTimeoutMs = options.stopTimeoutMs ?? STEP_OUT_STOP_TIMEOUT_MS;  // NOT exposed in the MCP schema

  const before = await stack({ sessionId: options.sessionId, threadId, startFrame: 0, levels: DEPTH_PROBE_LEVELS });
  const depthBefore = before.length;
  const topName = before[0]?.name;

  // Top-level frame ({main}): there is no caller to land on; step_out runs the
  // script to completion and the adapter fires ThreadEvent exited
  // (phpDebug.js:555-561). Single shot, no loop, no wait-for-stop.
  if (depthBefore <= 1 || (typeof topName === 'string' && /^\{main\}$/.test(topName))) {
    await session.customRequest('stepOut', { threadId });
    return { exited: true, iterations: 1, frame: before[0], depthBefore };
  }

  let lastFrames: StackFrame[] | 'ended' = before;
  for (let i = 1; i <= maxIterations; i++) {
    // Adapter responds to stepOut immediately (phpDebug.js:1156); the stopped
    // event arrives later, so polling afterwards is correct.
    await session.customRequest('stepOut', { threadId });
    lastFrames = await waitForStepStop(session, threadId, stopTimeoutMs, STEP_OUT_POLL_MS);

    if (lastFrames === 'ended') {
      return { exited: true, iterations: i, depthBefore, message: 'Debug session ended during step_out.' };
    }
    const depthAfter = lastFrames.length;
    const frameAfter = lastFrames[0];
    const exited =
      depthAfter < depthBefore ||                                                   // primary: frame exited
      (depthAfter === depthBefore && !!frameAfter && frameAfter.name !== topName);  // secondary: adapter quirk
    if (exited) {
      return { exited: true, iterations: i, frame: frameAfter, depthBefore, depthAfter };
    }
    // Xdebug intermediate stop: still at the function's return line (same depth). Loop.
  }

  return {
    exited: false,
    iterations: maxIterations,
    frame: Array.isArray(lastFrames) ? lastFrames[0] : undefined,
    depthBefore,
    message: `step_out did not leave the function after ${maxIterations} attempts; ` +
      'the debugger may be stopped at a breakpoint inside the function.',
  };
}
```

### 4.3 Edge cases and how the algorithm handles them

| Case | Behavior |
|---|---|
| Already at the return line (Repro A: `lib.php:3` → `lib.php:3`) | Depth unchanged → loop → second `stepOut` exits. `iterations: 2`. |
| Mid-function (Repro B: `lib.php:7` → `lib.php:8` → exit) | Depth unchanged after stop #1 → loop → exits after stop #2. `iterations: 2`. |
| `{main}` top frame / depth 1 | Single `stepOut`, no wait-for-stop; script runs to end; adapter closes connection + ThreadEvent exited (phpDebug.js:555-561). Return `exited: true`. If a given Xdebug build errors on `step_out` from `{main}`, `safeHandler` (server.ts:36-44) converts it to an `errorResult` — acceptable. |
| Recursion (`add` → `add`) | Depth drops by 1 on exit even though `frames[0].name` is unchanged — primary depth check exits after 1 iteration; no spurious second step. |
| Generators | `step_out` of a generator frame is a normal scope exit; depth check works. |
| Closure/eval frames | Depth drops on exit; secondary name-change check covers depth-neutral remapping quirks. |
| Inner user breakpoint hit during the step | Xdebug honors breakpoints mid-step → stop inside the same function, depth unchanged → the loop issues another `stepOut`, passing the breakpoint. Bounded by `maxIterations`; documented in the tool description (§7, Risk 1). |
| Script ends mid-loop (not from `{main}`) | `waitForStepStop` classifies non-notStopped errors as `'ended'` → returns `exited: true`. |
| Adapter without the quirk (future fix, other adapters) | First stop already has lower depth → loop exits after 1 iteration. Only added cost: one extra baseline `stackTrace`. |
| Deep recursion > `DEPTH_PROBE_LEVELS` | Both probes truncated to 256 → depth looks unchanged → loop may over-step by one frame (exits two frames). Rare; bounded by cap; mitigated in §7 Risk 2. |

---

## 5. Implementation steps (in order)

1. **`src/debug/dapBridge.ts`**
   - Add `StepOutResult` interface + the four constants (§4.2).
   - Add `resolveThreadId(session, requested?)` by extracting the logic from
     `stack()` at dapBridge.ts:406-420 (threads request → first id → fallback 1).
   - Add `waitForStepStop(session, threadId, timeoutMs, pollMs)` per §4.2, using
     `isNotStoppedError` from `src/debug/errors.ts:9-20` for the keep-polling branch and
     `log.warn` (logger imported at dapBridge.ts:3) for the `'ended'` classification.
   - Replace the body of `stepOut()` (dapBridge.ts:637-640) with the loop from §4.2.
     Keep the function name and options shape source-compatible; the return type changes
     from `Promise<void>` to `Promise<StepOutResult>` (callers: only `server.ts`, checked).
2. **`src/mcp/server.ts` — `step_out` handler (server.ts:427-441)**
   - Update the tool `description` (server.ts:431) to state the auto-repeat behavior and
     the inner-breakpoint caveat.
   - Change the handler to:
     ```ts
     const result = await dap.stepOut({ sessionId, threadId });
     return structuredResult({
       exited: result.exited,
       iterations: result.iterations,
       frame: result.frame,
       depthBefore: result.depthBefore,
       depthAfter: result.depthAfter,
       ...(result.message ? { message: result.message } : {}),
     });
     ```
     `structuredResult()` (server.ts:18-25) already injects `success: true`, so existing
     success-contract assertions keep passing. Keep `exited: false` as `success: true` with
     a `message` (the command executed; the data tells the agent it did not exit).
   - Do **not** add `maxIterations`/`stopTimeoutMs` to the MCP input schema — they remain
     internal/testability knobs on the bridge function.
3. **`npm run check-types`** — catch all compile sites of the new return type.
4. **Update `src/__tests__/server.test.ts`** (see §6.2) and add the new unit tests in
   **`src/__tests__/dapBridge.test.ts`** (§6.1).
5. **`npm run test`** — full vitest suite (171+ tests) green.
6. **Manual live verification** against real Xdebug (§6.3) — both repros.
7. **Add the permanent e2e regression tests** to
   `src/test/suite/xdebugE2eNative.test.ts` (§6.4) and run `npm run test:e2e:win`.
8. **Docs sync:** update the `step_out` row of the Execution Control table in
   `ARCHITECTURE.md` (line 144 area) and the execution-control prose to describe the
   depth-based auto-repeat loop and the Xdebug intermediate-stop quirk.

---

## 6. Test plan

### 6.1 Unit tests — `src/__tests__/dapBridge.test.ts` (vitest, mocked DAP)

Follow the existing pattern: build a mock session with
`createMockDebugSession` (`src/__tests__/mockVscode.ts`), override
`customRequest: vi.fn().mockImplementation(...)` with a scripted queue per test, register
with `dapBridge.__addSessionForTesting(session)`, set `vscode.debug.activeDebugSession`.
Pass `threadId` explicitly in most tests to skip the `threads` probe; add one test for
auto-resolution. Frame shapes: `{ id, name, line, source: { path } }` (StackFrame interface,
dapBridge.ts:8-13). Use the `stopTimeoutMs`/`maxIterations` knobs + `vi.useFakeTimers()`
where timing matters.

1. **Clean adapter (regression guard):** baseline 2 frames; after 1 stepOut, 1 frame →
   `customRequest` called with `'stepOut'` exactly once; result `{ exited: true,
   iterations: 1, depthBefore: 2, depthAfter: 1 }`.
2. **Xdebug quirk (Repro A — already at return line):** baseline 2 frames; after stepOut #1
   still 2 frames (same name, same line); after stepOut #2, 1 frame → 2 `stepOut` calls;
   `{ exited: true, iterations: 2 }`.
3. **Xdebug quirk (Repro B — mid-function):** baseline 2 frames; after #1 2 frames (same
   name, line moved 7→8); after #2 1 frame → 2 calls, `exited: true`.
4. **`{main}` single shot:** baseline 1 frame named `'{main}'` → exactly 1 `stepOut` call,
   no `stackTrace` call after the step; `{ exited: true, iterations: 1 }`.
5. **Cap exceeded:** every stop returns 2 frames → exactly `maxIterations` (3) `stepOut`
   calls; `{ exited: false, message }` set; last frame returned.
6. **Session ends during the wait:** after `stepOut`, `stackTrace` rejects with
   `Error('unknown thread')` (not the notStopped shape) → `{ exited: true, message:
   'Debug session ended during step_out.' }`.
7. **Never stops → timeout:** `stackTrace` keeps rejecting with the `notStopped`-shaped
   error (see `src/debug/errors.ts:9-20`); fake timers advance past `stopTimeoutMs` → throws
   the descriptive timeout error (surfaces as `errorResult` via `safeHandler`,
   server.ts:36-44).
8. **Recursion (key regression):** baseline 3 frames `[add(lib.php:5), add(test.php:12),
   {main}]`; after 1 stepOut, 2 frames `[add(test.php:13), {main}]` (top name UNCHANGED
   `'add'`) → **1** `stepOut` call, `exited: true` (depth 3→2 beats the name check).
9. **Thread auto-resolution:** no `threadId` passed; queue `'threads' → [{id: 7}]`; assert
   subsequent `'stepOut'`/`'stackTrace'` calls carry `threadId: 7`.

### 6.2 Existing-test impact

- **`src/__tests__/server.test.ts`** — the `vi.mock('../debug/dapBridge', ...)` block at
  lines 6-26 declares `stepOut: vi.fn().mockResolvedValue(undefined)`; update to
  `mockResolvedValue({ exited: true, iterations: 1, frame: {...}, depthBefore: 2,
  depthAfter: 1 })`. The `step_out` tool test at server.test.ts:1202-1212 currently asserts
  `structuredContent.success === true` — still passes; extend it to assert the new fields.
  Add a second case where the mock returns `{ exited: false, ... message }` and assert
  `success: true` + `message` presence (documents the contract).
- **`src/test/suite/mcpTools.test.ts:602-612`** ('step_out: mock fires stopped...') — the
  mock adapter's `handleStackTrace` returns a FIXED 3-frame stack that never changes
  (`src/test/fixtures/mockDebugAdapter.ts:267-306`), so the new loop will issue up to
  `maxIterations` (3) `stepOut` customRequests and report `exited: false`. The test asserts
  `success: true` and `status.stopped === true` — both still hold (each mock `handleStep`
  at mockDebugAdapter.ts:402-407 fires a `stopped` event). Leave the test as-is; the logic
  coverage lives in §6.1. (Optional hardening: teach the mock adapter to shrink its stack
  after the 2nd stepOut — not required.)
- **`src/test/suite/dapBridge.test.ts:245-253`** ('stepOut returns success') — integration
  style against the mock adapter; same as above, still passes. Optionally assert the new
  `exited` field.

### 6.3 Live e2e verification (manual, temporary hold-test)

The repo has no checked-in hold-test harness (no `E2E_HOLD` env anywhere — grepped `src/`,
`scripts/`, `package.json`); the "proven" pattern from prior sessions was a manual one.
Recreate it as follows — the dev host *is* the hold: it stays running while you drive the
MCP server over HTTP.

**Setup**
1. `npm run compile` (build the extension bundle with the fix).
2. Open the repo in VS Code, press **F5** (Extension Development Host). The extension
   activates and starts the HTTP MCP server on `127.0.0.1:3098` (fallback: dynamic port on
   EADDRINUSE — confirm the actual port in the Output panel / extension log).
3. In the **dev host** window, create a launch config mirroring the proven native e2e config
   from `src/test/suite/xdebugE2eNative.test.ts` (~lines 125-137):
   ```json
   {
     "type": "php",
     "request": "launch",
     "name": "xdebug step_out manual",
     "port": 9003,
     "hostname": "127.0.0.1",
     "runtimeExecutable": "C:/xampp/php/php.exe",
     "program": "C:/Users/kobby/Dev/vscode-xdebug-mcp/src/test/fixtures/php-e2e/scripts/test.php",
     "env": { "XDEBUG_MODE": "debug", "XDEBUG_SESSION": "1" },
     "stopOnEntry": true
   }
   ```
   (No `pathMappings` needed: on Windows the Xdebug server paths are already local paths.
   Xdebug 3.5.3 must be active in `C:/xampp/php` and listening on port 9003.)
4. Start the debug session in the dev host (F5) — it stops on entry at the first line of
   `test.php`.
5. Bootstrap the MCP client over HTTP (any JSON-RPC client; curl examples below):

```bash
MCP=http://127.0.0.1:3098/mcp
CT='Content-Type: application/json'
curl -s -X POST $MCP -H "$CT" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-e2e","version":"0.0.1"}}}'
curl -s -X POST $MCP -H "$CT" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

Tool names/schemas (verified in `src/mcp/server.ts`): `set_breakpoint` (server.ts:494,
args `{ file, breakpoints: [{ line, ... }] }`), `set_function_breakpoints` (server.ts:595,
args `{ breakpoints: [{ name }] }`), `continue` (server.ts:364), `step_in` (server.ts:412),
`step_out` (server.ts:428), `stack` (server.ts:253), `status` (server.ts:170),
`wait_for_stop` (server.ts:668), `restart` (server.ts:444), `terminate` (server.ts:459).
Generic call helper:

```bash
call() { curl -s -X POST $MCP -H "$CT" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
```

Fixture facts (counted from the actual files — the inline "Line N" comments in `test.php`
are STALE/off-by-one; trust these numbers): `test.php:12` = `$result = add($x, $y);`,
`test.php:13` = next statement, `test.php:17` = `$greeting = greet($name);`,
`test.php:18` = echo; `lib.php:3` = `return $a + $b;` (end of `add`), `lib.php:7` =
`$prefix = "Hello, ";`, `lib.php:8` = `return $prefix . $name;` (end of `greet`).

**Verification A — Repro A, one-call exit from the return line**
1. `call set_breakpoint '{"file":"C:/Users/kobby/Dev/vscode-xdebug-mcp/src/test/fixtures/php-e2e/scripts/test.php","breakpoints":[{"line":12}]}'`
2. `call continue '{}'` → `call wait_for_stop '{}'` → expect top frame `test.php:12`.
3. `call step_in '{}'` → `call wait_for_stop '{}'` → expect top frame `lib.php:3`, name
   `add` (this is already the return line).
4. `call step_out '{}'` → **single call** must return `structuredContent.exited: true`
   (Xdebug quirk → expect `iterations: 2` internally).
5. `call stack '{}'` → top frame must be `test.php:13`, name no longer `add`
   (`'{main}'`). If it shows `lib.php:3`, the fix failed.

**Verification B — Repro B, one-call exit from mid-function**
1. `call set_function_breakpoints '{"breakpoints":[{"name":"greet"}]}'`
2. `call restart '{}'` (session re-launches, stops on entry) → `call continue '{}'` →
   `call wait_for_stop '{}'` → expect `lib.php:7`.
3. `call step_out '{}'` → single call, `exited: true`.
4. `call stack '{}'` → top frame `test.php:18`.

**Verification C — `{main}` single-shot**
1. `call set_breakpoint '{"file":".../test.php","breakpoints":[{"line":12}]}'` →
   `continue` → `wait_for_stop` (top frame `{main}` at `test.php:12`).
2. `call step_out '{}'` → returns `exited: true, iterations: 1`; the script runs to
   completion and the session disappears (poll `list_sessions`/`status` to confirm no
   session remains).

**Verification D — controls that must not regress**
- `step_over` from a return line still exits in one call (`step_over` tool, server.ts:396).
- `step_in`, `continue`, `evaluate_expr` behave as before (spot-check).
- `call terminate '{}'` at the end for cleanup.

### 6.4 Permanent e2e regression tests

Add to `src/test/suite/xdebugE2eNative.test.ts`, following the existing helper pattern
(`startDebugSession`, `toolCall(port, name, args)`, `pollUntilStopped(port, 60000, 200)`,
`initializeMcp` — same file, helpers near the top):

1. **`step_out exits the function in a single MCP call (return-line quirk)`** — start
   session; `set_breakpoint` `test.php:12`; `continue`; `pollUntilStopped`; `step_in`;
   `pollUntilStopped` (assert `lib.php:3`); `step_out` → assert `structuredContent.exited
   === true`; `pollUntilStopped`; `stack` → assert top frame `line === 13` and `name !==
   'add'`.
2. **`step_out exits greet() in a single MCP call (mid-function quirk)`** — start session;
   `set_function_breakpoints [{name:'greet'}]`; `continue`; `pollUntilStopped` (assert
   `lib.php:7`); `step_out` → assert `exited === true`; `pollUntilStopped`; `stack` →
   assert top frame `line === 18`.

Run with `npm run test:e2e:win` (pre-installs the xdebug.php-debug adapter into
`.vscode-test` via `scripts/setup-e2e-win.js`, then `compile:integration && compile &&
vscode-test` — package.json:35-36). Requires Xdebug 3.x active on port 9003 with
`C:/xampp/php/php.exe` (the native test's `debugConfig`).

---

## 7. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **Inner user breakpoint hit during the step** is auto-stepped past by the loop (depth unchanged → re-step). | User's breakpoint inside the function is skipped; they land in the caller. | Bounded by `maxIterations = 3`; document in the `step_out` tool description (step 2 of §5) and in `ARCHITECTURE.md`. If it matters later, the loop can stop early when the stopped line equals a known breakpoint (requires querying breakpoint state — out of scope now). |
| 2 | **Truncation at `DEPTH_PROBE_LEVELS = 256`** in extreme recursion masks a genuine exit (before/after both 256) → loop over-steps by one frame. | User exits two frames instead of one, in >256-deep recursion. | Rare (256-frame PHP stacks are pathological); bounded by cap; result includes `depthBefore`/`depthAfter` for diagnosis; raise the constant if ever needed. |
| 3 | **Loop issues extra commands against adapters that already exit correctly** (future Xdebug fix, alternate adapters). | One extra `stackTrace` baseline call; first stop passes the depth check, loop ends after 1 iteration. | By construction, the loop is a no-op in that case (test §6.1 #1). |
| 4 | **`{main}` handling differs across Xdebug builds** (some may error on top-level `step_out`). | Tool returns an error result for a `step_out` from `{main}`. | Acceptable — previously identical behavior (single pass-through); `safeHandler` (server.ts:36-44) shapes the error; documented in §4.3. |
| 5 | **Session ends mid-loop** (terminate, script completion) → `stackTrace` throws non-notStopped errors. | Loop errors out. | `waitForStepStop` classifies any non-notStopped error as `'ended'` → returns `exited: true` with an explanatory `message` (§4.2). |
| 6 | **Latency regression:** each `step_out` now includes a baseline `stackTrace` + per-iteration wait (poll 150ms, timeout 10s). | Normal case ~300ms extra (Xdebug stops in <100ms); worst case 10s when the debugger never stops. | Timeout caps the worst case; result object exposes `iterations` so callers can see the cost. |
| 7 | **Mock-based suites behave differently** (fixed 3-frame mock stack → loop hits cap, `exited: false`). | Confusing test output if assertions are tightened later. | §6.2 documents expected behavior; existing assertions unaffected; optional mock hardening noted. |
| 8 | **Cross-session pollution:** depth probes must use the same session as the step. | Wrong-session stack reads → wrong depth → over/under-stepping. | `stepOut()` passes `sessionId` through to both `stack()` calls and resolves `threadId` once, up front (§4.2). Unit test #9 covers thread resolution. |

---

## Appendix — key source references

- `src/mcp/server.ts:427-441` step_out tool; `:11-25` okResult/structuredResult; `:36-44`
  safeHandler; `:667-716` wait_for_stop (poll pattern to mirror).
- `src/debug/dapBridge.ts:398-429` stack(); `:406-420` threadId auto-resolution; `:621-645`
  cont/next/stepIn/stepOut/pause (stepOut at `:637-640`); `:50` sessionRegistry;
  `:323-335` getSession.
- `src/debug/errors.ts:9-20` isNotStoppedError.
- `.vscode-test/extensions/xdebug.php-debug-1.40.2/out/phpDebug.js:1150-1170` stepOutRequest;
  `:548-630` _checkStatus (skipFiles auto-repeat at `:593-615`, StoppedEvent at `:626-628`);
  `:769-870` stackTraceRequest (frame mapping `:864-868`, levels slice `:818`); `:104`
  monotonic frame ids.
- `.vscode-test/extensions/xdebug.php-debug-1.40.2/out/xdebugConnection.js:865-879`
  sendStepOutCommand; `:330-348` StackFrame (name = `where`; `'{main}'` top level).
- Fixtures: `src/test/fixtures/php-e2e/scripts/test.php` (call sites at lines 12 and 17;
  exits at 13 and 18) and `lib.php` (`add` return at line 3; `greet` return at line 8).
- Tests: `src/test/suite/xdebugE2eNative.test.ts` (native e2e pattern, debugConfig
  ~125-137), `src/test/suite/mcpTools.test.ts:602-612` (step_out mock test),
  `src/test/fixtures/mockDebugAdapter.ts:267-306` (fixed stackTrace),
  `:402-407` (handleStep), `src/__tests__/server.test.ts:6-26` (dapBridge mock),
  `:1202-1212` (step_out tool test), `src/__tests__/mockVscode.ts`
  (createMockDebugSession).
