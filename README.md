# vscode-xdebug-mcp

Expose your active PHP/Xdebug session as an MCP server inside VS Code so agent clients (Codex) can inspect and control live debug sessions.
This mcp server is currently being designed to run with Codex. Copilot versions and a standalone server will come later. 

## What this extension does
- Runs a local HTTP MCP server at `http://127.0.0.1:3098/mcp` inside the VS Code Extension Host.
- Bridges MCP tool calls to the VS Code Debug Adapter Protocol (DAP) for your active PHP/Xdebug session.
- Provides tools to list sessions, inspect stack/variables, set breakpoints, and control execution.

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

## Running in development
1. `npm install`
2. `npm run watch` (keeps build output up to date)
3. Press **F5** to launch the Extension Development Host (EDH).
4. Start your PHP/Xdebug debug session in the EDH window.
5. Connect an MCP client to `http://127.0.0.1:3098/mcp`.

> Note: the MCP server runs **inside** the Extension Host. If your EDH is remote (WSL/SSH/Dev Container), curl the endpoint from that environment or forward the port.

## Usage in Vscode with Codex
1. Clone repo
2. Run `npm install` 
3. Run `npm run vsce:package` to build the .vsix file. 
4. In Vscode, navigate to the extensions tab, and click on the ellipsis at the top right corner and click 'Install from VSIX'
5. Select the generated file and install it. 
6. In the codex config.toml file, add a section for the mcp server like below to register the mcp server
    ```toml
        [mcp_server.vscode_xdebug_mcp]
        url = "127.0.0.1:3098"
    ```
7. Reload vscode
8. Open a codex chat window and verify the running MCP servers. Alternatively, you can verify that it's running by curling the URL address. 
9. Start a php debug session in vscode and set a breakpoint. Then ask the codex agent to access the call frame or variables in the execution scope. 


## MCP tools (overview)
Core inspection:
- `list_sessions` → list known debug sessions
- `status` → session state (stopped/running, threads)
- `threads`, `stack`, `scopes`, `variables` → inspect execution state
- `snapshot` → top frame + scopes + variables in one call

Execution control:
- `continue`, `pause`, `step_over`, `step_in`, `step_out`
- `restart`, `terminate`, `disconnect`

Breakpoints:
- `set_breakpoint`, `clear_breakpoints`
- `set_function_breakpoints`
- `set_exception_breakpoints`

Evaluation:
- `evaluate_expr` → evaluate an expression in a given frame
- `wait_for_stop` → poll until the debugger stops

## Notes and limitations
- Xdebug does not support true reverse debugging (step back).
- Most tools default to the **active** debug session unless a `sessionId` is provided.
- Some DAP features are adapter-specific; availability depends on Xdebug and your debug adapter.

## Build/package
- `npm run check-types` — typecheck
- `npm run package` — bundle for production
- `npm run vsce:package` — build `.vsix`
