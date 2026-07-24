import * as vscode from 'vscode';
import { startHttpServer, stopHttpServer, getLastKnownUri } from './mcp/httpTransport';
import { registerSessionTracking, getSessionCount } from './debug/dapBridge';
import { log } from './utils/logger';
import { getActiveUri } from './utils/portFile';
import { previewMcpJsonChange, writeWorkspaceMcpJson } from './utils/mcpJson';

// VS Code entrypoint. This runs inside the Extension Host process, not your app.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Track debug session lifecycle so MCP tools can target sessions explicitly.
  registerSessionTracking(context.subscriptions);
  // Use the extension version as the MCP server version for consistency.
  const serverVersion = String(context.extension.packageJSON.version ?? '0.0.1');

  let mcpUri: string | undefined;
  let usedFallbackPort = false;

  try {
    // Start the HTTP MCP server early so agents can connect immediately.
    mcpUri = await startHttpServer({ version: serverVersion });
    log.info(`Vscode Xdebug MCP server listening at ${mcpUri}`);

    // Detect if we fell back from the default port.
    const port = parseInt(new URL(mcpUri).port, 10);
    usedFallbackPort = port !== 3098 && port !== 0;
    if (usedFallbackPort) {
      log.info(`Using non-default port ${port} (3098 was occupied)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to start Vscode Xdebug MCP server: ${message}`);
  }

  // Status bar item — shows Xdebug MCP session count at a glance.
  // Click copies the MCP URI to clipboard; tooltip shows the full URI.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'xdebug-mcp.copyUri';
  context.subscriptions.push(statusBarItem);

  // Copy MCP URI to clipboard (clicking the status bar).
  context.subscriptions.push(
    vscode.commands.registerCommand('xdebug-mcp.copyUri', async () => {
      const uri = getLastKnownUri() ?? getActiveUri();
      if (!uri) {
        void vscode.window.showWarningMessage('MCP server is not running. URI not available.');
        return;
      }
      await vscode.env.clipboard.writeText(uri);
      void vscode.window.showInformationMessage(`Copied to clipboard: ${uri}`);
    })
  );

  // Show diagnostics (session count + URI).
  context.subscriptions.push(
    vscode.commands.registerCommand('xdebug-mcp.showDiagnostics', () => {
      const count = getSessionCount();
      const uri = getLastKnownUri() ?? getActiveUri();
      const uriLine = uri ? `MCP URI: ${uri}\n` : '';
      vscode.window.showInformationMessage(
        `${uriLine}Xdebug MCP Server v${serverVersion}\nActive debug sessions: ${count}`
      );
    })
  );

  // Copy config snippet for various MCP clients.
  context.subscriptions.push(
    vscode.commands.registerCommand('xdebug-mcp.copyConfig', async () => {
      const uri = getLastKnownUri() ?? getActiveUri();
      if (!uri) {
        void vscode.window.showWarningMessage('MCP server is not running. Start it first.');
        return;
      }

      const choice = await vscode.window.showQuickPick([
        {
          label: '$(json) Standard .mcp.json / VS Code / pi',
          description: 'For workspace .vscode/mcp.json, ~/.config/mcp/mcp.json, or .mcp.json',
          format: 'mcp',
        },
        {
          label: '$(file-code) Codex (config.toml)',
          description: 'For ~/.codex/config.toml or .codex/config.toml',
          format: 'codex',
        },
        {
          label: '$(settings-gear) Claude Code (settings.json)',
          description: 'For ~/.claude/settings.json → mcpServers section',
          format: 'claude',
        },
      ], { placeHolder: 'Select target MCP client to copy config for…' });

      if (!choice) {
        return;
      }

      let snippet: string;
      switch (choice.format) {
        case 'codex':
          snippet = `[mcp_servers.xdebug]
url = "${uri}"`;
          break;
        case 'claude':
          snippet = `"xdebug": {
  "type": "http",
  "url": "${uri}"
}`;
          break;
        default:
          snippet = `"xdebug": {
  "type": "http",
  "url": "${uri}"
}`;
          break;
      }

      await vscode.env.clipboard.writeText(snippet);
      void vscode.window.showInformationMessage(`Copied ${choice.label.split(' ')[1]} config for xdebug MCP server.`);
    })
  );

  // Add xdebug to workspace .vscode/mcp.json with preview.
  context.subscriptions.push(
    vscode.commands.registerCommand('xdebug-mcp.addToWorkspaceMcp', async () => {
      const uri = getLastKnownUri() ?? getActiveUri();
      if (!uri) {
        void vscode.window.showWarningMessage('MCP server is not running. Start it first.');
        return;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage('No workspace folder open. Open a workspace first.');
        return;
      }

      const preview = previewMcpJsonChange(workspaceRoot, uri);
      if ('error' in preview) {
        void vscode.window.showErrorMessage(`Failed to preview change: ${preview.error}`);
        return;
      }

      const action = preview.isNewFile ? 'Create new file' : 'Update existing file';
      const message = preview.isNewFile
        ? `Create .vscode/mcp.json with xdebug server at ${uri}?`
        : `Update .vscode/mcp.json to add xdebug server at ${uri}?`;

      const detail = `Before:\n${preview.before}\n\nAfter:\n${preview.after}`;

      const confirmed = await vscode.window.showInformationMessage(
        message,
        { modal: true, detail },
        action,
      );

      if (confirmed !== action) {
        return;
      }

      const ok = writeWorkspaceMcpJson(workspaceRoot, uri);
      if (ok) {
        void vscode.window.showInformationMessage(
          `Xdebug MCP server added to .vscode/mcp.json. ${preview.isNewFile ? 'Created new file.' : 'Updated existing file.'}`
        );
      } else {
        void vscode.window.showErrorMessage('Failed to write .vscode/mcp.json. Check the output log for details.');
      }
    })
  );

  function updateStatusBar(): void {
    const count = getSessionCount();
    const uri = getLastKnownUri() ?? getActiveUri();
    let portPart = '';
    if (uri) {
      try { portPart = ` :${new URL(uri).port}`; } catch { /* invalid uri */ }
    }
    if (count > 0) {
      statusBarItem.text = `$(debug-alt) Xdebug MCP (${count})${portPart}`;
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = `$(debug-disconnect) Xdebug MCP${portPart}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBarItem.tooltip = uri
      ? `Xdebug MCP Server — ${uri} (click to copy)`
      : 'Xdebug MCP Server (not running)';
    statusBarItem.show();
  }

  updateStatusBar();
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(() => updateStatusBar()),
    vscode.debug.onDidTerminateDebugSession(() => updateStatusBar()),
    vscode.debug.onDidChangeActiveDebugSession(() => updateStatusBar())
  );

  // Show fallback port notification once per session (if port 3098 was occupied).
  if (usedFallbackPort && mcpUri) {
    let port = '';
    try { port = new URL(mcpUri).port; } catch { /* invalid mcpUri */ }
    context.globalState.update('xdebug-mcp.fallbackPortShown', true);
    void vscode.window.showInformationMessage(
      `Xdebug MCP is using port ${port} (3098 was occupied). Use the status bar to find the URI.`
    );
  }

  // MCP provider tells VS Code (and agent clients) how to reach this server.
  const definitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(definitionsChanged);

  const provider = vscode.lm.registerMcpServerDefinitionProvider('xdebugMcpProvider', {
    onDidChangeMcpServerDefinitions: definitionsChanged.event,
    provideMcpServerDefinitions: async (): Promise<vscode.McpServerDefinition[]> => {
      try {
        // The HTTP server is reused; this just returns the definition.
        const httpUri = await startHttpServer({ version: serverVersion });
        return [
          // Typed constructor: (label, uri: Uri, headers?, version?). Passing
          // a single options object makes `label` the whole object, which VS
          // Code rejects with "Expected string, but got object".
          new vscode.McpHttpServerDefinition('xdebug-mcp', vscode.Uri.parse(httpUri), {}, serverVersion)
        ];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to start Xdebug MCP server: ${message}`);
        return [];
      }
    },
    resolveMcpServerDefinition: async (definition: vscode.McpServerDefinition) => definition
  });

  context.subscriptions.push(provider);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      // Ensure we stop the HTTP server and clean up the port file.
      void stopHttpServer();
    })
  );
}

// VS Code calls deactivate during window close/reload.
// stopHttpServer handles port file cleanup internally.
export function deactivate(): Thenable<void> | void {
  return stopHttpServer();
}
