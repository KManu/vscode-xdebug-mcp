# Phase 2c — server wait_for_stop and snapshot Tests

## Goal
Test the `wait_for_stop` polling loop and `snapshot` aggregation in `src/mcp/server.ts`.

## What to Test

### wait_for_stop Tool

**Polling behavior:**
1. DAP returns "notStopped" error → retries (up to timeout)
2. DAP returns stopped → returns stack frames
3. Timeout exceeded → returns partial result or error
4. Other DAP errors → propagate (not caught by `isNotStoppedError`)

**How to test:**
- Mock `dapBridge.stack()` to return `{ stackFrames: [...] }` after N calls
- Mock `dapBridge.stack()` to return notStopped error for first N calls, then stop
- Use fake timers (`vi.useFakeTimers()`) to control timeout

### snapshot Tool

**Aggregation behavior:**
1. **No frames** → `{ frame: null, scopes: [] }`
2. **With frames, no expensive scopes** → skips expensive scopes by default
3. **With `includeExpensive: true`** → includes expensive scopes
4. **`maxVariables` param** → limits each scope's variables to that count
5. **Frame ID lookup** → resolves `frameId` parameter to actual frame

**How to test:**
- Mock `dapBridge.stack()` → returns frames
- Mock `dapBridge.scopes()` → returns scopes with `expensive` flag
- Mock `dapBridge.variables()` → returns variables array
- Assert snapshot bundles them correctly

## Key Implementation Notes

1. `wait_for_stop` uses `isNotStoppedError()` to decide retry vs propagate
2. `snapshot` calls `stack()` → `scopes(frameId)` → `variables(scopeId)` chain
3. Both use fake timers for timeout control

## Verification

- wait_for_stop retries on notStopped, stops on actual stop
- snapshot bundles frame + scopes + variables correctly
- maxVariables limit is respected per scope