# Phase rf-3 — Diagnostics & Observability

## Goal
Add health monitoring, self-diagnostic tools, and user-visible indicators so both MCP agents and human users can see server state at a glance.

## Gaps Addressed
- **Gap 3** (7th priority): No health check endpoint
- **Gap 11** (8th priority): No diagnostics MCP tool for self-diagnosis
- **Gap 10** (9th priority): No status bar indicator in VS Code

## Files to Modify

### 1. ADD `/health` endpoint to `src/mcp/httpTransport.ts` (Gap 3)

Before the existing `/mcp` path check, add:

```typescript
if (url.pathname === '/health' && req.method === 'GET') {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    status: 'ok',
    version: options.version,
    uptime: process.uptime()
  }));
  return;
}
```

### 2. ADD `diagnostics` MCP tool to `src/mcp/server.ts` (Gap 11)

```typescript
server.registerTool(
  'diagnostics',
  {
    title: 'Diagnostics',
    description: 'Report MCP server health and Xdebug configuration status',
    inputSchema: {
      sessionId: sessionIdSchema
    }
  },
  safeHandler(async ({ sessionId }) => {
    const sessions = await dap.listSessions();
    const hasSession = sessions.length > 0;

    let sessionStatus: dap.DebugStatus | null = null;
    if (hasSession) {
      try {
        sessionStatus = await dap.status(sessionId);
      } catch {
        // Session may have died between listSessions and status
      }
    }

    const recommendations: string[] = [];
    if (!hasSession) {
      recommendations.push(
        'No active debug session. Start a PHP/Xdebug debug session in VS Code (F5).'
      );
      recommendations.push(
        'Ensure Xdebug is configured with xdebug.mode=debug and xdebug.client_port matches launch.json.'
      );
    } else if (sessionStatus && !sessionStatus.stopped) {
      recommendations.push(
        'Debug session is running. Set a breakpoint and trigger a PHP request to stop execution.'
      );
      recommendations.push(
        'Use wait_for_stop to block until a breakpoint is hit, or pause to interrupt.'
      );
    } else if (sessionStatus && sessionStatus.stopped) {
      recommendations.push(
        'Debug session is stopped and ready for inspection. Use stack, scopes, variables, or snapshot to inspect state.'
      );
    }

    return structuredResult({
      server: 'running',
      version: serverVersion,
      sessions: sessions.map(s => ({ id: s.id, name: s.name, type: s.type })),
      sessionCount: sessions.length,
      hasActiveSession: hasSession,
      sessionStopped: sessionStatus?.stopped ?? false,
      threadId: sessionStatus?.threadId,
      threadCount: sessionStatus?.threads?.length ?? 0,
      recommendations
    });
  })
);
```

### 3. ADD status bar item to `src/extension.ts` (Gap 10)

Import session tracking at module level — we need to expose session count. Add to dapBridge first:

**In `src/debug/dapBridge.ts`, add export:**
```typescript
export function getSessionCount(): number {
  return sessionRegistry.size;
}
```

**In `src/extension.ts`, add status bar:**

```typescript
import { registerSessionTracking, getSessionCount } from './debug/dapBridge';

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerSessionTracking(context.subscriptions);
  const serverVersion = String(context.extension.packageJSON.version ?? '0.0.1');

  // Start server...
  try {
    const uri = await startHttpServer({ version: serverVersion });
    console.log(`Vscode Xdebug MCP server listening at ${uri}`);
  } catch (error) { /* ... existing ... */ }

  // Status bar item — right side, low priority
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'xdebug-mcp.showDiagnostics';
  statusBarItem.tooltip = 'Xdebug MCP Server Status';
  context.subscriptions.push(statusBarItem);

  // Register command for clicking the status bar
  context.subscriptions.push(
    vscode.commands.registerCommand('xdebug-mcp.showDiagnostics', () => {
      const count = getSessionCount();
      const msgs = [
        `Xdebug MCP Server v${serverVersion}`,
        `Active debug sessions: ${count}`,
        `Server: ${startHttpServer({ version: serverVersion }).then(u => u).catch(() => 'offline')}`
      ];
      vscode.window.showInformationMessage(msgs.join('\n'));
    })
  );

  function updateStatusBar(): void {
    const count = getSessionCount();
    if (count > 0) {
      statusBarItem.text = `$(debug-alt) Xdebug MCP (${count})`;
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = `$(debug-disconnect) Xdebug MCP`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBarItem.show();
  }

  updateStatusBar();
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(() => updateStatusBar()),
    vscode.debug.onDidTerminateDebugSession(() => updateStatusBar()),
    vscode.debug.onDidChangeActiveDebugSession(() => updateStatusBar())
  );

  // ... rest of existing code (provider, disposables) ...
}
```

## Acceptance Criteria

- [ ] `GET /health` returns `{ status: "ok", version: "...", uptime: ... }` with 200
- [ ] `diagnostics` MCP tool registered with inputSchema
- [ ] `diagnostics` returns session list, stopped state, and actionable recommendations
- [ ] `diagnostics` wrapped with `safeHandler`
- [ ] `getSessionCount()` exported from dapBridge
- [ ] Status bar shows `$(debug-alt) Xdebug MCP (N)` when sessions active
- [ ] Status bar shows `$(debug-disconnect) Xdebug MCP` with warning background when no sessions
- [ ] Clicking status bar shows info message with server status
- [ ] Status bar updates on session start/terminate/change events
- [ ] `npm run check-types` passes
- [ ] `npm run test` passes
- [ ] Output `<promise>PHASE rf-3 COMPLETE</promise>`
