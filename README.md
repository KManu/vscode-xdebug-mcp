# vscode-xdebug-mcp

Expose your active PHP/Xdebug session as an MCP server inside VS Code so agent clients (Codex) can inspect and control live debug sessions.
This mcp server is currently being designed to run with Codex. Copilot versions and a standalone server will come later. 

## What this extension does
- Runs a local HTTP MCP server inside the VS Code Extension Host. The server uses port `3098` by default, or a dynamically allocated port if `3098` is already in use (e.g., when multiple VS Code instances are running).
- Bridges MCP tool calls to the VS Code Debug Adapter Protocol (DAP) for your active PHP/Xdebug session.
- Provides tools to list sessions, inspect stack/variables, set breakpoints, and control execution.

> **Multiple VS Code instances:** The extension automatically handles port conflicts. If port `3098` is already bound, it falls back to an OS-assigned port. The actual URL is provided to MCP clients via the VS Code `McpHttpServerDefinition` API.

## How it works (high level)
1. **VS Code activates the extension** and starts the HTTP MCP server.
2. **MCP clients connect** to `/mcp` and issue JSON-RPC requests.
3. **The MCP server forwards requests** to a DAP bridge that talks to the active debug session.
4. **Results are returned** as MCP tool outputs with structured data for agents.

Key files:
- `src/extension.ts`: VS Code entrypoint, registers MCP definition provider, starts/stops server.
- `src/mcp/httpTransport.ts`: HTTP server + MCP transport (single `/mcp` endpoint).
- `src/mcp/server.ts`: MCP tools/resources exposed to clients.
- `src/debug/dapBridge.ts`: DAP bridge to the active debug session.

## Requirements
- VS Code compatible with the `engines.vscode` version in `package.json`
- A working PHP/Xdebug debug session (started via VS Code debugger)

## Path mappings
Xdebug breakpoints are bound using the server-side file path. Your `launch.json` must map that path to your local workspace so VS Code (and this MCP server) can resolve the same file.

Example (remote path to local workspace root):
```json
"pathMappings": {
  "/var/www/html/project": "${workspaceFolder}"
}
```

If your local project lives in a subfolder:
```json
"pathMappings": {
  "/var/www/html/project": "${workspaceFolder}/project"
}
```

## Xdebug config (Xdebug 3 example)
Ensure Xdebug is enabled and configured to connect to your debug host and port. A minimal setup:
```ini
xdebug.mode=debug
xdebug.start_with_request=yes
xdebug.client_host=127.0.0.1
xdebug.client_port=9003
```

Notes:
- If PHP runs inside Docker/WSL/VM, set `xdebug.client_host` to the host reachable from that environment (or use `xdebug.discover_client_host=1`).
- The port must match your `launch.json` `port` value.

## Running in development
1. `npm install`
2. `npm run watch` (keeps build output up to date)
3. Press **F5** to launch the Extension Development Host (EDH).
4. Start your PHP/Xdebug debug session in the EDH window.
5. The MCP server URL is provided by VS Code's MCP integration — no manual connection needed.

> Note: the MCP server runs **inside** the Extension Host. If your EDH is remote (WSL/SSH/Dev Container), the port is allocated dynamically and the URL is discoverable through the McpHttpServerDefinition.

## Usage in Vscode with Codex
1. Clone repo
2. Run `npm install`
3. Run `npm run vsce:package` to build the .vsix file.
4. In Vscode, navigate to the extensions tab, and click on the ellipsis at the top right corner and click 'Install from VSIX'
5. Select the generated file and install it.
6. Reload vscode
7. The MCP server is automatically discovered by VS Code's MCP integration. Open a codex chat window and verify the MCP servers are available (no manual URL configuration needed).
8. Start a PHP debug session in VS Code and set a breakpoint. Then ask the codex agent to access the call frame or variables in the execution scope.

> **Note:** The MCP server uses port `3098` by default, or a dynamic port if `3098` is already in use. VS Code's MCP integration handles the URL discovery automatically — manual configuration is only needed for external MCP clients connecting from outside VS Code. 


## MCP tools (overview)
Core inspection:
- `list_sessions` → list known debug sessions
- `status` → session state (stopped/running, threads)
- `threads`, `stack`, `scopes`, `variables` → inspect execution state
- `snapshot` → top frame + scopes + variables in one call
- `list_resource_templates` → list resource templates (e.g., `xdebug://variables/{frameId}`)

Execution control:
- `continue`, `pause`, `step_over`, `step_in`, `step_out`
- `restart`, `terminate`, `disconnect`

Breakpoints:
- `set_breakpoint`, `clear_breakpoints`
- `set_logpoint` (logMessage)
- `set_function_breakpoints`
- `set_exception_breakpoints`

Evaluation:
- `evaluate_expr` → evaluate an expression in a given frame
- `wait_for_stop` → poll until the debugger stops

Prompts:
- `xdebug_mcp_capabilities` → guided discovery of tools/resources and usage requirements

## Notes and limitations
- Xdebug does not support true reverse debugging (step back).
- Most tools default to the **active** debug session unless a `sessionId` is provided.
- Some DAP features are adapter-specific; availability depends on Xdebug and your debug adapter.
- Agent-set file breakpoints are registered through VS Code so they appear in the Breakpoints panel; provide workspace-relative or absolute local paths that match your `pathMappings`.
- `xdebug://stack` is a static MCP resource and will appear in `list_mcp_resources`. The variables resource is a template and is discoverable via `list_mcp_resource_templates` or the `list_resource_templates` tool.

## Troubleshooting
- **Breakpoints don’t bind**: verify `pathMappings` matches the server-side path, and that the debug session is actually stopped at the time you inspect variables/stack.
- **No MCP resources listed**: `xdebug://stack` is static and should appear in `list_mcp_resources`. Templates like `xdebug://variables/{frameId}` show up via `list_mcp_resource_templates` or the `list_resource_templates` tool.
- **Debug session never connects**: confirm Xdebug is enabled, `xdebug.mode=debug`, and `xdebug.client_host` points at your VS Code host (or enable `xdebug.discover_client_host=1` in container/remote setups).
- **Port mismatch**: ensure `xdebug.client_port` matches `launch.json` `port`.
- **Logpoints don’t log**: ensure your PHP debug adapter supports logpoints; if not, `logMessage` is ignored.

## Build/package
- `npm run check-types` — typecheck
- `npm run package` — bundle for production
- `npm run vsce:package` — build `.vsix`
