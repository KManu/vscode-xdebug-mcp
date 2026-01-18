import * as vscode from 'vscode';
import { startHttpServer, stopHttpServer } from './mcp/httpTransport';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    const uri = await startHttpServer();
    console.log(`Xdebug MCP server listening at ${uri}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start Xdebug MCP server: ${message}`);
  }

  const definitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(definitionsChanged);

  const provider = (vscode.lm as any).registerMcpServerDefinitionProvider('xdebugMcpProvider', {
    onDidChangeMcpServerDefinitions: definitionsChanged.event,
    provideMcpServerDefinitions: async () => {
      try {
        const uri = await startHttpServer();
        return [
          new (vscode as any).McpHttpServerDefinition({
            label: 'xdebug-mcp',
            uri,
            version: '1.0.0'
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
      void stopHttpServer();
    })
  );
}

export function deactivate(): Thenable<void> | void {
  return stopHttpServer();
}
