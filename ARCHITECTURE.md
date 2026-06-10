# Architecture: vscode-xdebug-mcp

Deep documentation for LLM agents working on this codebase.

## System Overview

This is a **VS Code extension** that exposes an **MCP (Model Context Protocol)** server for PHP/Xdebug debugging. It runs entirely inside the VS Code Extension Host process and bridges MCP tool calls to DAP (Debug Adapter Protocol) requests against active debug sessions.

```
┌──────────┐     HTTP/JSON-RPC      ┌───────────────┐     customRequest      ┌──────────────────┐
│ MCP      │ ──────────────────────→ │ extension.ts  │ ──────────────────────→ │ dapBridge.ts     │
│ Client   │ ←────────────────────── │               │ ←────────────────────── │ (session reg.)   │
│ (Codex)  │     structuredContent   │  httpTransport│     DAP responses       │                  │
└──────────┘                         │  server.ts    │                         └────────┬─────────┘
                                     └───────────────┘                                  │
                                                                              ┌─────────▼─────────┐
                                                                              │ vscode.debug API  │
                                                                              │ activeDebugSession│
                                                                              │ customRequest()   │
                                                                              └───────────────────┘
```

## File Map

| File | Lines | Role | Key Exports |
|------|-------|------|-------------|
| `src/extension.ts` | ~65 | VS Code entrypoint, lifecycle | `activate()`, `deactivate()` |
| `src/mcp/httpTransport.ts` | ~180 | HTTP server, JSON-RPC transport | `startHttpServer()`, `stopHttpServer()` |
| `src/mcp/server.ts` | ~520 | MCP tools/resources/prompts | `makeServer()` |
| `src/debug/dapBridge.ts` | ~320 | Session registry, DAP requests | All DAP functions, test helpers |

## Core Patterns

### 1. MCP Tool Registration Pattern (server.ts)

Every tool follows this shape:

```typescript
server.registerTool(
  'tool_name',
  {
    title: 'Human Title',
    description: 'What it does',
    inputSchema: {
      sessionId: sessionIdSchema,  // optional, picks active session if omitted
      // ... Zod-validated params
    }
  },
  async ({ sessionId, ...params }) => {
    const result = await dap.someFunction({ sessionId, ...params });
    return structuredResult({ key: result });
  }
);
```

**Critical invariant**: Every tool response MUST include `structuredContent` with `success: true`. Two response helpers:
- `okResult()` — for commands with no return data (continue, pause, step_*)
- `structuredResult(data)` — merges `success: true` with tool-specific data

### 2. DAP Bridge Pattern (dapBridge.ts)

All debug adapter communication goes through `session.customRequest(command, args)`:

```typescript
function getSession(sessionId?: string): vscode.DebugSession {
  if (sessionId) {
    const session = sessionRegistry.get(sessionId);
    if (!session) throw new Error(`Debug session not found: ${sessionId}`);
    return session;
  }
  const session = vscode.debug.activeDebugSession;
  if (!session) throw new Error('No active debug session');
  return session;
}
```

**Session resolution priority**:
1. Explicit `sessionId` → lookup in registry
2. No `sessionId` → `vscode.debug.activeDebugSession`
3. Neither available → throw

### 3. Path Resolution (`resolveFileUri()`)

Handles 4 cases in priority order:
1. `vscode.Uri` format (`scheme://...`) → `vscode.Uri.parse()`
2. Windows drive letter (`C:\...`) or absolute Unix path → `vscode.Uri.file()`
3. Workspace-relative → resolved against session's workspace folder first, then `vscode.workspace.workspaceFolders` by file existence check
4. No workspace → `path.resolve()` against cwd

### 4. Error Handling for `notStopped`

Two identical `isNotStoppedError()` implementations exist — one in `dapBridge.ts` (used by `status()`) and one in `server.ts` (used by `wait_for_stop` polling). Both check:
- Error message contains `"notStopped"`, OR
- `error.body.error.id === 'notStopped'`

This is intentional: DAP adapters signal this differently.

### 5. Session Lifecycle

`registerSessionTracking()` in `dapBridge.ts` hooks into 3 VS Code events:
- `onDidStartDebugSession` → add to registry
- `onDidTerminateDebugSession` → remove from registry
- `onDidChangeActiveDebugSession` → ensure active session is tracked

Called once from `extension.ts` `activate()`. Also snaps the current active session if one exists.

### 6. HTTP Transport Details

