# Adequate Tests for vscode-xdebug-mcp

## Context

This VS Code extension exposes Xdebug/PHP debugging via MCP. It has **zero existing tests** despite having ~1,200 lines of TypeScript across 4 key files. Given the architecture (VS Code extension → MCP server → DAP bridge → debug sessions), the critical paths that need test coverage are: session resolution, path mapping, breakpoint management, HTTP transport body limits, and MCP tool routing.

## Recommended Test Setup

**Framework:** Vitest (native ESM, fast, good `vi.mock()` for VS Code APIs)
**Structure:** `src/__tests__/` with one test file per module

### Files to Create

| File | Purpose |
|------|---------|
| `vitest.config.ts` | TypeScript paths, VS Code mock setup |
| `src/__tests__/mockVscode.ts` | Reusable VS Code API mocks |
| `src/__tests__/dapBridge.test.ts` | Session registry, path resolution, breakpoints |
| `src/__tests__/server.test.ts` | MCP tool schemas, routing, `structuredContent` |
| `src/__tests__/httpTransport.test.ts` | Body limits, port fallback, parse errors |

## Critical Test Scenarios

### 1. dapBridge.test.ts

**Session resolution** (`getSession()`)
- Valid `sessionId` → returns that session
- Invalid `sessionId` → throws `"Debug session not found"`
- No `sessionId` + active session → returns active session
- No `sessionId` + no active session → throws `"No active debug session"`

**Path resolution** (`resolveFileUri()`)
- `vscode.Uri` input → returned as-is
- Absolute Unix path → `vscode.Uri.file()` result
- Windows drive path → `vscode.Uri.file()` result
- Workspace-relative path → resolved against first workspace folder
- Relative path not in first folder → searched in subsequent folders
- Non-existent relative path → returned as `firstFolder.joinPath(relative)`

**Breakpoint lifecycle**
- Set breakpoints on new file → added to `mcpFileBreakpoints` Map
- Reset breakpoints on same file → old ones removed, new ones added
- Clear (empty array) → removed from registry
- SourceModified flag passed to adapter

**Error detection** (`isNotStoppedError()`)
- `"notStopped"` in error message → true
- `body.error.id === 'notStopped'` → true
- Other errors → false (propagate)

### 2. server.test.ts

**Tool input validation**
- Each tool's Zod schema enforced (e.g., `stack` accepts `threadId?`, `startFrame?`, `levels?`)
- Missing required params → validation error
- Invalid types → validation error

**`structuredContent` attachment**
- Every tool result has `structuredContent` with `success: true` and response data

**`wait_for_stop` polling**
- Mock DAP returns `notStopped` → retries
- Mock DAP returns stopped → returns stack
- Other errors → propagate

**`snapshot` aggregation**
- No frames → `{ frame: null, scopes: [] }`
- Expensive scopes skipped unless `includeExpensive: true`
- `maxVariables` limits each scope's variable count

**Resource handlers**
- `xdebug://stack` → returns current stack
- `xdebug://variables/{frameId}` → returns frame's variables

### 3. httpTransport.test.ts

**Body size limit**
- Body < 2MB → parses successfully
- Body = 2MB → parses successfully
- Body > 2MB → returns 413 with JSON-RPC error

**Parse error handling**
- Empty body → 400 JSON-RPC parse error
- Malformed JSON → 400 JSON-RPC parse error

**Port fallback**
- Port 3098 available → uses it
- Port 3098 `EADDRINUSE` → falls back to port 0 (OS-assigned)
- Other errors → propagate

**Header normalization**
- POST without `accept` → added `accept: application/json, text/event-stream`
- GET without `accept` → added `accept: text/event-stream`

**Listener cleanup**
- After response `close` event → `res.off()` or `res.removeListener()` called

## Mocking Strategy

Mock **vscode** module entirely — no need to load the real API:
- `vscode.debug.activeDebugSession`
- `vscode.debug.onDidStartDebugSession`, `onDidTerminateDebugSession`, `onDidChangeActiveDebugSession`
- `vscode.workspace.workspaceFolders`
- `vscode.Uri.file()`, `Uri.parse()`, `Uri.joinPath()`
- `vscode.SourceBreakpoint`, `vscode.FunctionBreakpoint`

Mock **node:http** for transport tests:
- `createServer()`, `Server`, `IncomingMessage`, `ServerResponse`

## package.json Additions

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest watch"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

## Verification

1. Run `npm run test` — all tests pass
2. Run `npm run check-types` — no new type errors
3. Run `npm run watch` and verify extension still loads in VS Code