// src/test/helpers/portResolver.ts
// Shared port resolution helper for integration tests.
// Polls the MCP server port file (~/.vscode-xdebug-mcp/port.json)
// until a live, running server is detected.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface PortInfo {
  port: number;
  host: string;
  uri: string;
  version: string;
  pid: number;
  started: string;
}

const PORT_FILE = path.join(os.homedir(), '.vscode-xdebug-mcp', 'port.json');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls the port file until the MCP server reports a live port with an alive PID.
 *
 * Handles:
 * - Missing file (server hasn't started yet) → retry
 * - status: 'stopped' (server shut down, may restart) → retry
 * - Dead PID (stale port file) → retry
 *
 * @param maxWaitMs     Maximum time to wait (default 10s).
 * @param pollIntervalMs Interval between polls (default 200ms).
 */
export async function getServerPort(maxWaitMs = 10000, pollIntervalMs = 200): Promise<PortInfo> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const raw = fs.readFileSync(PORT_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (parsed?.status === 'stopped') {
        await sleep(pollIntervalMs);
        continue;
      }

      if (parsed?.port && typeof parsed.port === 'number' && typeof parsed.host === 'string') {
        try {
          process.kill(parsed.pid as number, 0);
        } catch {
          // PID is dead, keep polling.
          await sleep(pollIntervalMs);
          continue;
        }
        return parsed as unknown as PortInfo;
      }
    } catch {
      // File doesn't exist yet.
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for port file after ${maxWaitMs}ms`);
}
