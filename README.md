# vscode-xdebug-mcp

Expose your active PHP/Xdebug session as an MCP server inside VS Code so agent clients can inspect and control live debug sessions.

## What this extension does
- Runs a local HTTP MCP server inside the VS Code Extension Host. The server uses port `3098` by default, or a dynamically allocated port if `3098` is already in use (e.g., when multiple VS Code instances are running).
- Bridges MCP tool calls to the VS Code Debug Adapter Protocol (DAP) for your active PHP/Xdebug session.
- Provides tools to list sessions, inspect stack/variables, set breakpoints, and control execution.

> **Multiple VS Code instances:** The extension automatically handles port conflicts. If port `3098` is already bound, it falls back to an OS-assigned port. The actual port is written to `~/.vscode-xdebug-mcp/port.json` and shown in the VS Code status bar.

## Connecting MCP clients

The extension makes the MCP server discoverable through multiple paths. The status bar displays the current port (`:3098` or fallback) — click it to copy the URI to clipboard.

### Automatic discovery

| Client | How it connects | Setup needed |
|--------|----------------|-------------|
| **VS Code Copilot / Agent Mode** | Uses `registerMcpServerDefinitionProvider` API | **None** — automatic |

### One-click setup

Run **`Xdebug MCP: Add to Workspace .vscode/mcp.json`** from the Command Palette to create or update your workspace's `.vscode/mcp.json` with the current server URL. This works for any MCP client that reads the standard `.mcp.json` / `.vscode/mcp.json` format:

| Client | Config file |
|--------|------------|
| **pi** (via pi-mcp-adapter) | `.mcp.json` or `~/.config/mcp/mcp.json` |
| **VS Code** | `.vscode/mcp.json` |
| **Codex** (when `mcp.json` support lands) | `.mcp.json` |

### Manual configuration (copy-paste)

Run **`Xdebug MCP: Copy MCP Client Config Snippet`** from the Command Palette to copy the appropriate config snippet for your client:

**Codex** (`~/.codex/config.toml` or `.codex/config.toml`):
```toml
[mcp_servers.xdebug]
url = "http://127.0.0.1:3098/mcp"
```

**Claude Code** (`~/.claude/settings.json` → `mcpServers`):
```json
"xdebug": {
  "type": "http",
  "url": "http://127.0.0.1:3098/mcp"
}
```

**Standard `.mcp.json`** (workspace or global):
```json
"xdebug": {
  "type": "http",
  "url": "http://127.0.0.1:3098/mcp"
}
```

### File-based discovery (external tools)

The extension writes the active MCP URI to `~/.vscode-xdebug-mcp/port.json`:

```json
{
  "uri": "http://127.0.0.1:3098/mcp",
  "host": "127.0.0.1",
  "port": 3098,
  "version": "0.1.0",
  "pid": 12345,
  "started": "2026-05-15T10:30:00.000Z"
}
```

External CLI tools and scripts can read this file to discover the active port. When the server stops, the file is marked `{"status": "stopped"}`.

> **Note on Codex:** Codex currently uses TOML config (`~/.codex/config.toml`) and does not automatically discover MCP servers from VS Code extensions. Use the `Copy MCP Client Config Snippet` command and paste into your Codex config.

## Commands

| Command | Description |
|---------|-------------|
| `Xdebug MCP: Copy Server URI to Clipboard` | Copies `http://127.0.0.1:{port}/mcp` to clipboard |
| `Xdebug MCP: Copy MCP Client Config Snippet` | Copies ready-to-paste config for Codex, Claude Code, or standard `.mcp.json` |
| `Xdebug MCP: Add to Workspace .vscode/mcp.json` | Creates/updates workspace `.vscode/mcp.json` with the current port (shows preview before writing) |
| `Xdebug MCP: Show Diagnostics` | Shows server version, MCP URI, and active session count |

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

## Installation
1. Clone repo
2. Run `npm install`
3. Run `npm run vsce:package` to build the `.vsix` file.
4. In VS Code, navigate to the extensions tab, click the ellipsis at the top right corner, and select **Install from VSIX**.
5. Select the generated `.vsix` file and install it.
6. Reload VS Code.
7. The MCP server starts automatically. For **VS Code Copilot/Agent Mode**, it's discovered automatically. For other clients, see [Connecting MCP clients](#connecting-mcp-clients) above.
8. Start a PHP debug session in VS Code and set a breakpoint. Ask your agent to inspect the call stack or variables.


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
