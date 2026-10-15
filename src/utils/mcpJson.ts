import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './logger';

/**
 * Read and parse a `.vscode/mcp.json` file from a workspace root.
 * Returns the parsed object, or null if the file doesn't exist or is invalid.
 */
export function readWorkspaceMcpJson(workspaceRoot: string): Record<string, unknown> | null {
  const mcpPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
  try {
    const raw = fs.readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.error(`${mcpPath} exists but is not a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // File doesn't exist — fine.
    }
    log.error(`Failed to read ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Add or update the xdebug MCP server entry in a workspace `.vscode/mcp.json`.
 * Returns the updated config object (does NOT write to disk).
 */
export function addXdebugToMcpJson(
  existing: Record<string, unknown> | null,
  uri: string
): { config: Record<string, unknown>; isNew: boolean } {
  const base = existing ?? {};
  const servers = (base.servers as Record<string, unknown>) ?? {};

  const isNew = !('xdebug' in servers);
  servers.xdebug = {
    type: 'http',
    url: uri,
  };

  return {
    config: { ...base, servers },
    isNew,
  };
}

/**
 * Preview the before/after of adding xdebug to workspace mcp.json.
 * Returns the formatted JSON strings for display.
 */
export function previewMcpJsonChange(
  workspaceRoot: string,
  uri: string
): { before: string; after: string; isNewFile: boolean } | { error: string } {
  const existing = readWorkspaceMcpJson(workspaceRoot);
  const before = existing !== null ? JSON.stringify(existing, null, 2) : '{}';
  const { config, isNew } = addXdebugToMcpJson(existing, uri);
  const after = JSON.stringify(config, null, 2);

  return {
    before: isNew && existing === null ? '(new file)' : before,
    after,
    isNewFile: existing === null,
  };
}

/**
 * Write the xdebug MCP server entry to the workspace `.vscode/mcp.json`.
 * Creates the `.vscode` directory and file if they don't exist.
 * Returns true on success, false on failure.
 */
export function writeWorkspaceMcpJson(workspaceRoot: string, uri: string): boolean {
  const existing = readWorkspaceMcpJson(workspaceRoot);
  const { config } = addXdebugToMcpJson(existing, uri);

  const vscodeDir = path.join(workspaceRoot, '.vscode');
  const mcpPath = path.join(vscodeDir, 'mcp.json');

  try {
    fs.mkdirSync(vscodeDir, { recursive: true });
    const json = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileSync(mcpPath, json, { encoding: 'utf8', mode: 0o644 });
    log.info(`Xdebug MCP server added to ${mcpPath}`);
    return true;
  } catch (error) {
    log.error(`Failed to write ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
