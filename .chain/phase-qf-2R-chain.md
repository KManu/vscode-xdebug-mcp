# Phase qf-2R — Review Dead Code Resolution

## Goal
Review Phase qf-2 changes: verify mockVscode.ts refactoring is correct and safe.

## What to Inspect

### 1. `src/__tests__/mockVscode.ts`
- [ ] All exports are used by at least one test file
- [ ] No unused exports remain
- [ ] Mock helper functions are complete (cover all vscode API surfaces needed)

### 2. `src/__tests__/dapBridge.test.ts`
- [ ] No inline `vi.mock('vscode', ...)` with implementation code
- [ ] All mock setup via imports from mockVscode
- [ ] Test logic unchanged (compare with git diff)
- [ ] All 24 tests still pass

### 3. `src/__tests__/server.test.ts`
- [ ] No inline `vi.mock('vscode', ...)` with implementation code
- [ ] All mock setup via imports from mockVscode
- [ ] Test logic unchanged
- [ ] All 111 tests still pass

### 4. `src/__tests__/httpTransport.test.ts`
- [ ] vscode mocks via mockVscode (if applicable)

### Verification
```bash
npm run check-types
npm run test
git diff src/__tests__/
```

## Acceptance Criteria

- [ ] No inline vscode mock implementations > 10 lines in any test file
- [ ] mockVscode.ts has no unused exports
- [ ] All 149+ tests pass
- [ ] Types clean
- [ ] No test logic changes (only mock setup refactored)
- [ ] Output `<promise>PHASE qf-2R REVIEWED — PASS</promise>` or `<promise>BLOCKED: reason</promise>`