- **Port**: Default 3098, falls back to OS-assigned (port 0) on `EADDRINUSE`
- **Endpoint**: Single `/mcp` path only; 404 for everything else
- **Body limit**: 2MB hard cap; 413 JSON-RPC error if exceeded
- **Per-request servers**: New `McpServer` + `StreamableHTTPServerTransport` per request
- **Header normalization**: Injects `accept` and `content-type` headers the MCP SDK expects
- **Listener cleanup**: `res.off('close')` / `res.removeListener('close')` in finally block

### 7. Breakpoint Management

Two categories tracked separately:
- **File breakpoints**: `mcpFileBreakpoints` Map keyed by file URI string. `setFileBreakpoints()` removes old ones before setting new ones. Clearing sends empty array (which removes from registry). Uses `vscode.SourceBreakpoint`.
- **Function breakpoints**: Single `mcpFunctionBreakpoints` array. Same remove-then-set pattern. Uses `vscode.FunctionBreakpoint`.
- **Exception breakpoints**: Not tracked locally; passed through directly to DAP adapter via `setExceptionBreakpoints` custom request.

## MCP Tools Inventory

### Inspection (read-only, require stopped state)
| Tool | DAP Command | Returns |
|------|-------------|---------|
| `list_sessions` | N/A (registry) | `DebugSessionInfo[]` |
| `status` | `stackTrace`, `threads` | session info + stopped flag + threads |
| `threads` | `threads` | `ThreadInfo[]` |
| `stack` | `stackTrace` | `StackFrame[]` (with pagination) |
| `scopes` | `scopes` | `Scope[]` for a frame |
| `variables` | `variables` | `Variable[]` (with paging/filter) |
| `snapshot` | `stackTrace` + `scopes` + `variables` | frame + all scopes + variables (aggregated) |
| `evaluate_expr` | `evaluate` | result + type + variablesReference |

### Execution Control (write operations)
| Tool | DAP Command | Notes |
|------|-------------|-------|
| `continue` | `continue` | threadId defaults to 1 |
| `pause` | `pause` | |
| `step_over` | `next` | |
| `step_in` | `stepIn` | |
| `step_out` | `stepOut` | |
| `restart` | `restart` | |
| `terminate` | `terminate` | optional `restart` flag |
| `disconnect` | `disconnect` | terminateDebuggee/restart/suspendDebuggee flags |

### Breakpoints (mixed)
| Tool | DAP Command | Notes |
|------|-------------|-------|
| `set_breakpoint` | `setBreakpoints` (via VS Code API) | condition, hitCondition, logMessage |
| `set_logpoint` | `setBreakpoints` (via VS Code API) | requires logMessage |
| `clear_breakpoints` | N/A (removes from VS Code + registry) | |
| `set_function_breakpoints` | `setFunctionBreakpoints` (via VS Code API) | |
| `set_exception_breakpoints` | `setExceptionBreakpoints` (DAP) | |

### MCP Resource Handlers
- `xdebug://stack` — static resource, returns call stack
- `xdebug://variables/{frameId}` — resource template, returns variables for a frame's first scope

## Testing Architecture

**Framework**: Vitest with `pool: 'forks'` (isolation per test file)

**Mock strategy**: Entire `vscode` module is mocked via vi.mock. No real VS Code API loads.

**Key mock file**: `src/__tests__/mockVscode.ts` — provides reusable mocks for:
- `vscode.debug` (activeDebugSession, session events, customRequest)
- `vscode.workspace` (workspaceFolders, fs.stat)
- `vscode.Uri` (file, parse, joinPath)
- Breakpoint constructors

**Test files**:
- `dapBridge.test.ts` — session registry, path resolution, breakpoint lifecycle, notStopped detection
- `server.test.ts` — tool schemas, structuredContent, snapshot aggregation, wait_for_stop polling
- `httpTransport.test.ts` — body limits, port fallback, parse errors, header normalization, listener cleanup

## Critical Constraints

1. **`@types/vscode` may not expose full debug session APIs** — use `session.customRequest()` for raw DAP
2. **Xdebug path mappings**: Server-side paths differ from local paths; `pathMappings` in `launch.json` bridges them
3. **Xdebug does not support reverse debugging** (step back)
4. **Most tools default to active session** unless `sessionId` is provided
5. **Agent-set breakpoints appear in VS Code Breakpoints panel** — uses real VS Code breakpoint APIs
6. **The extension runs in Extension Host**, NOT in the user's application process
7. **Dynamic port fallback** is critical for multi-instance VS Code support
8. **StreamableHTTP transport** creates a new MCP server per request — no persistent session state across requests
