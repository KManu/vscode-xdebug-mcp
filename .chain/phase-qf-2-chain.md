# Phase qf-2 — Dead Code Resolution (B1)

## Goal
Refactor all 3 test files to use the shared mock helpers in `src/__tests__/mockVscode.ts` instead of inline mock duplication. This eliminates ~400 lines of duplicated code and makes `mockVscode.ts` actually used.

## Current State
- `mockVscode.ts` (232 lines) exports mock classes and factory functions
- `dapBridge.test.ts` has ~56 lines of inline vscode mock setup
- `server.test.ts` has ~56 lines of inline vscode mock setup (nearly identical)
- `httpTransport.test.ts` has its own vscode mocks
- **None of the test files import anything from `mockVscode.ts`**

## Files to Modify

### 1. REVIEW `src/__tests__/mockVscode.ts`
Ensure the exported helpers cover everything the tests need:
- `createMockDebugSession(overrides?)` — mock session with id, name, type, workspaceFolder, customRequest
- `createMockWorkspaceFolder(path)` — mock workspace folder
- `createMockUri(fsPath?)` — mock URI
- `mockVscodeDebug()` — `vi.mock('vscode', ...)` returning debug module mocks
- `mockVscodeWorkspace()` — workspace module mocks (workspaceFolders, fs.stat)
- `mockVscodeUri()` — URI factory mocks (file, parse, joinPath)

### 2. REFACTOR `src/__tests__/dapBridge.test.ts`
- REMOVE inline `vi.mock('vscode', ...)` block
- IMPORT `createMockDebugSession`, `createMockWorkspaceFolder`, `createMockUri`, `mockVscodeDebug`, `mockVscodeWorkspace`, `mockVscodeUri` from `./mockVscode`
- REPLACE inline session creation with `createMockDebugSession(overrides)`
- REPLACE inline workspace folder with `createMockWorkspaceFolder(path)`
- KEEP test logic unchanged — only swap the mock setup

### 3. REFACTOR `src/__tests__/server.test.ts`
- Same process as dapBridge.test.ts
- Replace inline mocks with imports from mockVscode.ts
- KEEP all test logic unchanged

### 4. REFACTOR `src/__tests__/httpTransport.test.ts`
- Replace any vscode mocks with imports from mockVscode.ts
- If httpTransport tests don't use vscode mocks, skip this file

### 5. ADDITIONAL mockVscode.ts improvements (if gaps found)
If any test needs a mock helper not in mockVscode.ts:
- Add the missing helper to mockVscode.ts
- All 3 test files should share from mockVscode.ts

## Acceptance Criteria

- [ ] `mockVscode.ts` is imported by at least 2 test files
- [ ] No `vi.mock('vscode', ...)` with >10 lines of inline implementation in any test
- [ ] `dapBridge.test.ts` uses `createMockDebugSession` from mockVscode
- [ ] `server.test.ts` uses `createMockDebugSession` from mockVscode
- [ ] All mock helper functions in mockVscode.ts are used by at least one test file
- [ ] `npm run check-types` passes
- [ ] `npm run test` passes (all tests still green, same or higher count)
- [ ] Output `<promise>PHASE qf-2 COMPLETE</promise>`
