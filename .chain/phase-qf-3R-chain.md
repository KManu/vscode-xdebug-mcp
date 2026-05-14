# Phase qf-3R — Review Test Coverage

## Goal
Review Phase qf-3 changes: verify all new tests are valid, meaningful, and cover the intended gaps.

## What to Inspect

### 1. New resource handler tests
- [ ] `xdebug://stack` tests actually call the resource handler and verify output
- [ ] `xdebug://variables/{frameId}` tests cover valid frameId, NaN, and no-scope case
- [ ] Mocks are properly set up and cleaned up between tests

### 2. New `wait_for_stop` error propagation test
- [ ] Mocks `dap.stack` to throw non-notStopped error
- [ ] Verifies error propagates (not swallowed, not retried)
- [ ] Does not interfere with existing `wait_for_stop` tests

### 3. New header normalization tests
- [ ] Tests send requests WITHOUT Accept header
- [ ] Tests verify the header was injected
- [ ] Tests for both POST and GET
- [ ] Tests verify existing headers are preserved

### 4. Dead assignment removal
- [ ] `const uri = await dapBridge.setFileBreakpoints as any;` is gone
- [ ] Surrounding test logic still correct
- [ ] No other dead assignments introduced

### 5. `outputSchema` tests
- [ ] Tests verify `outputSchema` is defined on set_breakpoint and set_logpoint
- [ ] Tests are non-trivial (check shape, not just truthiness)

### Verification
```bash
npm run check-types
npm run test
```
- Ensure test count increased (target: >160)
- No test failures or type errors

## Acceptance Criteria

- [ ] All new tests are meaningful (not tautological)
- [ ] Total test count >160
- [ ] No regressions in existing tests
- [ ] All tests pass, types clean
- [ ] No test-only dead code remaining
- [ ] Output `<promise>PHASE qf-3R REVIEWED — PASS</promise>` or `<promise>BLOCKED: reason</promise>`
