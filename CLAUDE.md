# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm install          # Install dependencies
npm run watch        # Watch mode for development (tsc --watch + esbuild --watch)
npm run check-types  # TypeScript type checking only
npm run compile      # Type check + esbuild bundle
npm run package     # Production build (check-types + esbuild)
npm run vsce:package # Build .vsix for VS Code extension distribution
```

## Architecture

This is a VS Code extension that exposes an MCP (Model Context Protocol) server for PHP/Xdebug debugging. The MCP server runs inside the VS Code Extension Host on a **dynamic port** (default `3098`, falls back to OS-assigned port on `EADDRINUSE` to support multiple VS Code instances).

### Data Flow

```
VS Code → extension.ts → MCP Server → DAP Bridge → Active Debug Session
```

### Key Files

- **src/extension.ts** — VS Code entry point; registers the MCP server definition provider and lifecycle management
- **src/mcp/httpTransport.ts** — HTTP server transport; handles single `/mcp` endpoint, enforces 2MB body limit, creates per-request MCP server instances. Uses port `3098` by default with fallback to dynamic port allocation on `EADDRINUSE`.
- **src/mcp/server.ts** — MCP tools/resources; maps MCP tool calls to DAP operations via the bridge
- **src/debug/dapBridge.ts** — DAP bridge; centralizes session selection, path resolution, and all Debug Adapter Protocol requests

### Session Management

The DAP bridge (`dapBridge.ts`) maintains a registry of debug sessions. Most tools default to the **active** debug session unless `sessionId` is provided. Path resolution in `resolveFileUri()` searches workspace folders in order, falling back to extension host cwd.

### MCP Resources

- `xdebug://stack` — Static resource: current call stack
- `xdebug://variables/{frameId}` — Resource template: variables for a frame (first scope)

### VS Code API Constraints

The `@types/vscode` package may not expose full debug session APIs. The extension uses `session.customRequest()` to send raw DAP commands directly to the debug adapter.

## Full Architecture Documentation

For deeper architecture details, component diagrams, patterns, and the complete MCP tools inventory:
→ **See [ARCHITECTURE.md](./ARCHITECTURE.md)**

### Pi Subagents (project-specific)

This repo includes 4 project-scoped pi subagents in `.pi/agents/`:
- **`xdebug-mcp.worker`** — Implementation agent; reads `ARCHITECTURE.md` automatically
- **`xdebug-mcp.reviewer`** — Specialized reviewer for extension correctness, MCP compliance, DAP patterns
- **`xdebug-mcp.tester`** — Test-focused agent; reads `ARCHITECTURE.md` + `PLAN.md` automatically
- **`xdebug-mcp.php-debug`** — PHP/Xdebug debugging specialist with deep Xdebug configuration and DAP knowledge

## Test Commands

```bash
npm run test         # vitest run (single pass, all 171+ tests)
npm run test:watch   # vitest watch (continuous)
npm run check-types  # TypeScript type checking (no emit)
```

## Path Mappings

Xdebug uses server-side file paths. The `launch.json` must include `pathMappings` to map remote paths to the local workspace so breakpoints resolve correctly. Example:
```json
"pathMappings": {
  "/var/www/html/project": "${workspaceFolder}"
}
```

See `ARCHITECTURE.md` for detailed path resolution logic, and the `xdebug-mcp.php-debug` subagent for comprehensive Xdebug configuration and troubleshooting guidance.
