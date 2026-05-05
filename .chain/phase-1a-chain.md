# Phase 1a — dapBridge Session Resolution Tests

## Goal
Test the `getSession()` function in `src/debug/dapBridge.ts` — the critical session routing logic that all MCP tools depend on.

## What to Test

### `getSession(sessionId?)` in dapBridge.ts

**Test cases:**
1. **Valid sessionId** → returns that session from registry
2. **Invalid sessionId** → throws `"Debug session not found: {sessionId}"`
3. **No sessionId + active session exists** → returns `vscode.debug.activeDebugSession`
4. **No sessionId + no active session** → throws `"No active debug session"`

## How to Implement

1. Read `src/debug/dapBridge.ts` — find the `getSession()` function and `sessionRegistry` Map
2. Import `describe`, `it`, `expect` from vitest
3. Import the mock helpers from `src/__tests__/mockVscode.ts`
4. Import `dapBridge` functions — you'll need to mock the VS Code debug events first
5. Use `vi.mock('vscode')` to mock `vscode.debug.activeDebugSession` and `sessionRegistry`

**Key mocking detail:** The `sessionRegistry` is populated via `registerSessionTracking()` which sets up VS Code event listeners. You need to:
- Mock `vscode.debug.onDidStartDebugSession` to register sessions in a mock registry
- OR directly manipulate the mock registry before each test

## Verification

After writing tests, verify:
- Each test case actually runs (no import errors)
- Run `npm run check-types` to ensure types are correct
- Read through each test to confirm the logic matches the actual code behavior