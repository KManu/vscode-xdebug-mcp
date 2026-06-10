# Phase 4R — Final Integration Verification

## Context
All test phases are now complete (including 3aR and 3bR fixes). This phase performs final verification and updates the chain state to complete.

## Goal
Run the full test suite, verify everything works, and set chain state to complete.

## Tasks

### 1. Run all tests
```bash
npm run test
```
- All tests pass (dapBridge + server + httpTransport)
- No failing or skipped tests

### 2. Type check
```bash
npm run check-types
```
- No type errors

### 3. Test count verification
Verify we have:
- dapBridge.test.ts: ~24 tests
- server.test.ts: ~111 tests
- httpTransport.test.ts: ~30+ tests (original 36 may be reduced since we removed duplicate helpers)
- Total: ~165+ tests

If test count dropped significantly, investigate what was removed and whether coverage was lost.

### 4. Verify httpTransport tests are real
Confirm that `simulateReadJsonBody` and `simulateHttpRequest` do NOT exist in the test file. The tests should make real HTTP calls.

### 5. Git commit
Commit all test files:
```bash
git add src/__tests__/ vitest.config.ts
git commit -m "test: add comprehensive test suite for dapBridge, server, and httpTransport

- dapBridge: session resolution, path resolution, breakpoint lifecycle, isNotStoppedError
- server: MCP tool schema validation, structuredContent, wait_for_stop, snapshot
- httpTransport: body limits, parse errors, port fallback, headers, MCP protocol

171 tests passing"
```

### 6. Update PLAN.md
Mark all test scenarios as implemented.

## Acceptance Criteria
- [ ] `npm run test` passes with all tests
- [ ] `npm run check-types` passes
- [ ] httpTransport tests use real HTTP (no simulate* helpers)
- [ ] All test files committed to git
- [ ] PLAN.md updated
- [ ] Chain state: PHASE=4, SUBPHASE=R, STATUS=complete, LAST_COMPLETED=4R
- [ ] Output `<promise>ALL PHASES COMPLETE</promise>`
