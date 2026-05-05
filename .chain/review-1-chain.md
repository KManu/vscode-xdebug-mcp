# Review Phase 1 — dapBridge.test.ts

## Goal
Review dapBridge.test.ts for correctness, real-code testing, and edge case coverage.

## What to Review

Read `src/__tests__/dapBridge.test.ts` and `src/debug/dapBridge.ts` and verify:

### 1. Tests hit the real code
- Do tests actually call the real `dapBridge.ts` functions, or do they test something else?
- Are imports correct — do tests import from `../debug/dapBridge`?

### 2. Session resolution tests (lines ~250-290)
- `getSession` with valid sessionId → returns that session
- `getSession` with invalid sessionId → throws correct error
- `getSession` with no sessionId + active session → returns active
- `getSession` with no sessionId + no active → throws correct error

### 3. Path resolution tests (lines ~294-456)
- URI string → Uri.parse called
- Absolute Unix path → Uri.file called
- Windows drive path → Uri.file called
- Relative path → resolved against workspace folders

### 4. Breakpoint lifecycle tests (lines ~460-675)
- Set breakpoints → added to mcpFileBreakpoints Map
- Reset on same file → old removed, new added
- Clear → removed from registry
- SourceModified flag passed through

### 5. Error detection tests (lines ~92-247)
- isNotStoppedError via status() — notStopped message → stopped:false
- body.error.id === 'notStopped' → stopped:false
- Other errors → propagate

## Issues to Look For
- Tests that assert on wrong values (e.g., wrong error messages)
- Tests that don't verify the right calls were made
- Missing edge cases (empty strings, null/undefined, etc.)
- Overly permissive mocks that never fail

## Tasks
1. Read the test file
2. Read the corresponding source file
3. Identify any bugs, gaps, or issues
4. Fix them directly — this is a review + fix pass
5. Run `npm run test` to verify tests still pass after fixes
6. Report what was found and fixed
