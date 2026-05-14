# Phase qf-1R — Review Code Fixes

## Goal
Review Phase qf-1 changes: verify all 4 Warning fixes are correct, safe, and complete.

## What to Inspect

### 1. `src/debug/errors.ts`
- [ ] `isNotStoppedError` is exported
- [ ] Function body matches the original implementation exactly
- [ ] JSDoc comment present

### 2. `src/debug/dapBridge.ts`
- [ ] Imports `isNotStoppedError` from `./errors`
- [ ] Old private `isNotStoppedError` function removed
- [ ] `fileExists` only catches ENOENT/FileNotFound
- [ ] `safeThreads` has `console.error` in catch block
- [ ] `restart()` takes `{ sessionId?: string }` options object
- [ ] No other signature changes

### 3. `src/mcp/server.ts`
- [ ] Imports `isNotStoppedError` from `../debug/errors`
- [ ] Old private `isNotStoppedError` function removed
- [ ] `restart` tool handler passes `{ sessionId }` object

### Verification
```bash
npm run check-types
npm run test
git diff src/
```

## Acceptance Criteria

- [ ] No duplicate `isNotStoppedError` in any file
- [ ] `isNotStoppedError` behavior unchanged (tests confirm)
- [ ] `fileExists` re-throws on permission errors
- [ ] `safeThreads` logs errors (console.error line present)
- [ ] `restart()` called consistently throughout codebase
- [ ] All 149+ tests pass, types clean
- [ ] No regressions introduced
- [ ] Output `<promise>PHASE qf-1R REVIEWED — PASS</promise>` or `<promise>BLOCKED: reason</promise>`
