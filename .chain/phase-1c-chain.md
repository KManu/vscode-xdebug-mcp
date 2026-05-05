# Phase 1c — dapBridge Breakpoint Lifecycle Tests

## Goal
Test breakpoint management in `src/debug/dapBridge.ts` — setting, resetting, clearing file and function breakpoints.

## What to Test

### File Breakpoint Management

1. **Set breakpoints on new file** → added to `mcpFileBreakpoints` Map
2. **Re-set breakpoints on same file** → old ones removed before new ones added
3. **Clear breakpoints (empty array)** → removed from registry
4. **`SourceModified` flag** → passed through to DAP `setFunctionBreakpoints` request

### Function Breakpoint Management

1. **Set function breakpoints** → stored in `mcpFunctionBreakpoints` array
2. **Replace function breakpoints** → old replaced with new

### Exception Breakpoints

1. **Set exception breakpoints** → forwarded to DAP adapter

## How to Implement

1. Read `src/debug/dapBridge.ts` — find all breakpoint-related functions and the Maps/arrays that store them
2. Key functions: `setFileBreakpoints()`, `setFunctionBreakpoints()`, `setExceptionBreakpoints()`
3. Key storage: `mcpFileBreakpoints` Map (key = file URI string), `mcpFunctionBreakpoints` array
4. Mock `vscode.debug.addBreakpoints()` and `session.customRequest()` for DAP calls

**Important:** The actual DAP calls go through `session.customRequest('setBreakpoints', ...)`. Mock this to capture what gets sent.

## Verification

- Verify `mcpFileBreakpoints` Map is updated correctly for each operation
- Verify DAP `setBreakpoints` request receives correct payload structure
- Verify breakpoints are removed from Map when cleared