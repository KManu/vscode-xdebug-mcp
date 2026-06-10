# Phase 4 — Integration Verification

## Goal
Run the full test suite and verify everything works end-to-end.

## Tasks

### 1. Run all tests
```bash
npm run test
```
- All tests should pass
- No failing or skipped tests (unless intentionally marked)

### 2. Type check
```bash
npm run check-types
```
- No new type errors introduced

### 3. Compile
```bash
npm run compile
```
- Bundle should complete without errors

### 4. Review coverage
Review test coverage to ensure critical paths are covered:
- [ ] dapBridge: getSession, resolveFileUri, breakpoint lifecycle, isNotStoppedError
- [ ] server: tool schemas, structuredContent, wait_for_stop, snapshot
- [ ] httpTransport: body limits, parse errors, port fallback, headers

### 5. Any failing tests
Fix any test failures before marking complete.

## Acceptance Criteria

- [ ] `npm run test` passes (all tests green)
- [ ] `npm run check-types` passes (no new type errors)
- [ ] Test coverage covers all critical paths from PLAN.md
- [ ] No console errors or warnings in test output
- [ ] Update PLAN.md to mark all test scenarios as implemented

## Final Step

After all tests pass, update `.chain/.current_phase`:
```
PHASE=4
SUBPHASE=
STATUS=complete
LAST_COMPLETED=4
```

Output `<promise>ALL PHASES COMPLETE</promise>` to signal completion.