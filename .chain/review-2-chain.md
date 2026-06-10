# Review Phase 2 — server.test.ts

## Goal
Review server.test.ts for correctness, real-code testing, and edge case coverage.

## What to Review

Read `src/__tests__/server.test.ts` and `src/mcp/server.ts` and verify:

### 1. Tests hit the real code
- Do tests import from the real `../mcp/server` or mock it too heavily?
- Do schema validation tests actually exercise the Zod schemas?

### 2. Tool schema validation tests
Verify each tool's schema is tested for:
- Valid inputs → pass validation
- Missing required params → fail validation
- Wrong types → fail validation
- Boundary values (empty string, 0, negative numbers, etc.)

### 3. structuredContent tests
- Every tool result has `structuredContent`
- structuredContent has `success: true`
- Tool-specific data is correctly shaped

### 4. wait_for_stop tests
- Polling on notStopped → retries
- Stopped → returns frames
- Other errors → propagate

### 5. snapshot tests
- No frames → frame:null, empty scopes
- includeExpensive: false → skips expensive scopes
- includeExpensive: true → includes expensive scopes
- maxVariables → limits each scope

### 6. Resource handlers
- xdebug://stack → returns stack frames
- xdebug://variables/{frameId} → returns variables

## Issues to Look For
- Tests that mock the DAP bridge but don't verify the mock was called correctly
- Missing validation cases for tool schemas
- structuredContent not present on some tool results
- snapshot not bundling data correctly

## Tasks
1. Read the test file
2. Read the corresponding source file
3. Identify any bugs, gaps, or issues
4. Fix them directly
5. Run `npm run test` to verify tests still pass
6. Report what was found and fixed
