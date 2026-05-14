# Phase qf-4 — Integration Verification

## Goal
Run the full test suite and verify all fixes work end-to-end. Confirm no regressions.

## Tasks

### 1. Run all tests
```bash
npm run test
```
- All tests must pass
- Test count should be >160 (was 149 before quorum fixes)
- No skipped or failing tests

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

### 4. Package (optional, if build tools are available)
```bash
npm run package
```

### 5. Verify quorum findings addressed
Confirm each finding is resolved:

| # | Finding | Status |
|---|---------|--------|
| B1 | mockVscode.ts unused | ✅ Refactored tests to use it |
| W1 | isNotStoppedError duplicated | ✅ Extracted to shared module |
| W2 | fileExists catches all errors | ✅ Narrowed to ENOENT only |
| W3 | safeThreads swallows errors | ✅ Console.error added |
| W4 | No resource handler tests | ✅ Tests added |
| W5 | wait_for_stop error propagation untested | ✅ Test added |
| W6 | Header normalization untested | ✅ Tests added |
| W7 | restart() signature inconsistent | ✅ Normalized |
| N7 | Dead assignment in test | ✅ Removed |
| N10 | outputSchema not tested | ✅ Tests added |

### 6. Git diff summary
```bash
git diff --stat
```

## Acceptance Criteria

- [ ] `npm run test` passes with >160 tests, 0 failures
- [ ] `npm run check-types` passes clean
- [ ] `npm run compile` completes without errors
- [ ] All 10 findings in the table above marked ✅
- [ ] No new console warnings or errors in test output
- [ ] Git diff shows only intended changes
- [ ] Output `<promise>PHASE qf-4 COMPLETE</promise>`
- [ ] Output `<promise>ALL QUORUM FIX PHASES COMPLETE</promise>`
