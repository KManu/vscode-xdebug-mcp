import * as vscode from 'vscode';
import { startHttpServer, stopHttpServer } from './mcp/httpTransport';
import { registerSessionTracking } from './debug/dapBridge';

// VS Code entrypoint. This runs inside the Extension Host process, not your app.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Track debug session lifecycle so MCP tools can target sessions explicitly.
  registerSessionTracking(context.subscriptions);
  // Use the extension version as the MCP server version for consistency.
  const serverVersion = String(context.extension.packageJSON.version ?? '0.0.1');

  try {
    // Start the HTTP MCP server early so agents can connect immediately.
    const uri = await startHttpServer({ version: serverVersion });
    console.log(`Vscode Xdebug MCP server listening at ${uri}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start Vscode Xdebug MCP server: ${message}`);
  }

  // MCP provider tells VS Code (and agent clients) how to reach this server.
  const definitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(definitionsChanged);

  const provider = (vscode.lm as any).registerMcpServerDefinitionProvider('xdebugMcpProvider', {
    onDidChangeMcpServerDefinitions: definitionsChanged.event,
    provideMcpServerDefinitions: async () => {
      try {
        // The HTTP server is reused; this just returns the definition.
        const uri = await startHttpServer({ version: serverVersion });
        return [
          new (vscode as any).McpHttpServerDefinition({
            label: 'xdebug-mcp',
            uri,
            version: serverVersion
          })
        ];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to start Xdebug MCP server: ${message}`);
        return [];
      }
    },
    resolveMcpServerDefinition: async (definition: unknown) => definition
  });

  context.subscriptions.push(provider);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      // Ensure we stop the HTTP server when the extension is deactivated/reloaded.
      void stopHttpServer();
    })
  );
}

// VS Code calls deactivate during window close/reload.
export function deactivate(): Thenable<void> | void {
  return stopHttpServer();
}
